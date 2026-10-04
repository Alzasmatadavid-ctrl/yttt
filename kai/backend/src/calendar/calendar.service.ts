import { randomUUID } from 'node:crypto';
import { and, asc, eq, gt, gte, inArray, lt, ne, sql } from 'drizzle-orm';
import { getDb } from '../database/client.js';
import { aiSettings, appointments, availabilitySettings, businesses, conversations, leads, trainers } from '../database/schema.js';
import type { AppointmentOutcome, OfferedSlot } from '../lib/domain.js';
import { DEFAULT_AVAILABILITY } from '../config/defaults.js';
import { badRequest, conflict, errorMessage, notFound, unavailable } from '../lib/errors.js';
import { humanSlotLabel, shiftOutOfQuietHours } from '../lib/time.js';
import { audit, logError } from '../audit/audit.service.js';
import { applyPipelineEvent, recordLeadEvent, setLeadStatus, type Actor } from '../crm/leads.service.js';
import { createAlert, resolveAlertsFor } from '../crm/alerts.service.js';
import { cancelAppointmentJobs, getAutomation, scheduleAppointmentJobs } from '../automation/reminders.js';
import { scheduleJob } from '../automation/jobs.js';
import { clampSlotRange, computeFreeSlots, pickOfferSlots, slotId, type AvailabilityConfig, type Interval, type PartOfDay, type Slot } from './availability.js';
import { getCalendarConnection, googleAccessToken, markCalendarError, type CalendlyCredentials } from './connections.js';
import { googleCreateEvent, googleDeleteEvent, googleFreeBusy } from './providers/google.js';
import { calendlyAvailableTimes, calendlyPrefilledUrl } from './providers/calendly.js';
import { decryptJson } from '../lib/crypto.js';

export type Appointment = typeof appointments.$inferSelect;
export type SlotWithUrl = Slot & { url?: string };

export async function getAvailabilityConfig(businessId: string): Promise<AvailabilityConfig & { callDurationMinutes: number }> {
  const db = getDb();
  const [[biz], [avail], [settings]] = await Promise.all([
    db.select({ timezone: businesses.timezone }).from(businesses).where(eq(businesses.id, businessId)).limit(1),
    db.select().from(availabilitySettings).where(eq(availabilitySettings.businessId, businessId)).limit(1),
    db.select({ d: aiSettings.callDurationMinutes }).from(aiSettings).where(eq(aiSettings.businessId, businessId)).limit(1),
  ]);
  if (!biz) throw notFound('Negocio no encontrado.');
  return {
    timezone: biz.timezone,
    weekly: avail?.weekly ?? DEFAULT_AVAILABILITY,
    slotMinutes: avail?.slotMinutes ?? 30,
    bufferMinutes: avail?.bufferMinutes ?? 10,
    minNoticeMinutes: avail?.minNoticeMinutes ?? 120,
    maxDaysAhead: avail?.maxDaysAhead ?? 14,
    blackoutDates: avail?.blackoutDates ?? [],
    callDurationMinutes: settings?.d ?? 30,
  };
}

/**
 * Citas que ocupan agenda en un rango.
 * Las citas de leads de prueba (simulador) solo cuentan si `includeTestLeads`: así una prueba olvidada
 * no le quita huecos a los leads reales.
 */
async function internalBusy(
  businessId: string,
  range: { from: Date; to: Date },
  opts: { excludeAppointmentId?: string; includeTestLeads?: boolean } = {},
): Promise<Interval[]> {
  const conds = [
    eq(appointments.businessId, businessId),
    inArray(appointments.status, ['scheduled']),
    lt(appointments.startsAt, range.to),
    gte(appointments.endsAt, range.from),
  ];
  if (opts.excludeAppointmentId) conds.push(ne(appointments.id, opts.excludeAppointmentId));
  if (opts.includeTestLeads === false) conds.push(eq(leads.isTest, false));
  const rows = await getDb()
    .select({ start: appointments.startsAt, end: appointments.endsAt })
    .from(appointments)
    .innerJoin(leads, and(eq(leads.id, appointments.leadId), eq(leads.businessId, appointments.businessId)))
    .where(and(...conds));
  return rows.map((r) => ({ start: r.start, end: r.end }));
}

/**
 * Huecos libres reales del negocio. Si hay Calendly conectado, la fuente de verdad es Calendly;
 * si hay Google Calendar, se descuentan sus ocupaciones. Si el calendario externo falla, se lanza
 * un error en vez de ofrecer horarios que podrían estar ocupados.
 *
 * `includeTestLeads` (por defecto, sí): si las citas del simulador ocupan hueco. Para un lead real se pasa
 * false; para un lead de prueba, true (el simulador ve la agenda completa).
 *
 * El rango pedido se recorta SIEMPRE a [ahora, ahora + días de antelación máxima] antes de consultar nada:
 * fuera de ahí no se puede reservar, y un rango enorme supondría cientos de consultas seguidas a Calendly
 * (una por semana) que bloquearían el servidor y gastarían el cupo de la API del entrenador.
 */
export async function getFreeSlots(
  businessId: string,
  range?: { from: Date; to: Date },
  opts: { excludeAppointmentId?: string; includeTestLeads?: boolean } = {},
): Promise<{ slots: SlotWithUrl[]; config: AvailabilityConfig & { callDurationMinutes: number }; provider: 'internal' | 'google' | 'calendly' }> {
  const config = await getAvailabilityConfig(businessId);
  const { from, to } = clampSlotRange(range, config.maxDaysAhead);
  const connection = await getCalendarConnection(businessId);
  if (from >= to) return { slots: [], config, provider: connection?.provider ?? 'internal' };

  if (connection?.provider === 'calendly') {
    try {
      const creds = decryptJson<CalendlyCredentials>(connection.credentialsEnc);
      if (!connection.calendarId) throw new Error('Selecciona el tipo de evento de Calendly en Integraciones.');
      const times = await calendlyAvailableTimes(creds.token, connection.calendarId, { from, to }, config.callDurationMinutes);
      const minStart = Date.now() + config.minNoticeMinutes * 60_000;
      const slots = times.filter((t) => t.start.getTime() >= minStart).map((t) => ({ id: slotId(t.start), start: t.start, end: t.end, url: t.url }));
      return { slots, config, provider: 'calendly' };
    } catch (err) {
      await markCalendarError(connection.id, errorMessage(err));
      await logError('calendar.calendly.availability', err, {}, businessId);
      throw unavailable('No se pudo consultar la disponibilidad en Calendly.');
    }
  }

  // Las ocupaciones se piden con margen (descanso entre llamadas + duración del último hueco): una cita que
  // acaba justo antes de `from` o empieza justo después de `to` también puede chocar con un hueco del rango.
  const busyRange = {
    from: new Date(from.getTime() - config.bufferMinutes * 60_000),
    to: new Date(to.getTime() + (config.callDurationMinutes + config.bufferMinutes) * 60_000),
  };
  const busy = await internalBusy(businessId, busyRange, { excludeAppointmentId: opts.excludeAppointmentId, includeTestLeads: opts.includeTestLeads ?? true });
  if (connection?.provider === 'google') {
    try {
      const token = await googleAccessToken(connection);
      busy.push(...(await googleFreeBusy(token, connection.calendarId ?? 'primary', busyRange, config.timezone)));
    } catch (err) {
      await markCalendarError(connection.id, errorMessage(err));
      await logError('calendar.google.freebusy', err, {}, businessId);
      throw unavailable('No se pudo consultar Google Calendar.');
    }
  }
  const slots = computeFreeSlots(config, busy, { from, to }, config.callDurationMinutes);
  return { slots, config, provider: connection?.provider ?? 'internal' };
}

/** Huecos para ofrecer al lead (2–3 opciones), ya etiquetados en su idioma y zona horaria. */
export async function getOfferableSlots(
  businessId: string,
  lead: { id: string; name: string; email: string | null; isTest?: boolean },
  opts: { date?: string; partOfDay?: PartOfDay; count?: number } = {},
): Promise<{ offered: OfferedSlot[]; timezone: string; provider: string }> {
  const { slots, config, provider } = await getFreeSlots(businessId, undefined, { includeTestLeads: Boolean(lead.isTest) });
  const picked = pickOfferSlots(slots, config.timezone, opts) as SlotWithUrl[];
  const offered = picked.map((s) => ({
    id: s.id,
    start: s.start.toISOString(),
    end: s.end.toISOString(),
    label: humanSlotLabel(s.start, config.timezone),
    ...(s.url ? { bookingUrl: calendlyPrefilledUrl(s.url, { name: lead.name, email: lead.email, leadId: lead.id }) } : {}),
  }));
  return { offered, timezone: config.timezone, provider };
}

export interface BookInput {
  businessId: string;
  leadId: string;
  conversationId?: string | null;
  start: Date;
  bookedBy: 'kai' | 'human';
  actor: Actor;
  /** Si KAI ya confirma la cita en su respuesta, no se envía una confirmación aparte. */
  confirmationAlreadySent?: boolean;
}

type NewAppointment = typeof appointments.$inferInsert;

/**
 * Guarda la cita reservando el hueco de forma ATÓMICA: la comprobación de solapes y el alta van en una
 * transacción con un bloqueo por negocio, así dos reservas simultáneas (KAI y el entrenador, dos procesos
 * del worker, un reintento…) nunca acaban en la misma franja. Todo lo de dentro usa `tx`.
 */
async function insertAppointmentAtomically(
  values: NewAppointment & { startsAt: Date; endsAt: Date },
  opts: { bufferMinutes: number; excludeAppointmentId?: string; includeTestLeads: boolean; conflictMessage: string },
): Promise<Appointment> {
  return getDb().transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`kai:appointments:${values.businessId}`}))`);
    const from = new Date(values.startsAt.getTime() - opts.bufferMinutes * 60_000);
    const to = new Date(values.endsAt.getTime() + opts.bufferMinutes * 60_000);
    const conds = [eq(appointments.businessId, values.businessId), eq(appointments.status, 'scheduled'), lt(appointments.startsAt, to), gt(appointments.endsAt, from)];
    if (opts.excludeAppointmentId) conds.push(ne(appointments.id, opts.excludeAppointmentId));
    if (!opts.includeTestLeads) conds.push(eq(leads.isTest, false));
    const [clash] = await tx
      .select({ id: appointments.id })
      .from(appointments)
      .innerJoin(leads, and(eq(leads.id, appointments.leadId), eq(leads.businessId, appointments.businessId)))
      .where(and(...conds))
      .limit(1);
    if (clash) throw conflict(opts.conflictMessage);
    const [row] = await tx.insert(appointments).values(values).returning();
    return row;
  });
}

/** Lead dueño de una conversación del negocio (null si no existe en este negocio). */
async function conversationLeadId(businessId: string, conversationId: string): Promise<string | null> {
  const [conv] = await getDb()
    .select({ leadId: conversations.leadId })
    .from(conversations)
    .where(and(eq(conversations.businessId, businessId), eq(conversations.id, conversationId)))
    .limit(1);
  return conv?.leadId ?? null;
}

/** La conversación indicada tiene que ser del mismo negocio y del mismo lead (si no, la confirmación le llegaría a otra persona). */
async function assertConversationOfLead(businessId: string, leadId: string, conversationId: string) {
  const owner = await conversationLeadId(businessId, conversationId);
  if (!owner) throw notFound('Conversación no encontrada.');
  if (owner !== leadId) throw badRequest('Esa conversación es de otro lead.');
}

/** Reserva una llamada verificando de nuevo que el hueco sigue libre (evita dobles reservas). */
export async function bookAppointment(input: BookInput): Promise<Appointment> {
  const { appointment, sendConfirmation } = await createAppointment(input);
  await afterBooked(input.businessId, appointment, input.actor, sendConfirmation);
  return appointment;
}

/**
 * Crea la cita (y su evento en Google Calendar) sin los pasos posteriores.
 * Si Google falla, la cita no se queda a medias: se borra y se lanza el error.
 */
async function createAppointment(input: BookInput & { excludeAppointmentId?: string }): Promise<{ appointment: Appointment; sendConfirmation: boolean }> {
  const db = getDb();
  const [lead] = await db
    .select()
    .from(leads)
    .where(and(eq(leads.businessId, input.businessId), eq(leads.id, input.leadId)))
    .limit(1);
  if (!lead) throw notFound('Lead no encontrado.');
  if (input.conversationId) await assertConversationOfLead(input.businessId, lead.id, input.conversationId);
  const connection = await getCalendarConnection(input.businessId);
  if (connection?.provider === 'calendly')
    throw badRequest('Con Calendly la reserva la confirma el propio lead desde el enlace; se registrará automáticamente.');

  const config = await getAvailabilityConfig(input.businessId);
  const end = new Date(input.start.getTime() + config.callDurationMinutes * 60_000);
  // Las citas de prueba (simulador) no ocupan agenda para los leads reales.
  const includeTestLeads = lead.isTest;
  if (input.bookedBy === 'kai') {
    // KAI solo puede reservar huecos que salgan del cálculo de disponibilidad real.
    const { slots } = await getFreeSlots(
      input.businessId,
      { from: new Date(input.start.getTime() - 60_000), to: new Date(end.getTime() + 60_000) },
      { excludeAppointmentId: input.excludeAppointmentId, includeTestLeads },
    );
    if (!slots.some((s) => s.start.getTime() === input.start.getTime())) throw conflict('Ese horario ya no está disponible.');
  } else {
    const overlapping = await internalBusy(input.businessId, { from: input.start, to: end }, { excludeAppointmentId: input.excludeAppointmentId, includeTestLeads });
    if (overlapping.some((b) => b.start < end && input.start < b.end)) throw conflict('Ya hay una cita en ese horario.');
  }

  const [settings] = await db.select().from(aiSettings).where(eq(aiSettings.businessId, input.businessId)).limit(1);
  const [trainer] = await db.select().from(trainers).where(eq(trainers.businessId, input.businessId)).limit(1);
  const title = `${settings?.callLabel ? capitalize(settings.callLabel) : 'Llamada'} · ${lead.name || 'Lead'}`;
  // Las pruebas del simulador no tocan el calendario real del entrenador (ni invitan a nadie por email).
  const google = connection?.provider === 'google' && !lead.isTest ? connection : null;

  const appointment = await insertAppointmentAtomically(
    {
      businessId: input.businessId,
      leadId: lead.id,
      conversationId: input.conversationId ?? null,
      title,
      startsAt: input.start,
      endsAt: end,
      calendarProvider: google ? 'google' : 'internal',
      calendarConnectionId: google?.id ?? null,
      bookedBy: input.bookedBy,
      confirmationSentAt: input.confirmationAlreadySent ? new Date() : null,
    },
    {
      bufferMinutes: input.bookedBy === 'kai' ? config.bufferMinutes : 0,
      excludeAppointmentId: input.excludeAppointmentId,
      includeTestLeads,
      conflictMessage: input.bookedBy === 'kai' ? 'Ese horario ya no está disponible.' : 'Ya hay una cita en ese horario.',
    },
  );

  if (!google) return { appointment, sendConfirmation: !input.confirmationAlreadySent };
  let token: string | null = null;
  let ev: Awaited<ReturnType<typeof googleCreateEvent>> | null = null;
  try {
    token = await googleAccessToken(google);
    ev = await googleCreateEvent(token, google.calendarId ?? 'primary', {
      summary: title,
      description: [
        `Reservada por ${input.bookedBy === 'kai' ? 'KAI' : 'el equipo'} para ${trainer?.displayName || 'el entrenador'}.`,
        lead.goalSummary ? `Objetivo: ${lead.goalSummary}` : '',
        lead.phone ? `Teléfono: ${lead.phone}` : '',
        lead.instagramUsername ? `Instagram: @${lead.instagramUsername}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
      start: input.start,
      end,
      timezone: config.timezone,
      attendeeEmail: lead.email,
      requestId: randomUUID(),
    });
    const [updated] = await db
      .update(appointments)
      .set({ externalEventId: ev.id, meetingUrl: ev.meetUrl, updatedAt: new Date() })
      .where(eq(appointments.id, appointment.id))
      .returning();
    return { appointment: updated ?? appointment, sendConfirmation: !input.confirmationAlreadySent };
  } catch (err) {
    // Sin evento en Google la cita no vale: se deshace (también el evento, si llegó a crearse) para no dejar nada a medias.
    if (token && ev) {
      await googleDeleteEvent(token, google.calendarId ?? 'primary', ev.id).catch((e) =>
        logError('calendar.google.delete_event', e, { appointmentId: appointment.id }, input.businessId, 'warn'),
      );
    }
    await db.delete(appointments).where(eq(appointments.id, appointment.id));
    await markCalendarError(google.id, errorMessage(err));
    await logError('calendar.google.create_event', err, { leadId: lead.id }, input.businessId);
    throw unavailable('No se pudo crear el evento en Google Calendar.');
  }
}

/** Pasos comunes tras registrar una cita (también para las que llegan por webhook de Calendly). */
export async function afterBooked(businessId: string, appointment: Appointment, actor: Actor, sendConfirmation: boolean) {
  await applyPipelineEvent(businessId, appointment.leadId, 'call_booked', actor);
  await recordLeadEvent(businessId, appointment.leadId, 'call_booked', actor, { appointmentId: appointment.id, startsAt: appointment.startsAt.toISOString() });
  await scheduleAppointmentJobs(businessId, appointment, { sendConfirmation });
  await audit({
    businessId,
    actorType: actor.type === 'lead' ? 'integration' : actor.type,
    actorUserId: actor.userId,
    action: 'appointment.booked',
    entityType: 'appointment',
    entityId: appointment.id,
    metadata: { startsAt: appointment.startsAt.toISOString(), provider: appointment.calendarProvider },
  });
}

export async function getAppointment(businessId: string, id: string): Promise<Appointment> {
  const [row] = await getDb()
    .select()
    .from(appointments)
    .where(and(eq(appointments.businessId, businessId), eq(appointments.id, id)))
    .limit(1);
  if (!row) throw notFound('Cita no encontrada.');
  return row;
}

export async function listAppointments(businessId: string, range: { from: Date; to: Date }) {
  return getDb()
    .select({
      appointment: appointments,
      // isTest: citas del simulador (la interfaz las marca como prueba y no pide registrar su resultado).
      lead: { id: leads.id, name: leads.name, status: leads.status, score: leads.score, temperature: leads.temperature, goalSummary: leads.goalSummary, source: leads.source, isTest: leads.isTest },
    })
    .from(appointments)
    .innerJoin(leads, and(eq(leads.id, appointments.leadId), eq(leads.businessId, appointments.businessId)))
    .where(and(eq(appointments.businessId, businessId), gte(appointments.startsAt, range.from), lt(appointments.startsAt, range.to)))
    .orderBy(asc(appointments.startsAt));
}

/** Borra el evento de Google Calendar de una cita (si lo tiene). Un fallo se registra pero no bloquea. */
async function deleteExternalEvent(businessId: string, appt: Appointment) {
  if (appt.calendarProvider !== 'google' || !appt.externalEventId) return;
  const conn = await getCalendarConnection(businessId, 'google');
  if (!conn) return;
  try {
    await googleDeleteEvent(await googleAccessToken(conn), conn.calendarId ?? 'primary', appt.externalEventId);
  } catch (err) {
    await logError('calendar.google.delete_event', err, { appointmentId: appt.id }, businessId, 'warn');
  }
}

export async function cancelAppointment(businessId: string, id: string, actor: Actor, reason = '') {
  const appt = await getAppointment(businessId, id);
  if (appt.status !== 'scheduled') throw badRequest('Solo se pueden cancelar citas programadas.');
  await deleteExternalEvent(businessId, appt);
  const [row] = await getDb()
    .update(appointments)
    .set({ status: 'cancelled', outcomeNotes: reason || appt.outcomeNotes, updatedAt: new Date() })
    .where(eq(appointments.id, id))
    .returning();
  await cancelAppointmentJobs(id);
  await applyPipelineEvent(businessId, appt.leadId, 'appointment_cancelled', actor);
  await recordLeadEvent(businessId, appt.leadId, 'call_cancelled', actor, { appointmentId: id, reason });
  await audit({ businessId, actorType: actor.type === 'lead' ? 'integration' : actor.type, actorUserId: actor.userId, action: 'appointment.cancelled', entityType: 'appointment', entityId: id });
  return row;
}

/**
 * Mueve una cita a otro horario. Primero se crea la cita nueva (con su evento en Google) y SOLO si sale bien
 * se retira la antigua: si la reserva falla (hueco ocupado por una carrera, Google caído…), el lead conserva
 * su cita original intacta.
 */
export async function rescheduleAppointment(businessId: string, id: string, newStart: Date, actor: Actor, bookedBy: 'kai' | 'human') {
  const appt = await getAppointment(businessId, id);
  if (appt.status !== 'scheduled') throw badRequest('Solo se pueden mover citas programadas.');
  // Una cita antigua mal enlazada a la conversación de otro lead no debe impedir moverla.
  const conversationId = appt.conversationId && (await conversationLeadId(businessId, appt.conversationId)) === appt.leadId ? appt.conversationId : null;
  const { appointment: created, sendConfirmation } = await createAppointment({
    businessId,
    leadId: appt.leadId,
    conversationId,
    start: newStart,
    bookedBy,
    actor,
    confirmationAlreadySent: bookedBy === 'kai',
    excludeAppointmentId: id,
  });

  // Retirar la cita antigua sin pasar por “cancelada” (el lead sigue con llamada agendada).
  const [retired] = await getDb()
    .update(appointments)
    .set({ status: 'rescheduled', outcomeNotes: 'Reprogramada', updatedAt: new Date() })
    .where(and(eq(appointments.id, id), eq(appointments.status, 'scheduled')))
    .returning();
  if (!retired) {
    // Alguien la canceló o la movió mientras tanto: se deshace la nueva para no duplicar.
    await deleteExternalEvent(businessId, created);
    await getDb().delete(appointments).where(eq(appointments.id, created.id));
    throw conflict('La cita ha cambiado mientras la movías. Actualiza la agenda y vuelve a intentarlo.');
  }
  await cancelAppointmentJobs(id);
  await deleteExternalEvent(businessId, appt);
  await recordLeadEvent(businessId, appt.leadId, 'call_cancelled', actor, { appointmentId: id, reason: 'Reprogramada', rescheduledTo: created.id });
  await audit({
    businessId,
    actorType: actor.type === 'lead' ? 'integration' : actor.type,
    actorUserId: actor.userId,
    action: 'appointment.rescheduled',
    entityType: 'appointment',
    entityId: id,
    metadata: { from: appt.startsAt.toISOString(), to: created.startsAt.toISOString(), newAppointmentId: created.id },
  });
  await afterBooked(businessId, created, actor, sendConfirmation);
  return created;
}

/**
 * Antes de borrar un lead (o una prueba del simulador): retira sus citas programadas del calendario externo
 * y cancela sus recordatorios. Las filas se borran después en cascada con el lead.
 */
export async function releaseLeadAppointments(businessId: string, leadId: string) {
  const rows = await getDb()
    .select()
    .from(appointments)
    .where(and(eq(appointments.businessId, businessId), eq(appointments.leadId, leadId), eq(appointments.status, 'scheduled')));
  for (const appt of rows) {
    await deleteExternalEvent(businessId, appt);
    await cancelAppointmentJobs(appt.id);
  }
  return rows.length;
}

/** El entrenador registra el resultado de la llamada. */
export async function setAppointmentOutcome(
  businessId: string,
  id: string,
  input: { attended: boolean; outcome?: AppointmentOutcome; notes?: string; dealValueCents?: number | null },
  actor: Actor,
) {
  const appt = await getAppointment(businessId, id);
  if (appt.status === 'cancelled' || appt.status === 'rescheduled') throw badRequest('Esta cita fue cancelada o reprogramada.');
  // Antes de la hora no hay resultado que registrar: marcar un “no se presentó” por error enviaría al lead
  // el mensaje de no-show de una llamada que todavía no ha ocurrido (y lo sacaría de “llamada agendada”).
  if (appt.startsAt.getTime() > Date.now()) {
    throw badRequest('La llamada todavía no ha empezado: podrás registrar el resultado a partir de la hora de inicio.');
  }
  const db = getDb();
  if (!input.attended) {
    await db.update(appointments).set({ status: 'no_show', outcome: null, outcomeNotes: input.notes ?? null, updatedAt: new Date() }).where(eq(appointments.id, id));
    await applyPipelineEvent(businessId, appt.leadId, 'no_show', actor);
    await recordLeadEvent(businessId, appt.leadId, 'no_show', actor, { appointmentId: id });
    const recovery = await getAutomation(businessId, 'no_show_recovery');
    if (recovery?.enabled) {
      const { timezone } = await getAvailabilityConfig(businessId);
      // Respeta el horario de silencio: un no-show marcado a las 23:00 se escribe por la mañana.
      const runAt = shiftOutOfQuietHours(new Date(Date.now() + (recovery.config.delayMinutes ?? 15) * 60_000), timezone, recovery.config.quietHours);
      await scheduleJob({
        businessId,
        type: 'no_show_message',
        runAt,
        payload: { appointmentId: id, leadId: appt.leadId },
        dedupeKey: `appt:${id}:noshow`,
      });
    }
  } else {
    if (!input.outcome) throw badRequest('Indica el resultado de la llamada.');
    await db
      .update(appointments)
      .set({ status: 'completed', outcome: input.outcome, outcomeNotes: input.notes ?? null, updatedAt: new Date() })
      .where(eq(appointments.id, id));
    if (input.outcome === 'won') await setLeadStatus(businessId, appt.leadId, 'client', actor, { dealValueCents: input.dealValueCents ?? null, reason: 'call_won' });
    else if (input.outcome === 'lost') await setLeadStatus(businessId, appt.leadId, 'lost', actor, { reason: input.notes || 'No cerró en la llamada' });
    else await applyPipelineEvent(businessId, appt.leadId, 'call_follow_up', actor);
    await recordLeadEvent(businessId, appt.leadId, 'call_completed', actor, { appointmentId: id, outcome: input.outcome });
  }
  await resolveAlertsFor(businessId, { appointmentId: id, type: 'call_outcome' });
  await audit({ businessId, actorType: 'user', actorUserId: actor.userId, action: 'appointment.outcome', entityType: 'appointment', entityId: id, metadata: input });
  return getAppointment(businessId, id);
}

export async function requestOutcomeAlert(businessId: string, appointment: Appointment, leadName: string) {
  if (appointment.status !== 'scheduled') return;
  await createAlert({
    businessId,
    type: 'call_outcome',
    severity: 'info',
    title: 'Registra el resultado de la llamada',
    body: `¿Cómo fue la llamada con ${leadName || 'el lead'}? Marca si asistió y el resultado.`,
    leadId: appointment.leadId,
    appointmentId: appointment.id,
  });
}

function capitalize(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
