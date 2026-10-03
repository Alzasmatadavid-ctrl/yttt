/**
 * Webhook de Calendly: registra en KAI las citas que el lead confirma desde el enlace.
 * URL (se crea automáticamente al conectar Calendly): {API_URL}/api/webhooks/calendly/{businessId}
 */
import { and, desc, eq } from 'drizzle-orm';
import { getDb } from '../database/client.js';
import { appointments, conversations, leads } from '../database/schema.js';
import { decryptJson } from '../lib/crypto.js';
import { getCalendarConnection, type CalendlyCredentials } from '../calendar/connections.js';
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
    scheduled_event?: { uri: string; start_time: string; end_time: string; location?: { join_url?: string | null } };
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
