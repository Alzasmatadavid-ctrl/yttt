/**
 * Simulador: el entrenador prueba a KAI escribiendo como si fuera un lead.
 * Usa exactamente el mismo motor que en producción (análisis, estrategia, agenda real,
 * control de calidad, CRM), pero el canal es interno y los leads se marcan como “de prueba”
 * para no ensuciar las métricas.
 */
import type { FastifyInstance } from 'fastify';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../database/client.js';
import { conversations, followUps, leads, scheduledJobs } from '../database/schema.js';
import { parse, uuidParam } from '../lib/http.js';
import { badRequest } from '../lib/errors.js';
import { perBusinessRateLimit, requireTenant } from '../auth/guards.js';
import { env } from '../config/env.js';
import { createLead, deleteLead, getLeadProfile } from './leads.service.js';
import { conversationLeadJoin, getConversationDetail, getOrCreateConversation } from './conversations.service.js';
import { runFirstContact, runSetterReply } from '../ai/setter/setter-engine.js';
import { ingestExternalLead, receiveInboundForConversation } from '../webhooks/inbound.service.js';
import { scheduleNoReplyFollowUp } from '../automation/followups.js';
import { runJob } from '../automation/worker.js';

export async function simulatorRoutes(app: FastifyInstance) {
  // Cada prueba gasta IA: límite por negocio (no por IP), además del límite mensual de mensajes del plan.
  const aiLimit = perBusinessRateLimit(() => env.SIMULATOR_MAX_PER_MINUTE);

  app.get('/simulator/conversations', async (request) => {
    const ctx = await requireTenant(request, 'conversations:reply');
    const rows = await getDb()
      .select({ conversation: conversations, lead: leads })
      .from(conversations)
      .innerJoin(leads, conversationLeadJoin)
      .where(and(eq(conversations.businessId, ctx.businessId), eq(leads.businessId, ctx.businessId), eq(conversations.channel, 'web'), eq(leads.isTest, true)))
      .orderBy(desc(conversations.updatedAt))
      .limit(30);
    return { conversations: rows.map((r) => ({ id: r.conversation.id, leadId: r.lead.id, leadName: r.lead.name, score: r.lead.score, status: r.lead.status, preview: r.conversation.lastMessagePreview, updatedAt: r.conversation.updatedAt })) };
  });

  app.post('/simulator/conversations', async (request) => {
    const ctx = await requireTenant(request, 'conversations:reply');
    const body = parse(z.object({ leadName: z.string().trim().min(1).max(80).default('Lead de prueba') }), request.body ?? {});
    const { lead } = await createLead(ctx.businessId, { name: body.leadName, source: 'simulator', isTest: true }, { type: 'user', userId: ctx.userId });
    const conv = await getOrCreateConversation(ctx.businessId, lead.id, 'web');
    return { conversationId: conv.id, leadId: lead.id };
  });

  /** Simula un lead que deja sus datos en un formulario: KAI le escribe primero. */
  app.post('/simulator/form-lead', aiLimit, async (request) => {
    const ctx = await requireTenant(request, 'conversations:reply');
    const body = parse(z.object({ name: z.string().trim().min(1).max(80), goal: z.string().trim().max(300).optional() }), request.body);
    const { lead, conversationId } = await ingestExternalLead({ businessId: ctx.businessId, source: 'simulator', sourceDetail: 'Formulario simulado', name: body.name, goal: body.goal, firstContactChannel: 'web', isTest: true });
    const convId = conversationId ?? (await getOrCreateConversation(ctx.businessId, lead.id, 'web')).id;
    // Ejecutar ya el primer contacto (sin esperar a la cola).
    await getDb().update(scheduledJobs).set({ status: 'cancelled' }).where(and(eq(scheduledJobs.dedupeKey, `first_contact:${lead.id}`), eq(scheduledJobs.status, 'pending')));
    const result = await runFirstContact(ctx.businessId, convId);
    return { conversationId: convId, leadId: lead.id, result };
  });

  app.get('/simulator/conversations/:id', async (request) => {
    const ctx = await requireTenant(request, 'conversations:reply');
    const { id } = parse(uuidParam, request.params);
    const detail = await getConversationDetail(ctx.businessId, id);
    if (!detail.lead?.isTest) throw badRequest('Esta conversación no es de prueba.');
    const profile = await getLeadProfile(ctx.businessId, detail.lead.id);
    const pendingFollowUps = await getDb()
      .select()
      .from(followUps)
      .where(and(eq(followUps.businessId, ctx.businessId), eq(followUps.leadId, detail.lead.id), eq(followUps.status, 'scheduled')));
    return { ...detail, scoreBreakdown: profile.scoreBreakdown, qualificationRules: profile.qualificationRules, events: profile.events.slice(0, 30), pendingFollowUps };
  });

  /** El “lead” escribe y KAI responde al instante (sin el retardo humano). */
  app.post('/simulator/conversations/:id/messages', aiLimit, async (request) => {
    const ctx = await requireTenant(request, 'conversations:reply');
    const { id } = parse(uuidParam, request.params);
    const body = parse(z.object({ text: z.string().trim().min(1).max(2000) }), request.body);
    const detail = await getConversationDetail(ctx.businessId, id);
    if (!detail.lead?.isTest) throw badRequest('Esta conversación no es de prueba.');
    await receiveInboundForConversation(ctx.businessId, id, body.text);
    const result = await runSetterReply(ctx.businessId, id);
    return { result };
  });

  /** Fuerza el siguiente seguimiento ahora (para ver cómo sería sin esperar horas). */
  app.post('/simulator/conversations/:id/follow-up', aiLimit, async (request) => {
    const ctx = await requireTenant(request, 'conversations:reply');
    const { id } = parse(uuidParam, request.params);
    const detail = await getConversationDetail(ctx.businessId, id);
    if (!detail.lead?.isTest) throw badRequest('Esta conversación no es de prueba.');
    const db = getDb();
    let [fu] = await db
      .select()
      .from(followUps)
      .where(and(eq(followUps.businessId, ctx.businessId), eq(followUps.leadId, detail.lead.id), eq(followUps.status, 'scheduled')))
      .limit(1);
    if (!fu) {
      const created = await scheduleNoReplyFollowUp(ctx.businessId, detail.lead.id, id);
      if (!created) throw badRequest('No hay más seguimientos programables (automatización desactivada, pasos agotados o el lead tiene llamada).');
      fu = created;
    }
    const [job] = await db.select().from(scheduledJobs).where(eq(scheduledJobs.id, fu.jobId!)).limit(1);
    if (!job || job.status !== 'pending') throw badRequest('El seguimiento ya no está pendiente.');
    await db.update(scheduledJobs).set({ status: 'running', attempts: job.attempts + 1, lockedAt: new Date() }).where(eq(scheduledJobs.id, job.id));
    await runJob({ ...job, attempts: job.attempts + 1 });
    return { ok: true };
  });

  app.delete('/simulator/conversations/:id', async (request) => {
    const ctx = await requireTenant(request, 'conversations:reply');
    const { id } = parse(uuidParam, request.params);
    const detail = await getConversationDetail(ctx.businessId, id);
    if (!detail.lead?.isTest) throw badRequest('Solo se pueden borrar conversaciones de prueba.');
    await deleteLead(ctx.businessId, detail.lead.id, { type: 'user', userId: ctx.userId });
    return { ok: true };
  });
}
