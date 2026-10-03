import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { boolQuery, parse, uuidParam } from '../lib/http.js';
import { requireTenant } from '../auth/guards.js';
import { LEAD_SOURCES, LEAD_STATUS_KEYS, LEAD_TEMPERATURES, type LeadSource, type LeadStatus, type LeadTemperature } from '../lib/domain.js';
import {
  createLead,
  deleteLead,
  getLeadProfile,
  listLeads,
  setLeadStatus,
  updateLead,
  recomputeLeadScore,
} from './leads.service.js';
import {
  getConversationDetail,
  getOrCreateConversation,
  inboxCounts,
  listInbox,
  markConversationRead,
  releaseConversation,
  takeOverConversation,
  type InboxFilter,
} from './conversations.service.js';
import { sendMessage } from './messaging.service.js';
import { listOpenAlerts, resolveAlert } from './alerts.service.js';
import { deleteLeadMemory, saveLeadMemories } from '../ai/memory/lead-memory.js';
import { scheduleJob } from '../automation/jobs.js';
import { listFollowUps } from '../automation/followups.js';
import { audit } from '../audit/audit.service.js';

const csv = <T extends string>(allowed: readonly T[]) =>
  z
    .string()
    .optional()
    .transform((v) => (v ? (v.split(',').filter((x) => (allowed as readonly string[]).includes(x)) as T[]) : undefined));

export async function crmRoutes(app: FastifyInstance) {
  // ───────────── Leads ─────────────
  app.get('/leads', async (request) => {
    const ctx = await requireTenant(request, 'leads:read');
    const q = parse(
      z.object({
        status: csv(LEAD_STATUS_KEYS),
        temperature: csv(LEAD_TEMPERATURES.map((t) => t.key)),
        source: csv(LEAD_SOURCES.map((s) => s.key)),
        search: z.string().max(100).optional(),
        minScore: z.coerce.number().int().min(0).max(100).optional(),
        noReplyHours: z.coerce.number().min(1).max(24 * 60).optional(),
        sort: z.enum(['score', 'recent', 'created', 'oldest_reply']).optional(),
        includeTest: boolQuery,
        limit: z.coerce.number().int().min(1).max(500).optional(),
        offset: z.coerce.number().int().min(0).optional(),
      }),
      request.query,
    );
    const leads = await listLeads(ctx.businessId, {
      ...q,
      status: q.status as LeadStatus[] | undefined,
      temperature: q.temperature as LeadTemperature[] | undefined,
      source: q.source as LeadSource[] | undefined,
    });
    return { leads };
  });

  app.post('/leads', async (request) => {
    const ctx = await requireTenant(request, 'leads:write');
    const body = parse(
      z.object({
        name: z.string().trim().min(1, 'Indica un nombre').max(120),
        phone: z.string().trim().max(40).optional(),
        email: z.string().trim().email().max(200).optional().or(z.literal('')),
        instagramUsername: z.string().trim().max(60).optional(),
        goal: z.string().trim().max(500).optional(),
        notes: z.string().max(5000).optional(),
        source: z.enum(['instagram', 'whatsapp', 'meta_ads', 'landing', 'webhook', 'manual']).default('manual'),
      }),
      request.body,
    );
    const { lead, created } = await createLead(
      ctx.businessId,
      { ...body, email: body.email || null, instagramUsername: body.instagramUsername?.replace(/^@/, '') },
      { type: 'user', userId: ctx.userId },
    );
    return { lead, created };
  });

  app.get('/leads/:id', async (request) => {
    const ctx = await requireTenant(request, 'leads:read');
    const { id } = parse(uuidParam, request.params);
    const profile = await getLeadProfile(ctx.businessId, id);
    const followUps = await listFollowUps(ctx.businessId, id);
    return { ...profile, followUps };
  });

  app.patch('/leads/:id', async (request) => {
    const ctx = await requireTenant(request, 'leads:write');
    const { id } = parse(uuidParam, request.params);
    const body = parse(
      z.object({
        name: z.string().trim().max(120).optional(),
        phone: z.string().trim().max(40).nullable().optional(),
        email: z.string().trim().max(200).nullable().optional(),
        instagramUsername: z.string().trim().max(60).nullable().optional(),
        notes: z.string().max(5000).optional(),
        tags: z.array(z.string().max(40)).max(20).optional(),
        goalSummary: z.string().max(200).nullable().optional(),
        nextAction: z.string().max(200).nullable().optional(),
        nextActionAt: z.coerce.date().nullable().optional(),
        assignedUserId: z.string().uuid().nullable().optional(),
        dealValueCents: z.number().int().min(0).max(100_000_000).nullable().optional(),
      }),
      request.body,
    );
    const lead = await updateLead(ctx.businessId, id, body, { type: 'user', userId: ctx.userId });
    return { lead };
  });

  app.post('/leads/:id/status', async (request) => {
    const ctx = await requireTenant(request, 'leads:write');
    const { id } = parse(uuidParam, request.params);
    const body = parse(
      z.object({
        status: z.enum(LEAD_STATUS_KEYS as [LeadStatus, ...LeadStatus[]]),
        reason: z.string().max(300).optional(),
        dealValueCents: z.number().int().min(0).max(100_000_000).nullable().optional(),
      }),
      request.body,
    );
    const lead = await setLeadStatus(ctx.businessId, id, body.status, { type: 'user', userId: ctx.userId }, { reason: body.reason, dealValueCents: body.dealValueCents });
    return { lead };
  });

  app.post('/leads/:id/rescore', async (request) => {
    const ctx = await requireTenant(request, 'leads:write');
    const { id } = parse(uuidParam, request.params);
    return recomputeLeadScore(ctx.businessId, id);
  });

  app.delete('/leads/:id', async (request) => {
    const ctx = await requireTenant(request, 'leads:delete');
    const { id } = parse(uuidParam, request.params);
    await deleteLead(ctx.businessId, id, { type: 'user', userId: ctx.userId });
    return { ok: true };
  });

  app.post('/leads/:id/memories', async (request) => {
    const ctx = await requireTenant(request, 'leads:write');
    const { id } = parse(uuidParam, request.params);
    const body = parse(z.object({ content: z.string().trim().min(3).max(300), kind: z.enum(['fact', 'event', 'preference', 'constraint', 'personal']).default('fact') }), request.body);
    await getLeadProfile(ctx.businessId, id);
    const saved = await saveLeadMemories(ctx.businessId, id, [{ kind: body.kind, content: body.content, importance: 2 }]);
    return { memory: saved[0] ?? null };
  });

  app.delete('/leads/:id/memories/:memoryId', async (request) => {
    const ctx = await requireTenant(request, 'leads:write');
    const { memoryId } = parse(z.object({ id: z.string().uuid(), memoryId: z.string().uuid() }), request.params);
    await deleteLeadMemory(ctx.businessId, memoryId);
    return { ok: true };
  });

  // Iniciar conversación de simulador con un lead manual (para probar a KAI con él).
  app.post('/leads/:id/start-test-conversation', async (request) => {
    const ctx = await requireTenant(request, 'leads:write');
    const { id } = parse(uuidParam, request.params);
    const conv = await getOrCreateConversation(ctx.businessId, id, 'web');
    return { conversationId: conv.id };
  });

  // ───────────── Bandeja de entrada ─────────────
  app.get('/inbox', async (request) => {
    const ctx = await requireTenant(request, 'leads:read');
    const q = parse(
      z.object({
        filter: z.enum(['all', 'new', 'hot', 'qualified', 'pending', 'booked', 'no_reply', 'clients', 'handoff']).default('all'),
        search: z.string().max(100).optional(),
        limit: z.coerce.number().int().min(1).max(200).default(60),
        offset: z.coerce.number().int().min(0).default(0),
        includeTest: boolQuery,
      }),
      request.query,
    );
    const [items, counts] = await Promise.all([listInbox(ctx.businessId, { ...q, filter: q.filter as InboxFilter }), inboxCounts(ctx.businessId)]);
    return { items, counts };
  });

  app.get('/conversations/:id', async (request) => {
    const ctx = await requireTenant(request, 'leads:read');
    const { id } = parse(uuidParam, request.params);
    return getConversationDetail(ctx.businessId, id);
  });

  app.post('/conversations/:id/read', async (request) => {
    const ctx = await requireTenant(request, 'leads:read');
    const { id } = parse(uuidParam, request.params);
    await markConversationRead(ctx.businessId, id);
    return { ok: true };
  });

  app.post('/conversations/:id/messages', async (request) => {
    const ctx = await requireTenant(request, 'conversations:reply');
    const { id } = parse(uuidParam, request.params);
    const body = parse(z.object({ text: z.string().trim().min(1, 'Escribe un mensaje').max(4000), pauseKai: z.boolean().default(true) }), request.body);
    if (body.pauseKai) await takeOverConversation(ctx.businessId, id, ctx.userId);
    const result = await sendMessage({ businessId: ctx.businessId, conversationId: id, text: body.text, sender: { type: 'human', userId: ctx.userId }, purpose: 'manual' });
    return { message: result.message, delivered: result.delivered, blockedReason: result.blockedReason ?? null };
  });

  app.post('/conversations/:id/take-over', async (request) => {
    const ctx = await requireTenant(request, 'conversations:reply');
    const { id } = parse(uuidParam, request.params);
    await takeOverConversation(ctx.businessId, id, ctx.userId);
    return { ok: true };
  });

  app.post('/conversations/:id/release', async (request) => {
    const ctx = await requireTenant(request, 'conversations:reply');
    const { id } = parse(uuidParam, request.params);
    const body = parse(z.object({ replyNow: z.boolean().default(false) }), request.body ?? {});
    await releaseConversation(ctx.businessId, id, ctx.userId);
    if (body.replyNow) {
      await scheduleJob({ businessId: ctx.businessId, type: 'kai_reply', runAt: new Date(), payload: { conversationId: id }, dedupeKey: `reply:${id}`, maxAttempts: 2 });
    }
    await audit({ businessId: ctx.businessId, actorType: 'user', actorUserId: ctx.userId, action: 'conversation.release', entityType: 'conversation', entityId: id, metadata: body });
    return { ok: true };
  });

  // ───────────── Avisos ─────────────
  app.get('/alerts', async (request) => {
    const ctx = await requireTenant(request, 'leads:read');
    return { alerts: await listOpenAlerts(ctx.businessId) };
  });

  app.post('/alerts/:id/resolve', async (request) => {
    const ctx = await requireTenant(request, 'leads:write');
    const { id } = parse(uuidParam, request.params);
    const body = parse(z.object({ status: z.enum(['resolved', 'dismissed']).default('resolved') }), request.body ?? {});
    return { alert: await resolveAlert(ctx.businessId, id, body.status) };
  });

  app.get('/follow-ups', async (request) => {
    const ctx = await requireTenant(request, 'leads:read');
    return { followUps: await listFollowUps(ctx.businessId) };
  });
}
