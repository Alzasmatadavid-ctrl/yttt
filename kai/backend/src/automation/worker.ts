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
import {
  cancelClaimedJob,
  claimDueJobs,
  completeJob,
  failJob,
  hasActiveJob,
  releaseStaleJobs,
  scheduleJob,
  touchJob,
  type Job,
  type JobType,
} from './jobs.js';
import { composeFollowUp, runFirstContact, runSetterReply } from '../ai/setter/setter-engine.js';
import { expireOldActions } from '../ai/copilot/copilot-actions.js';
import { canSendFollowUpNow, conversationIsActiveForKai, getFollowUp, markFollowUp, scheduleNoReplyFollowUp, stopBusinessAutomations } from './followups.js';
import { sendMessage } from '../crm/messaging.service.js';
import { applyPipelineEvent, recordLeadEvent } from '../crm/leads.service.js';
import { getAutomation } from './reminders.js';
import { configuredMessage, confirmationText, noShowText, reminderTemplateParams, reminderText } from './messages.js';
import { requestOutcomeAlert } from '../calendar/calendar.service.js';
import { rollupAnalyticsForAll } from '../analytics/analytics.service.js';
import { purgeExpiredSessions } from '../auth/sessions.js';
import { retryFailedLeadgenEvents } from '../webhooks/meta.webhook.js';
import { DEFAULT_TONE } from '../lib/domain.js';

type Handler = (job: Job) => Promise<void>;

/**
 * Márgenes para no enviar recordatorios a destiempo cuando el trabajo se ejecuta tarde
 * (servidor caído o dormido, reintentos…): un “mañana a las 18:00” no tiene sentido una hora antes,
 * ni “en una hora” cuando faltan cinco minutos.
 */
const REMINDER_24H_MIN_LEAD_MS = 2 * 3600_000;
const REMINDER_1H_MIN_LEAD_MS = 15 * 60_000;

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
  if (conversationId) {
    // Nunca escribir a otra persona: la conversación guardada tiene que ser del lead de la cita.
    const [own] = await db
      .select({ id: conversations.id })
      .from(conversations)
      .where(and(eq(conversations.businessId, businessId), eq(conversations.id, conversationId), eq(conversations.leadId, row.lead.id)))
      .limit(1);
    if (!own) conversationId = null;
  }
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
    // Antes de redactar con IA: si el canal ya no deja escribir (ventana de 24 h cerrada y sin plantilla), no se envía.
    if (!(await canSendFollowUpNow(businessId, fu.conversationId))) {
      return markFollowUp(fu.id, 'skipped', { note: 'Fuera de la ventana de 24 h del canal: no se puede escribir al lead hasta que vuelva a escribir.' });
    }
    const automation = await getAutomation(businessId, 'followup_no_reply');
    if (!automation?.enabled) return markFollowUp(fu.id, 'cancelled', { note: 'Automatización desactivada' });
    const steps = automation.config.steps ?? [];
    const step = steps[fu.step - 1];
    if (!step) return markFollowUp(fu.id, 'cancelled', { note: 'Paso no configurado' });
    const hoursSilent = (Date.now() - (lead.lastOutboundAt ?? fu.createdAt).getTime()) / 3_600_000;
    const composed = await composeFollowUp(businessId, fu.conversationId, { step: fu.step, totalSteps: steps.length, angle: step.angle, hoursSilent });
    // Cuenta desactivada o límite de mensajes agotado: no es un fallo de calidad, simplemente no se envía.
    if (composed.skipped) return markFollowUp(fu.id, 'cancelled', { note: composed.skipped.note });
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
    // Lead dado de baja: no se le escribe (sendMessage también lo bloquearía, pero dejaría un aviso de «no enviado»).
    if (!ctx || ctx.appointment.status !== 'scheduled' || ctx.appointment.confirmationSentAt || !ctx.conversationId || ctx.lead.optedOut) return;
    if (ctx.appointment.startsAt.getTime() <= Date.now()) return; // la llamada ya empezó: no tiene sentido confirmarla
    const automation = await getAutomation(businessId, 'appointment_reminders');
    const sent = await sendMessage({
      businessId,
      conversationId: ctx.conversationId,
      text: confirmationText(ctx.textCtx, configuredMessage(automation?.config, 'confirmation')),
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
    if (!ctx || ctx.appointment.status !== 'scheduled' || !ctx.conversationId || ctx.lead.optedOut) return;
    if (kind === '24h' && ctx.appointment.reminder24hSentAt) return;
    if (kind === '1h' && ctx.appointment.reminder1hSentAt) return;
    // Trabajo ejecutado tarde: si ya no queda margen, el recordatorio sería falso o inútil.
    const leadTime = ctx.appointment.startsAt.getTime() - Date.now();
    if (leadTime < (kind === '24h' ? REMINDER_24H_MIN_LEAD_MS : REMINDER_1H_MIN_LEAD_MS)) {
      logger.info('appointment_reminder.too_late', { appointmentId, kind, minutesLeft: Math.round(leadTime / 60_000) });
      return;
    }
    const automation = await getAutomation(businessId, 'appointment_reminders');
    const sent = await sendMessage({
      businessId,
      conversationId: ctx.conversationId,
      text: reminderText(ctx.textCtx, kind, configuredMessage(automation?.config, kind === '24h' ? 'reminder24h' : 'reminder1h')),
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
    const recovery = await getAutomation(businessId, 'no_show_recovery');
    if (recovery && !recovery.enabled) return; // se desactivó después de marcar el no-show
    const sent = await sendMessage({
      businessId,
      conversationId: ctx.conversationId,
      text: noShowText(ctx.textCtx, configuredMessage(recovery?.config, 'noShow')),
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
    await expireOldActions();
    // Avisos de Lead Ads que fallaron (Meta caída, token caducado un momento…): se reintentan cada 6 h
    // durante 7 días aunque Meta deje de reenviarlos. Un fallo aquí no impide reprogramar el mantenimiento.
    try {
      await retryFailedLeadgenEvents();
    } catch (err) {
      await logError('worker.leadgen_retry', err);
    }
    await scheduleJob({ type: 'maintenance', runAt: new Date(Date.now() + 6 * 3600_000), dedupeKey: 'system:maintenance' });
    void job;
  },
};

async function businessIsActive(businessId: string): Promise<boolean> {
  const [biz] = await getDb().select({ status: businesses.status }).from(businesses).where(eq(businesses.id, businessId)).limit(1);
  return biz?.status === 'active';
}

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
    if (job.businessId && !(await businessIsActive(job.businessId))) {
      const note = 'Cuenta suspendida: no se envía nada.';
      await stopBusinessAutomations(job.businessId, note);
      await cancelClaimedJob(job.id, note);
      logger.info('worker.business_suspended', { jobId: job.id, type: job.type, businessId: job.businessId });
      return;
    }
    await handler(job);
    await completeJob(job.id);
  } catch (err) {
    await logError(`worker.${job.type}`, err, { jobId: job.id, payload: job.payload }, job.businessId);
    await failJob(job, errorMessage(err));
  }
}

const HOUSEKEEPING_EVERY_MS = 60_000;
let lastHousekeepingAt = 0;

/**
 * Tareas de la propia cola, como mucho una vez por minuto y por proceso (también con el cron externo,
 * que no arranca el bucle interno): liberar trabajos huérfanos y asegurar los trabajos del sistema.
 */
async function housekeeping(force = false) {
  if (!force && Date.now() - lastHousekeepingAt < HOUSEKEEPING_EVERY_MS) return;
  lastHousekeepingAt = Date.now();
  try {
    await releaseStaleJobs();
    await ensureSystemJobs();
  } catch (err) {
    logger.error('worker.housekeeping', { error: errorMessage(err) });
  }
}

/** Ejecuta los trabajos vencidos (usado por el bucle interno y por el endpoint de cron). */
export async function runDueJobs(limit = 10, opts: { forceHousekeeping?: boolean } = {}): Promise<number> {
  await housekeeping(opts.forceHousekeeping);
  const jobs = await claimDueJobs(limit);
  // Secuencial por conversación para no pisarse; distintos negocios podrían paralelizarse.
  for (const job of jobs) {
    // Si otro proceso lo liberó y lo volvió a reclamar mientras esperaba su turno, no se ejecuta dos veces.
    if (await touchJob(job)) await runJob(job);
  }
  return jobs.length;
}

let timer: NodeJS.Timeout | null = null;
let running = false;

/** Programa los trabajos periódicos del sistema si no hay ya uno pendiente o en marcha. */
export async function ensureSystemJobs() {
  const system: { type: JobType; runAt: Date; dedupeKey: string }[] = [
    { type: 'analytics_rollup', runAt: nextUtcHour(2), dedupeKey: 'system:analytics_rollup' },
    { type: 'maintenance', runAt: new Date(Date.now() + 60_000), dedupeKey: 'system:maintenance' },
  ];
  for (const job of system) {
    if (!(await hasActiveJob(job.dedupeKey))) await scheduleJob(job);
  }
}

export function startWorker() {
  if (timer) return;
  void housekeeping(true);
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
