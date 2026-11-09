/**
 * Webhook de Calendly: registra en KAI las citas que el lead confirma desde el enlace.
 * URL (se crea automáticamente al conectar Calendly): {API_URL}/api/webhooks/calendly/{businessId}
 */
import { and, desc, eq } from 'drizzle-orm';
import { getDb } from '../database/client.js';
import { appointments, calendarConnections, conversations, leads } from '../database/schema.js';
import { decryptJson } from '../lib/crypto.js';
import { getCalendarConnection, type CalendarConnection, type CalendlyCredentials } from '../calendar/connections.js';
import { verifyCalendlySignature } from '../calendar/providers/calendly.js';
import { afterBooked } from '../calendar/calendar.service.js';
import { applyPipelineEvent, createLead, recordLeadEvent } from '../crm/leads.service.js';
import { updateConversationState } from '../crm/conversations.service.js';
import { cancelAppointmentJobs } from '../automation/reminders.js';
import { aiSettings } from '../database/schema.js';

interface CalendlyPayload {
  event: 'invitee.created' | 'invitee.canceled' | string;
  payload: {
    uri: string;
    email?: string;
    name?: string;
    rescheduled?: boolean;
    tracking?: { utm_content?: string | null; utm_source?: string | null };
    /** `event_type`: URI del tipo de evento reservado (el webhook avisa de TODOS los tipos de evento del entrenador). */
    scheduled_event?: { uri: string; name?: string; event_type?: string; start_time: string; end_time: string; location?: { join_url?: string | null } };
  };
}

export async function verifyCalendlyRequest(businessId: string, rawBody: string | undefined, signature: string | undefined) {
  const conn = await getCalendarConnection(businessId, 'calendly');
  if (!conn) return null;
  const creds = decryptJson<CalendlyCredentials>(conn.credentialsEnc);
  if (!creds.signingKey || !verifyCalendlySignature(rawBody, signature, creds.signingKey)) return null;
  return conn;
}

export async function handleCalendlyEvent(businessId: string, connectionId: string, body: CalendlyPayload) {
  const db = getDb();
  const ev = body.payload?.scheduled_event;
  if (!ev) return { ignored: true };

  if (body.event === 'invitee.canceled') {
    const [appt] = await db
      .select()
      .from(appointments)
      .where(and(eq(appointments.businessId, businessId), eq(appointments.calendarProvider, 'calendly'), eq(appointments.externalEventId, ev.uri)))
      .limit(1);
    if (!appt || appt.status !== 'scheduled') return { ignored: true };
    await db
      .update(appointments)
      .set({ status: body.payload.rescheduled ? 'rescheduled' : 'cancelled', updatedAt: new Date() })
      .where(eq(appointments.id, appt.id));
    await cancelAppointmentJobs(appt.id);
    if (!body.payload.rescheduled) await applyPipelineEvent(businessId, appt.leadId, 'appointment_cancelled', { type: 'integration' });
    await recordLeadEvent(businessId, appt.leadId, 'call_cancelled', { type: 'integration' }, { provider: 'calendly', rescheduled: Boolean(body.payload.rescheduled) });
    return { cancelled: true };
  }

  if (body.event !== 'invitee.created') return { ignored: true };
  // El webhook es de toda la cuenta: también llegan las sesiones, consultas o clases que el entrenador tenga en
  // Calendly. Solo se registra la llamada (el tipo de evento elegido en Integraciones) o lo reservado desde un
  // enlace de KAI (p. ej. si el entrenador cambió después el tipo de evento). Lo demás no es asunto de KAI: ni
  // crea leads, ni mueve el pipeline, ni manda confirmaciones ni recordatorios.
  const [connection] = await db.select().from(calendarConnections).where(and(eq(calendarConnections.businessId, businessId), eq(calendarConnections.id, connectionId))).limit(1);
  if (!isKaiCallBooking(connection, ev.event_type, body.payload.tracking?.utm_source)) return { ignored: true, reason: 'other_event_type' };
  const [exists] = await db
    .select({ id: appointments.id })
    .from(appointments)
    .where(and(eq(appointments.businessId, businessId), eq(appointments.calendarProvider, 'calendly'), eq(appointments.externalEventId, ev.uri)))
    .limit(1);
  if (exists) return { duplicate: true };

  // 1) Lead identificado por el enlace de KAI (utm_content) → 2) por email → 3) lead nuevo.
  let leadId: string | null = null;
  const utm = body.payload.tracking?.utm_content;
  if (utm && /^[0-9a-f-]{36}$/i.test(utm)) {
    const [l] = await db.select({ id: leads.id }).from(leads).where(and(eq(leads.businessId, businessId), eq(leads.id, utm))).limit(1);
    leadId = l?.id ?? null;
  }
  if (!leadId) {
    const { lead } = await createLead(businessId, { name: body.payload.name ?? '', email: body.payload.email ?? null, source: 'webhook', sourceDetail: 'Calendly' }, { type: 'integration' });
    leadId = lead.id;
  }
  const [settings] = await db.select({ callLabel: aiSettings.callLabel }).from(aiSettings).where(eq(aiSettings.businessId, businessId)).limit(1);
  const [conv] = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(and(eq(conversations.businessId, businessId), eq(conversations.leadId, leadId)))
    .orderBy(desc(conversations.lastMessageAt))
    .limit(1);
  const [appt] = await db
    .insert(appointments)
    .values({
      businessId,
      leadId,
      conversationId: conv?.id ?? null,
      title: `${settings?.callLabel ?? 'Llamada'} · ${body.payload.name ?? 'Lead'}`,
      startsAt: new Date(ev.start_time),
      endsAt: new Date(ev.end_time),
      calendarProvider: 'calendly',
      calendarConnectionId: connectionId,
      externalEventId: ev.uri,
      meetingUrl: ev.location?.join_url ?? null,
      bookedBy: 'lead',
    })
    .returning();
  if (conv) await updateConversationState(businessId, conv.id, { offeredSlots: [], callAccepted: true });
  await afterBooked(businessId, appt, { type: 'integration' }, Boolean(conv));
  return { booked: true, appointmentId: appt.id };
}

/** ¿Es una reserva de la llamada de KAI? Sin tipo de evento elegido (o sin dato en el aviso) no se puede distinguir: se acepta. */
function isKaiCallBooking(connection: CalendarConnection | undefined, eventType: string | undefined, utmSource: string | null | undefined): boolean {
  if (utmSource === 'kai') return true;
  if (!connection?.calendarId || !eventType) return true;
  return eventType === connection.calendarId;
}
