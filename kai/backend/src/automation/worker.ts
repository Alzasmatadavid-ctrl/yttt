/**
 * Trabajador de automatizaciones. Ejecuta los trabajos vencidos de la cola:
 * respuestas de KAI, seguimientos, confirmaciones, recordatorios, no-shows, avisos post-llamada,
 * métricas diarias y mantenimiento.
 *
 * Puede funcionar de dos formas (ambas seguras a la vez):
 *  - En el propio servidor (RUN_WORKER=true): revisa la cola cada pocos segundos.
 *  - Mediante un cron externo que llama a POST /api/internal/cron (con CRON_SECRET).
 */
import { and, desc, eq } from 'drizzle-orm';
import { getDb } from '../database/client.js';
import { aiSettings, appointments, businesses, conversations, leads, trainers } from '../database/schema.js';
import { CALL_STATUSES, CLOSED_STATUSES } from '../lib/domain.js';
import { errorMessage } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { addDays } from '../lib/time.js';
import { logError } from '../audit/audit.service.js';
import { env } from '../config/env.js';
import { claimDueJobs, completeJob, failJob, releaseStaleJobs, scheduleJob, type Job } from './jobs.js';
import { composeFollowUp, runFirstContact, runSetterReply } from '../ai/setter/setter-engine.js';
import { conversationIsActiveForKai, getFollowUp, markFollowUp, scheduleNoReplyFollowUp } from './followups.js';
import { sendMessage } from '../crm/messaging.service.js';
import { applyPipelineEvent, recordLeadEvent } from '../crm/leads.service.js';
import { getAutomation } from './reminders.js';
import { confirmationText, noShowText, reminderTemplateParams, reminderText } from './messages.js';
import { requestOutcomeAlert } from '../calendar/calendar.service.js';
import { rollupAnalyticsForAll } from '../analytics/analytics.service.js';
import { purgeExpiredSessions } from '../auth/sessions.js';
import { DEFAULT_TONE } from '../lib/domain.js';

type Handler = (job: Job) => Promise<void>;

async function appointmentContext(businessId: string, appointmentId: string) {
  const db = getDb();
  const [row] = await db
    .select({ appointment: appointments, lead: leads, business: businesses })
    .from(appointments)
    .innerJoin(leads, eq(leads.id, appointments.leadId))
    .innerJoin(businesses, eq(businesses.id, appointments.businessId))
    .where(and(eq(appointments.businessId, businessId), eq(appointments.id, appointmentId)))
    .limit(1);
  if (!row) return null;
  const [settings] = await db.select().from(aiSettings).where(eq(aiSettings.businessId, businessId)).limit(1);
  const [trainer] = await db.select().from(trainers).where(eq(trainers.businessId, businessId)).limit(1);
  let conversationId = row.appointment.conversationId;
  if (!conversationId) {
    const [conv] = await db
      .select({ id: conversations.id })
      .from(conversations)
      .where(and(eq(conversations.businessId, businessId), eq(conversations.leadId, row.lead.id)))
      .orderBy(desc(conversations.lastMessageAt))
      .limit(1);
    conversationId = conv?.id ?? null;
  }
  return {
    ...row,
    conversationId,
    textCtx: {
      leadName: row.lead.name,
      trainerName: trainer?.displayName || 'el equipo',
      callLabel: settings?.callLabel ?? 'llamada',
      startsAt: row.appointment.startsAt,
      timezone: row.business.timezone,
      meetingUrl: row.appointment.meetingUrl,
      tone: settings?.tone ?? DEFAULT_TONE,
    },
  };
}

const handlers: Record<string, Handler> = {
  async kai_reply(job) {
    const { conversationId } = job.payload as { conversationId: string };
    const result = await runSetterReply(job.businessId!, conversationId);
    logger.debug('kai_reply', { conversationId, status: result.status, reason: result.reason });
  },

  async first_contact(job) {
    const { conversationId } = job.payload as { conversationId: string };
    await runFirstContact(job.businessId!, conversationId);
  },

  async followup(job) {
    const businessId = job.businessId!;
    const { followUpId } = job.payload as { followUpId: string };
    const fu = await getFollowUp(followUpId);
    if (!fu || fu.status !== 'scheduled') return;
    const [lead] = await getDb()
      .select()
      .from(leads)
      .where(and(eq(leads.businessId, businessId), eq(leads.id, fu.leadId)))
      .limit(1);
    if (!lead || lead.optedOut) return markFollowUp(fu.id, 'cancelled', { note: 'Lead no disponible o dado de baja' });
    if (lead.lastInboundAt && lead.lastInboundAt > fu.createdAt) return markFollowUp(fu.id, 'cancelled', { note: 'El lead respondió' });
    if (CLOSED_STATUSES.includes(lead.status) || CALL_STATUSES.includes(lead.status)) return markFollowUp(fu.id, 'cancelled', { note: `Etapa ${lead.status}` });
    if (!(await conversationIsActiveForKai(businessId, fu.conversationId))) return markFollowUp(fu.id, 'skipped', { note: 'KAI pausado en la conversación' });
    const automation = await getAutomation(businessId, 'followup_no_reply');
    if (!automation?.enabled) return markFollowUp(fu.id, 'cancelled', { note: 'Automatización desactivada' });
    const steps = automation.config.steps ?? [];
    const step = steps[fu.step - 1];
    if (!step) return markFollowUp(fu.id, 'cancelled', { note: 'Paso no configurado' });
    const hoursSilent = (Date.now() - (lead.lastOutboundAt ?? fu.createdAt).getTime()) / 3_600_000;
    const composed = await composeFollowUp(businessId, fu.conversationId, { step: fu.step, totalSteps: steps.length, angle: step.angle, hoursSilent });
    if (!composed.text) {
      await markFollowUp(fu.id, 'failed', { note: `Control de calidad: ${composed.issues.join(' · ')}`.slice(0, 500) });
      return;
    }
    const sent = await sendMessage({
      businessId,
      conversationId: fu.conversationId,
      text: composed.text,
      sender: { type: 'kai' },
      purpose: 'follow_up',
      metadata: { followUpId: fu.id, step: fu.step, ...composed.meta },
    });
    if (!sent.delivered) return markFollowUp(fu.id, 'skipped', { messageId: sent.message.id, note: sent.blockedReason });
    await markFollowUp(fu.id, 'sent', { messageId: sent.message.id });
    await recordLeadEvent(businessId, lead.id, 'followup_sent', { type: 'kai' }, { step: fu.step });
    await applyPipelineEvent(businessId, lead.id, 'followup_sent');
    await scheduleNoReplyFollowUp(businessId, lead.id, fu.conversationId);
  },

  async appointment_confirmation(job) {
    const businessId = job.businessId!;
    const ctx = await appointmentContext(businessId, (job.payload as { appointmentId: string }).appointmentId);
    if (!ctx || ctx.appointment.status !== 'scheduled' || ctx.appointment.confirmationSentAt || !ctx.conversationId) return;
    const sent = await sendMessage({
      businessId,
      conversationId: ctx.conversationId,
      text: confirmationText(ctx.textCtx),
      sender: { type: 'kai' },
      purpose: 'confirmation',
      templateExtraParams: reminderTemplateParams(ctx.textCtx),
      metadata: { appointmentId: ctx.appointment.id, kind: 'confirmation' },
    });
    if (sent.delivered) await getDb().update(appointments).set({ confirmationSentAt: new Date() }).where(eq(appointments.id, ctx.appointment.id));
  },

  async appointment_reminder(job) {
    const businessId = job.businessId!;
    const { appointmentId, kind } = job.payload as { appointmentId: string; kind: '24h' | '1h' };
    const ctx = await appointmentContext(businessId, appointmentId);
    if (!ctx || ctx.appointment.status !== 'scheduled' || !ctx.conversationId) return;
    if (kind === '24h' && ctx.appointment.reminder24hSentAt) return;
    if (kind === '1h' && ctx.appointment.reminder1hSentAt) return;
    const sent = await sendMessage({
      businessId,
      conversationId: ctx.conversationId,
      text: reminderText(ctx.textCtx, kind),
      sender: { type: 'kai' },
      purpose: 'reminder',
      templateExtraParams: reminderTemplateParams(ctx.textCtx),
      metadata: { appointmentId, kind: `reminder_${kind}` },
    });
    if (!sent.delivered) return;
    await getDb()
      .update(appointments)
      .set(kind === '24h' ? { reminder24hSentAt: new Date() } : { reminder1hSentAt: new Date() })
      .where(eq(appointments.id, appointmentId));
    await applyPipelineEvent(businessId, ctx.lead.id, 'reminder_sent');
    await recordLeadEvent(businessId, ctx.lead.id, 'reminder_sent', { type: 'kai' }, { appointmentId, kind });
  },

  async post_call(job) {
    const businessId = job.businessId!;
    const ctx = await appointmentContext(businessId, (job.payload as { appointmentId: string }).appointmentId);
    if (!ctx) return;
    await requestOutcomeAlert(businessId, ctx.appointment, ctx.lead.name);
  },

  async no_show_message(job) {
    const businessId = job.businessId!;
    const ctx = await appointmentContext(businessId, (job.payload as { appointmentId: string }).appointmentId);
    if (!ctx || ctx.appointment.status !== 'no_show' || !ctx.conversationId || ctx.lead.optedOut) return;
    if (ctx.lead.lastInboundAt && ctx.lead.lastInboundAt > ctx.appointment.updatedAt) return; // ya escribió
    if (!(await conversationIsActiveForKai(businessId, ctx.conversationId))) return;
    const sent = await sendMessage({
      businessId,
      conversationId: ctx.conversationId,
      text: noShowText(ctx.textCtx),
      sender: { type: 'kai' },
      purpose: 'no_show',
      metadata: { appointmentId: ctx.appointment.id, kind: 'no_show' },
    });
    if (sent.delivered) {
      await recordLeadEvent(businessId, ctx.lead.id, 'no_show_message_sent', { type: 'kai' }, { appointmentId: ctx.appointment.id });
      await scheduleNoReplyFollowUp(businessId, ctx.lead.id, ctx.conversationId);
    }
  },

  async analytics_rollup(job) {
    await rollupAnalyticsForAll(addDays(new Date(), -1));
    await scheduleJob({ type: 'analytics_rollup', runAt: nextUtcHour(2), dedupeKey: 'system:analytics_rollup' });
    void job;
  },

  async maintenance(job) {
    await purgeExpiredSessions();
    await releaseStaleJobs();
    await scheduleJob({ type: 'maintenance', runAt: new Date(Date.now() + 6 * 3600_000), dedupeKey: 'system:maintenance' });
    void job;
  },
};

function nextUtcHour(hour: number) {
  const d = new Date();
  d.setUTCHours(hour, 0, 0, 0);
  if (d <= new Date()) d.setUTCDate(d.getUTCDate() + 1);
  return d;
}

export async function runJob(job: Job): Promise<void> {
  const handler = handlers[job.type];
  if (!handler) {
    await failJob({ ...job, attempts: job.maxAttempts }, `Tipo de trabajo desconocido: ${job.type}`);
    return;
  }
  try {
    await handler(job);
    await completeJob(job.id);
  } catch (err) {
    await logError(`worker.${job.type}`, err, { jobId: job.id, payload: job.payload }, job.businessId);
    await failJob(job, errorMessage(err));
  }
}

/** Ejecuta los trabajos vencidos (usado por el bucle interno y por el endpoint de cron). */
export async function runDueJobs(limit = 10): Promise<number> {
  const jobs = await claimDueJobs(limit);
  // Secuencial por conversación para no pisarse; distintos negocios podrían paralelizarse.
  for (const job of jobs) await runJob(job);
  return jobs.length;
}

let timer: NodeJS.Timeout | null = null;
let running = false;

export async function ensureSystemJobs() {
  await scheduleJob({ type: 'analytics_rollup', runAt: nextUtcHour(2), dedupeKey: 'system:analytics_rollup' });
  await scheduleJob({ type: 'maintenance', runAt: new Date(Date.now() + 60_000), dedupeKey: 'system:maintenance' });
}

export function startWorker() {
  if (timer) return;
  void ensureSystemJobs().catch((err) => logger.error('worker.system_jobs', { error: errorMessage(err) }));
  timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      // Vacía la cola en tandas mientras haya trabajos vencidos.
      for (let i = 0; i < 5; i++) if ((await runDueJobs(10)) < 10) break;
    } catch (err) {
      logger.error('worker.tick', { error: errorMessage(err) });
    } finally {
      running = false;
    }
  }, env.WORKER_INTERVAL_MS);
  logger.info('worker.started', { intervalMs: env.WORKER_INTERVAL_MS });
}

export function stopWorker() {
  if (timer) clearInterval(timer);
  timer = null;
}
