/**
 * Seguimiento automático cuando el lead deja de responder.
 * - Se programa tras cada mensaje de KAI que espera respuesta.
 * - Se cancela en cuanto el lead responde, un humano toma el control o se agenda la llamada.
 * - Cada mensaje se redacta con el contexto real de la conversación (nunca “solo hago seguimiento”).
 */
import { and, count, desc, eq, gt } from 'drizzle-orm';
import { DateTime } from 'luxon';
import { getDb } from '../database/client.js';
import { businesses, conversations, followUps, leads } from '../database/schema.js';
import { addHours, isWithinQuietHours, shiftOutOfQuietHours } from '../lib/time.js';
import { CALL_STATUSES, CLOSED_STATUSES } from '../lib/domain.js';
import { getConversation } from '../crm/conversations.service.js';
import { getChannelAdapter } from '../integrations/channels/registry.js';
import { HOURS_24 } from '../integrations/channels/types.js';
import { getActiveConnection } from '../integrations/connections.service.js';
import { getAutomation } from './reminders.js';
import { cancelJobsForBusiness, scheduleJob } from './jobs.js';

type QuietHours = { start: string; end: string };

/** Margen para no rozar el cierre de la ventana de 24 h del canal. */
export const WINDOW_MARGIN_MS = 30 * 60_000;
/** Separación mínima entre el último mensaje de KAI y un seguimiento adelantado para caber en la ventana. */
const MIN_GAP_MS = 60 * 60_000;

/** Inicio del tramo de silencio en el que cae `d` (p. ej. con 21:30–09:00, a las 03:00 → las 21:30 del día anterior). */
export function quietPeriodStart(d: Date, timezone: string, quiet: QuietHours): Date {
  const [sh, sm] = quiet.start.split(':').map(Number);
  let start = DateTime.fromJSDate(d).setZone(timezone).set({ hour: sh, minute: sm, second: 0, millisecond: 0 });
  if (start.toJSDate() > d) start = start.minus({ days: 1 });
  return start.toJSDate();
}

/**
 * Encaja un seguimiento en la ventana de mensajería del canal.
 * Si `runAt` cae después del cierre (`windowEnd`), lo adelanta al cierre, y si eso cae en horario de silencio,
 * a justo antes de que empiece. Devuelve null si ya no cabe después de `earliest` (entonces no se programa).
 */
export function fitIntoWindow(input: { runAt: Date; windowEnd: Date; earliest: Date; timezone: string; quietHours?: QuietHours }): Date | null {
  if (input.runAt <= input.windowEnd) return input.runAt;
  let at = input.windowEnd;
  if (input.quietHours && isWithinQuietHours(at, input.timezone, input.quietHours)) {
    at = new Date(quietPeriodStart(at, input.timezone, input.quietHours).getTime() - 60_000);
  }
  return at >= input.earliest ? at : null;
}

/**
 * ¿Hasta cuándo podrá KAI escribir un seguimiento en esta conversación?
 * - `restricted: false`: sin límite (chat web, o WhatsApp con plantilla de seguimiento aprobada).
 * - `restricted: true`: solo dentro de la ventana de 24 h desde el último mensaje del lead (Instagram, o WhatsApp
 *   sin plantilla). `windowEnd` es el último momento seguro (null si la ventana ya no se puede usar).
 */
export async function followUpWindow(businessId: string, conversationId: string): Promise<{ restricted: boolean; windowEnd: Date | null }> {
  const conv = await getConversation(businessId, conversationId);
  const adapter = getChannelAdapter(conv.channel);
  // Canal sin ventana (chat web): permite escribir incluso dentro de un año.
  if (adapter.canSendFreeText(conv.lastInboundAt, new Date(Date.now() + 365 * 24 * 3600_000), 'kai')) return { restricted: false, windowEnd: null };
  if (conv.channel !== 'web' && adapter.sendTemplate) {
    const connection = await getActiveConnection(businessId, conv.channel, conv.channelConnectionId);
    if (connection?.config.templates?.followUp) return { restricted: false, windowEnd: null };
  }
  if (!conv.lastInboundAt) return { restricted: true, windowEnd: null };
  const windowEnd = new Date(conv.lastInboundAt.getTime() + HOURS_24 - WINDOW_MARGIN_MS);
  return { restricted: true, windowEnd: adapter.canSendFreeText(conv.lastInboundAt, windowEnd, 'kai') ? windowEnd : null };
}

/** ¿Se puede enviar ahora un seguimiento en esta conversación? (para no redactarlo con IA si se va a bloquear). */
export async function canSendFollowUpNow(businessId: string, conversationId: string, now: Date = new Date()): Promise<boolean> {
  const w = await followUpWindow(businessId, conversationId);
  return !w.restricted || Boolean(w.windowEnd && now.getTime() <= w.windowEnd.getTime() + WINDOW_MARGIN_MS);
}

export async function scheduleNoReplyFollowUp(businessId: string, leadId: string, conversationId: string, from: Date = new Date()) {
  const db = getDb();
  const automation = await getAutomation(businessId, 'followup_no_reply');
  if (!automation?.enabled) return null;
  const steps = automation.config.steps ?? [];
  if (steps.length === 0) return null;
  const [lead] = await db
    .select()
    .from(leads)
    .where(and(eq(leads.businessId, businessId), eq(leads.id, leadId)))
    .limit(1);
  if (!lead || lead.optedOut || CLOSED_STATUSES.includes(lead.status) || CALL_STATUSES.includes(lead.status)) return null;

  // Ya hay uno programado → no duplicar.
  const [pending] = await db
    .select()
    .from(followUps)
    .where(and(eq(followUps.businessId, businessId), eq(followUps.leadId, leadId), eq(followUps.reason, 'no_reply'), eq(followUps.status, 'scheduled')))
    .limit(1);
  if (pending) return pending;

  // Paso = seguimientos enviados desde la última vez que el lead escribió + 1.
  const since = lead.lastInboundAt ?? lead.createdAt;
  const [sent] = await db
    .select({ n: count() })
    .from(followUps)
    .where(and(eq(followUps.businessId, businessId), eq(followUps.leadId, leadId), eq(followUps.reason, 'no_reply'), eq(followUps.status, 'sent'), gt(followUps.sentAt, since)));
  const step = Number(sent?.n ?? 0) + 1;
  if (step > steps.length) return null;

  const [biz] = await db.select({ timezone: businesses.timezone }).from(businesses).where(eq(businesses.id, businessId)).limit(1);
  const timezone = biz?.timezone ?? 'Europe/Madrid';
  let runAt = addHours(from, steps[step - 1].delayHours);
  if (isWithinQuietHours(runAt, timezone, automation.config.quietHours)) {
    runAt = shiftOutOfQuietHours(runAt, timezone, automation.config.quietHours);
  }
  // Instagram (o WhatsApp sin plantilla de seguimiento) solo deja escribir 24 h desde el último mensaje del lead:
  // el paso se adelanta para que caiga dentro y, si ya no cabe, no se programa (no se redacta para nada).
  const window = await followUpWindow(businessId, conversationId);
  if (window.restricted) {
    const fitted = window.windowEnd
      ? fitIntoWindow({
          runAt,
          windowEnd: window.windowEnd,
          earliest: new Date(Math.min(runAt.getTime(), from.getTime() + MIN_GAP_MS)),
          timezone,
          quietHours: automation.config.quietHours,
        })
      : null;
    if (!fitted) return null;
    runAt = fitted;
  }
  const [fu] = await db
    .insert(followUps)
    .values({ businessId, leadId, conversationId, reason: 'no_reply', step, scheduledFor: runAt })
    .returning();
  const job = await scheduleJob({ businessId, type: 'followup', runAt, payload: { followUpId: fu.id, leadId }, dedupeKey: `followup:${fu.id}` });
  await db.update(followUps).set({ jobId: job.id }).where(eq(followUps.id, fu.id));
  return fu;
}

export async function getFollowUp(followUpId: string) {
  const [row] = await getDb().select().from(followUps).where(eq(followUps.id, followUpId)).limit(1);
  return row ?? null;
}

export async function markFollowUp(followUpId: string, status: 'sent' | 'skipped' | 'failed' | 'cancelled', extra: { messageId?: string; note?: string } = {}) {
  await getDb()
    .update(followUps)
    .set({ status, messageId: extra.messageId ?? null, note: extra.note ?? null, sentAt: status === 'sent' ? new Date() : null })
    .where(eq(followUps.id, followUpId));
}

/**
 * Cuenta suspendida (o eliminada): no se envía nada en su nombre. Se cancelan todos sus trabajos pendientes
 * y sus seguimientos programados, para que no salga una avalancha de mensajes antiguos si se reactiva.
 */
export async function stopBusinessAutomations(businessId: string, note: string) {
  await cancelJobsForBusiness(businessId, note);
  await getDb()
    .update(followUps)
    .set({ status: 'cancelled', note })
    .where(and(eq(followUps.businessId, businessId), eq(followUps.status, 'scheduled')));
}

export async function listFollowUps(businessId: string, leadId?: string) {
  const conds = [eq(followUps.businessId, businessId)];
  if (leadId) conds.push(eq(followUps.leadId, leadId));
  return getDb()
    .select({ followUp: followUps, leadName: leads.name })
    .from(followUps)
    .innerJoin(leads, and(eq(leads.id, followUps.leadId), eq(leads.businessId, followUps.businessId)))
    .where(and(...conds))
    .orderBy(desc(followUps.scheduledFor))
    .limit(100);
}

export async function conversationIsActiveForKai(businessId: string, conversationId: string) {
  const [c] = await getDb()
    .select()
    .from(conversations)
    .where(and(eq(conversations.businessId, businessId), eq(conversations.id, conversationId)))
    .limit(1);
  return Boolean(c && c.aiEnabled && !c.handoffActive);
}
