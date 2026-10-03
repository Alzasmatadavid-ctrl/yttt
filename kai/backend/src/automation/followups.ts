/**
 * Seguimiento automático cuando el lead deja de responder.
 * - Se programa tras cada mensaje de KAI que espera respuesta.
 * - Se cancela en cuanto el lead responde, un humano toma el control o se agenda la llamada.
 * - Cada mensaje se redacta con el contexto real de la conversación (nunca “solo hago seguimiento”).
 */
import { and, count, desc, eq, gt } from 'drizzle-orm';
import { getDb } from '../database/client.js';
import { businesses, conversations, followUps, leads } from '../database/schema.js';
import { addHours, isWithinQuietHours, shiftOutOfQuietHours } from '../lib/time.js';
import { CALL_STATUSES, CLOSED_STATUSES } from '../lib/domain.js';
import { getAutomation } from './reminders.js';
import { scheduleJob } from './jobs.js';

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
  let runAt = addHours(from, steps[step - 1].delayHours);
  if (isWithinQuietHours(runAt, biz?.timezone ?? 'Europe/Madrid', automation.config.quietHours)) {
    runAt = shiftOutOfQuietHours(runAt, biz?.timezone ?? 'Europe/Madrid', automation.config.quietHours);
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

export async function listFollowUps(businessId: string, leadId?: string) {
  const conds = [eq(followUps.businessId, businessId)];
  if (leadId) conds.push(eq(followUps.leadId, leadId));
  return getDb()
    .select({ followUp: followUps, leadName: leads.name })
    .from(followUps)
    .innerJoin(leads, eq(leads.id, followUps.leadId))
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
