import { randomUUID } from 'node:crypto';
import { and, asc, eq, gte, inArray, lt, ne } from 'drizzle-orm';
import { getDb } from '../database/client.js';
import { aiSettings, appointments, availabilitySettings, businesses, leads, trainers } from '../database/schema.js';
import type { AppointmentOutcome, OfferedSlot } from '../lib/domain.js';
import { DEFAULT_AVAILABILITY } from '../config/defaults.js';
import { badRequest, conflict, errorMessage, notFound, unavailable } from '../lib/errors.js';
import { humanSlotLabel } from '../lib/time.js';
import { audit, logError } from '../audit/audit.service.js';
import { applyPipelineEvent, recordLeadEvent, setLeadStatus, type Actor } from '../crm/leads.service.js';
import { createAlert, resolveAlertsFor } from '../crm/alerts.service.js';
import { cancelAppointmentJobs, getAutomation, scheduleAppointmentJobs } from '../automation/reminders.js';
import { scheduleJob } from '../automation/jobs.js';
import { computeFreeSlots, pickOfferSlots, slotId, type AvailabilityConfig, type Interval, type PartOfDay, type Slot } from './availability.js';
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

async function internalBusy(businessId: string, range: { from: Date; to: Date }, excludeAppointmentId?: string): Promise<Interval[]> {
  const conds = [
    eq(appointments.businessId, businessId),
    inArray(appointments.status, ['scheduled']),
    lt(appointments.startsAt, range.to),
    gte(appointments.endsAt, range.from),
  ];
  if (excludeAppointmentId) conds.push(ne(appointments.id, excludeAppointmentId));
  const rows = await getDb()
    .select({ start: appointments.startsAt, end: appointments.endsAt })
    .from(appointments)
    .where(and(...conds));
  return rows.map((r) => ({ start: r.start, end: r.end }));
}

/**
 * Huecos libres reales del negocio. Si hay Calendly conectado, la fuente de verdad es Calendly;
 * si hay Google Calendar, se descuentan sus ocupaciones. Si el calendario externo falla, se lanza
 * un error en vez de ofrecer horarios que podrían estar ocupados.
 */
export async function getFreeSlots(
  businessId: string,
  range?: { from: Date; to: Date },
  opts: { excludeAppointmentId?: string } = {},
): Promise<{ slots: SlotWithUrl[]; config: AvailabilityConfig & { callDurationMinutes: number }; provider: 'internal' | 'google' | 'calendly' }> {
  const config = await getAvailabilityConfig(businessId);
  const from = range?.from ?? new Date();
  const to = range?.to ?? new Date(Date.now() + config.maxDaysAhead * 24 * 3600_000);
  const connection = await getCalendarConnection(businessId);

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

  const busy = await internalBusy(businessId, { from, to }, opts.excludeAppointmentId);
  if (connection?.provider === 'google') {
    try {
      const token = await googleAccessToken(connection);
      busy.push(...(await googleFreeBusy(token, connection.calendarId ?? 'primary', { from, to }, config.timezone)));
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
  lead: { id: string; name: string; email: string | null },
  opts: { date?: string; partOfDay?: PartOfDay; count?: number } = {},
): Promise<{ offered: OfferedSlot[]; timezone: string; provider: string }> {
  const { slots, config, provider } = await getFreeSlots(businessId);
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

/** Reserva una llamada verificando de nuevo que el hueco sigue libre (evita dobles reservas). */
export async function bookAppointment(input: BookInput): Promise<Appointment> {
  const db = getDb();
  const [lead] = await db
    .select()
    .from(leads)
    .where(and(eq(leads.businessId, input.businessId), eq(leads.id, input.leadId)))
    .limit(1);
  if (!lead) throw notFound('Lead no encontrado.');
  const connection = await getCalendarConnection(input.businessId);
  if (connection?.provider === 'calendly')
    throw badRequest('Con Calendly la reserva la confirma el propio lead desde el enlace; se registrará automáticamente.');

  const config = await getAvailabilityConfig(input.businessId);
  const end = new Date(input.start.getTime() + config.callDurationMinutes * 60_000);
  if (input.bookedBy === 'kai') {
    // KAI solo puede reservar huecos que salgan del cálculo de disponibilidad real.
    const { slots } = await getFreeSlots(input.businessId, { from: new Date(input.start.getTime() - 60_000), to: new Date(end.getTime() + 60_000) });
    if (!slots.some((s) => s.start.getTime() === input.start.getTime())) throw conflict('Ese horario ya no está disponible.');
  } else {
    const overlapping = await internalBusy(input.businessId, { from: input.start, to: end });
    if (overlapping.some((b) => b.start < end && input.start < b.end)) throw conflict('Ya hay una cita en ese horario.');
  }

  const [settings] = await db.select().from(aiSettings).where(eq(aiSettings.businessId, input.businessId)).limit(1);
  const [trainer] = await db.select().from(trainers).where(eq(trainers.businessId, input.businessId)).limit(1);
  const title = `${settings?.callLabel ? capitalize(settings.callLabel) : 'Llamada'} · ${lead.name || 'Lead'}`;

  let externalEventId: string | null = null;
  let meetingUrl: string | null = null;
  if (connection?.provider === 'google') {
    try {
      const token = await googleAccessToken(connection);
      const ev = await googleCreateEvent(token, connection.calendarId ?? 'primary', {
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
      externalEventId = ev.id;
      meetingUrl = ev.meetUrl;
    } catch (err) {
      await markCalendarError(connection.id, errorMessage(err));
      await logError('calendar.google.create_event', err, { leadId: lead.id }, input.businessId);
      throw unavailable('No se pudo crear el evento en Google Calendar.');
    }
  }

  const [appointment] = await db
    .insert(appointments)
    .values({
      businessId: input.businessId,
      leadId: lead.id,
      conversationId: input.conversationId ?? null,
      title,
      startsAt: input.start,
      endsAt: end,
      calendarProvider: connection?.provider ?? 'internal',
      calendarConnectionId: connection?.id ?? null,
      externalEventId,
      meetingUrl,
      bookedBy: input.bookedBy,
      confirmationSentAt: input.confirmationAlreadySent ? new Date() : null,
    })
    .returning();
  await afterBooked(input.businessId, appointment, input.actor, !input.confirmationAlreadySent);
  return appointment;
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
    .select({ appointment: appointments, lead: { id: leads.id, name: leads.name, status: leads.status, score: leads.score, temperature: leads.temperature, goalSummary: leads.goalSummary, source: leads.source } })
    .from(appointments)
    .innerJoin(leads, eq(leads.id, appointments.leadId))
    .where(and(eq(appointments.businessId, businessId), gte(appointments.startsAt, range.from), lt(appointments.startsAt, range.to)))
    .orderBy(asc(appointments.startsAt));
}

export async function cancelAppointment(businessId: string, id: string, actor: Actor, reason = '') {
  const appt = await getAppointment(businessId, id);
  if (appt.status !== 'scheduled') throw badRequest('Solo se pueden cancelar citas programadas.');
  if (appt.calendarProvider === 'google' && appt.externalEventId) {
    const conn = await getCalendarConnection(businessId, 'google');
    if (conn) {
      try {
        await googleDeleteEvent(await googleAccessToken(conn), conn.calendarId ?? 'primary', appt.externalEventId);
      } catch (err) {
        await logError('calendar.google.delete_event', err, { appointmentId: id }, businessId, 'warn');
      }
    }
  }
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

export async function rescheduleAppointment(businessId: string, id: string, newStart: Date, actor: Actor, bookedBy: 'kai' | 'human') {
  const appt = await getAppointment(businessId, id);
  if (appt.status !== 'scheduled') throw badRequest('Solo se pueden mover citas programadas.');
  // Comprobar el nuevo hueco ANTES de cancelar la cita actual.
  const config = await getAvailabilityConfig(businessId);
  const newEnd = new Date(newStart.getTime() + config.callDurationMinutes * 60_000);
  if (bookedBy === 'kai') {
    const { slots } = await getFreeSlots(
      businessId,
      { from: new Date(newStart.getTime() - 60_000), to: new Date(newEnd.getTime() + 60_000) },
      { excludeAppointmentId: id },
    );
    if (!slots.some((s) => s.start.getTime() === newStart.getTime())) throw conflict('Ese horario ya no está disponible.');
  } else {
    const overlapping = await internalBusy(businessId, { from: newStart, to: newEnd }, id);
    if (overlapping.some((b) => b.start < newEnd && newStart < b.end)) throw conflict('Ya hay una cita en ese horario.');
  }
  await cancelAppointment(businessId, id, actor, 'Reprogramada');
  await getDb().update(appointments).set({ status: 'rescheduled' }).where(eq(appointments.id, id));
  return bookAppointment({ businessId, leadId: appt.leadId, conversationId: appt.conversationId, start: newStart, bookedBy, actor, confirmationAlreadySent: bookedBy === 'kai' });
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
  const db = getDb();
  if (!input.attended) {
    await db.update(appointments).set({ status: 'no_show', outcome: null, outcomeNotes: input.notes ?? null, updatedAt: new Date() }).where(eq(appointments.id, id));
    await applyPipelineEvent(businessId, appt.leadId, 'no_show', actor);
    await recordLeadEvent(businessId, appt.leadId, 'no_show', actor, { appointmentId: id });
    const recovery = await getAutomation(businessId, 'no_show_recovery');
    if (recovery?.enabled) {
      await scheduleJob({
        businessId,
        type: 'no_show_message',
        runAt: new Date(Date.now() + (recovery.config.delayMinutes ?? 15) * 60_000),
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
