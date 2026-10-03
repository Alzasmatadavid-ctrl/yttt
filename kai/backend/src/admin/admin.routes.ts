/**
 * Panel del propietario del SaaS (rol de plataforma “admin”).
 * Ver usuarios y negocios, activar/desactivar cuentas, revisar uso, errores, integraciones,
 * conversaciones (con registro de auditoría), editar planes y límites y consultar métricas globales.
 */
import type { FastifyInstance } from 'fastify';
import { and, asc, desc, eq, gte, ilike, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../database/client.js';
import {
  auditLogs,
  businesses,
  calendarConnections,
  channelConnections,
  conversations,
  errorLogs,
  leads,
  memberships,
  messages,
  plans,
  scheduledJobs,
  usageCounters,
  users,
} from '../database/schema.js';
import { parse, uuidParam } from '../lib/http.js';
import { badRequest, notFound } from '../lib/errors.js';
import { requireAdmin } from '../auth/guards.js';
import { audit } from '../audit/audit.service.js';
import { usagePeriod } from '../lib/time.js';
import { destroyUserSessions } from '../auth/sessions.js';

const LimitsSchema = z.object({
  maxLeadsPerMonth: z.number().int().min(0).nullable(),
  maxAiMessagesPerMonth: z.number().int().min(0).nullable(),
  maxTeamMembers: z.number().int().min(1).nullable(),
  maxChannels: z.number().int().min(0).nullable(),
  maxBusinesses: z.number().int().min(1).nullable(),
  copilot: z.boolean(),
  advancedAnalytics: z.boolean(),
});

export async function adminRoutes(app: FastifyInstance) {
  app.get('/admin/overview', async (request) => {
    requireAdmin(request);
    const db = getDb();
    const since30 = new Date(Date.now() - 30 * 86_400_000);
    const [biz] = await db
      .select({
        total: sql<number>`count(*)::int`,
        active: sql<number>`count(*) filter (where ${businesses.status} = 'active')::int`,
        trialing: sql<number>`count(*) filter (where ${businesses.subscriptionStatus} = 'trialing')::int`,
        paying: sql<number>`count(*) filter (where ${businesses.subscriptionStatus} = 'active')::int`,
        onboarded: sql<number>`count(*) filter (where ${businesses.onboardingCompletedAt} is not null)::int`,
      })
      .from(businesses);
    const [usr] = await db.select({ total: sql<number>`count(*)::int`, active30: sql<number>`count(*) filter (where ${users.lastLoginAt} >= ${since30})::int` }).from(users);
    const [ld] = await db.select({ total: sql<number>`count(*)::int`, last30: sql<number>`count(*) filter (where ${leads.createdAt} >= ${since30})::int`, clients: sql<number>`count(*) filter (where ${leads.status} = 'client')::int` }).from(leads).where(eq(leads.isTest, false));
    const [msg] = await db
      .select({ last30: sql<number>`count(*)::int`, kai: sql<number>`count(*) filter (where ${messages.senderType} = 'kai')::int` })
      .from(messages)
      .where(gte(messages.createdAt, since30));
    const [mrr] = await db
      .select({ cents: sql<number>`coalesce(sum(${plans.priceMonthlyCents}), 0)::int` })
      .from(businesses)
      .innerJoin(plans, eq(plans.id, businesses.planId))
      .where(and(eq(businesses.status, 'active'), eq(businesses.subscriptionStatus, 'active')));
    const [jobs] = await db
      .select({ pending: sql<number>`count(*) filter (where ${scheduledJobs.status} = 'pending')::int`, failed: sql<number>`count(*) filter (where ${scheduledJobs.status} = 'failed')::int` })
      .from(scheduledJobs);
    const [errs] = await db.select({ last24: sql<number>`count(*)::int` }).from(errorLogs).where(gte(errorLogs.createdAt, new Date(Date.now() - 86_400_000)));
    return { businesses: biz, users: usr, leads: ld, messages: msg, mrrCents: mrr?.cents ?? 0, jobs, errorsLast24h: errs?.last24 ?? 0 };
  });

  app.get('/admin/businesses', async (request) => {
    requireAdmin(request);
    const q = parse(z.object({ search: z.string().max(100).optional(), limit: z.coerce.number().int().min(1).max(200).default(100) }), request.query);
    const db = getDb();
    const conds: SQL[] = [];
    if (q.search) conds.push(ilike(businesses.name, `%${q.search.replace(/[%_]/g, '')}%`));
    const rows = await db
      .select({ business: businesses, plan: plans })
      .from(businesses)
      .leftJoin(plans, eq(plans.id, businesses.planId))
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(businesses.createdAt))
      .limit(q.limit);
    const period = usagePeriod();
    const usage = await db.select().from(usageCounters).where(eq(usageCounters.period, period));
    const leadCounts = await db
      .select({ businessId: leads.businessId, n: sql<number>`count(*)::int`, last: sql<Date>`max(${leads.lastInteractionAt})` })
      .from(leads)
      .where(eq(leads.isTest, false))
      .groupBy(leads.businessId);
    const owners = await db
      .select({ businessId: memberships.businessId, name: users.name, email: users.email })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(eq(memberships.role, 'trainer'))
      .orderBy(asc(memberships.createdAt));
    return {
      businesses: rows.map(({ business: b, plan }) => {
        const { webhookSecretEnc: _s, ...safe } = b;
        return {
          ...safe,
          plan: plan ? { id: plan.id, key: plan.key, name: plan.name } : null,
          owner: owners.find((o) => o.businessId === b.id) ?? null,
          usage: Object.fromEntries(usage.filter((u) => u.businessId === b.id).map((u) => [u.metric, u.count])),
          leads: leadCounts.find((l) => l.businessId === b.id)?.n ?? 0,
          lastActivityAt: leadCounts.find((l) => l.businessId === b.id)?.last ?? null,
        };
      }),
    };
  });

  app.get('/admin/businesses/:id', async (request) => {
    requireAdmin(request);
    const { id } = parse(uuidParam, request.params);
    const db = getDb();
    const [b] = await db.select().from(businesses).where(eq(businesses.id, id)).limit(1);
    if (!b) throw notFound();
    const { webhookSecretEnc: _s, ...business } = b;
    const [members, channels, calendars, usage, errors, recentConvs] = await Promise.all([
      db.select({ userId: users.id, name: users.name, email: users.email, role: memberships.role, isActive: users.isActive }).from(memberships).innerJoin(users, eq(users.id, memberships.userId)).where(eq(memberships.businessId, id)),
      db.select({ id: channelConnections.id, channel: channelConnections.channel, status: channelConnections.status, displayName: channelConnections.displayName, lastError: channelConnections.lastError, lastEventAt: channelConnections.lastEventAt }).from(channelConnections).where(eq(channelConnections.businessId, id)),
      db.select({ id: calendarConnections.id, provider: calendarConnections.provider, status: calendarConnections.status, accountEmail: calendarConnections.accountEmail, lastError: calendarConnections.lastError }).from(calendarConnections).where(eq(calendarConnections.businessId, id)),
      db.select().from(usageCounters).where(eq(usageCounters.businessId, id)).orderBy(desc(usageCounters.period)).limit(36),
      db.select().from(errorLogs).where(eq(errorLogs.businessId, id)).orderBy(desc(errorLogs.createdAt)).limit(30),
      db
        .select({ id: conversations.id, channel: conversations.channel, preview: conversations.lastMessagePreview, lastMessageAt: conversations.lastMessageAt, leadName: leads.name, handoff: conversations.handoffActive })
        .from(conversations)
        .innerJoin(leads, eq(leads.id, conversations.leadId))
        .where(eq(conversations.businessId, id))
        .orderBy(sql`${conversations.lastMessageAt} desc nulls last`)
        .limit(20),
    ]);
    return { business, members, channels, calendars, usage, errors, conversations: recentConvs };
  });

  app.patch('/admin/businesses/:id', async (request) => {
    const admin = requireAdmin(request);
    const { id } = parse(uuidParam, request.params);
    const body = parse(
      z.object({
        status: z.enum(['active', 'suspended']).optional(),
        planId: z.string().uuid().nullable().optional(),
        subscriptionStatus: z.enum(['trialing', 'active', 'past_due', 'canceled']).optional(),
        trialEndsAt: z.coerce.date().nullable().optional(),
      }),
      request.body,
    );
    const [row] = await getDb().update(businesses).set({ ...body, updatedAt: new Date() }).where(eq(businesses.id, id)).returning({ id: businesses.id });
    if (!row) throw notFound();
    await audit({ businessId: id, actorType: 'admin', actorUserId: admin.id, action: 'admin.business_updated', entityType: 'business', entityId: id, metadata: body });
    return { ok: true };
  });

  /** Conversación completa (soporte). Queda registrado en auditoría. */
  app.get('/admin/conversations/:id', async (request) => {
    const admin = requireAdmin(request);
    const { id } = parse(uuidParam, request.params);
    const db = getDb();
    const [conv] = await db.select().from(conversations).where(eq(conversations.id, id)).limit(1);
    if (!conv) throw notFound();
    const msgs = await db.select().from(messages).where(eq(messages.conversationId, id)).orderBy(asc(messages.createdAt)).limit(500);
    await audit({ businessId: conv.businessId, actorType: 'admin', actorUserId: admin.id, action: 'admin.conversation_viewed', entityType: 'conversation', entityId: id });
    return { conversation: conv, messages: msgs };
  });

  app.get('/admin/users', async (request) => {
    requireAdmin(request);
    const q = parse(z.object({ search: z.string().max(100).optional() }), request.query);
    const db = getDb();
    const term = q.search ? `%${q.search.replace(/[%_]/g, '')}%` : null;
    const rows = await db
      .select({ id: users.id, name: users.name, email: users.email, platformRole: users.platformRole, isActive: users.isActive, lastLoginAt: users.lastLoginAt, createdAt: users.createdAt })
      .from(users)
      .where(term ? or(ilike(users.email, term), ilike(users.name, term)) : undefined)
      .orderBy(desc(users.createdAt))
      .limit(200);
    const ms = await db
      .select({ userId: memberships.userId, businessId: businesses.id, businessName: businesses.name, role: memberships.role })
      .from(memberships)
      .innerJoin(businesses, eq(businesses.id, memberships.businessId));
    return { users: rows.map((u) => ({ ...u, businesses: ms.filter((m) => m.userId === u.id) })) };
  });

  app.patch('/admin/users/:id', async (request) => {
    const admin = requireAdmin(request);
    const { id } = parse(uuidParam, request.params);
    const body = parse(z.object({ isActive: z.boolean().optional(), platformRole: z.enum(['admin', 'user']).optional() }), request.body);
    if (id === admin.id && (body.isActive === false || body.platformRole === 'user')) throw badRequest('No puedes desactivarte ni quitarte el rol de administrador a ti mismo.');
    const [row] = await getDb().update(users).set({ ...body, updatedAt: new Date() }).where(eq(users.id, id)).returning({ id: users.id });
    if (!row) throw notFound();
    if (body.isActive === false) await destroyUserSessions(id);
    await audit({ actorType: 'admin', actorUserId: admin.id, action: 'admin.user_updated', entityType: 'user', entityId: id, metadata: body });
    return { ok: true };
  });

  // ───────────── Planes (límites configurables, nunca hardcodeados) ─────────────
  app.get('/admin/plans', async (request) => {
    requireAdmin(request);
    return { plans: await getDb().select().from(plans).orderBy(asc(plans.sortOrder)) };
  });

  const PlanSchema = z.object({
    key: z.string().trim().regex(/^[a-z][a-z0-9_-]{1,30}$/),
    name: z.string().trim().min(2).max(60),
    description: z.string().trim().max(300).default(''),
    priceMonthlyCents: z.number().int().min(0).max(10_000_000),
    currency: z.string().length(3).default('EUR'),
    limits: LimitsSchema,
    isActive: z.boolean().default(true),
    isPublic: z.boolean().default(true),
    sortOrder: z.number().int().min(0).max(100).default(0),
  });

  app.post('/admin/plans', async (request) => {
    const admin = requireAdmin(request);
    const body = parse(PlanSchema, request.body);
    const [row] = await getDb().insert(plans).values(body).returning();
    await audit({ actorType: 'admin', actorUserId: admin.id, action: 'admin.plan_created', entityType: 'plan', entityId: row.id });
    return { plan: row };
  });

  app.patch('/admin/plans/:id', async (request) => {
    const admin = requireAdmin(request);
    const { id } = parse(uuidParam, request.params);
    const body = parse(PlanSchema.partial(), request.body);
    const [row] = await getDb().update(plans).set({ ...body, updatedAt: new Date() }).where(eq(plans.id, id)).returning();
    if (!row) throw notFound();
    await audit({ actorType: 'admin', actorUserId: admin.id, action: 'admin.plan_updated', entityType: 'plan', entityId: id, metadata: body });
    return { plan: row };
  });

  // ───────────── Errores, auditoría, integraciones y cola ─────────────
  app.get('/admin/errors', async (request) => {
    requireAdmin(request);
    const q = parse(z.object({ source: z.string().max(80).optional(), businessId: z.string().uuid().optional() }), request.query);
    const conds: SQL[] = [];
    if (q.source) conds.push(ilike(errorLogs.source, `${q.source.replace(/[%_]/g, '')}%`));
    if (q.businessId) conds.push(eq(errorLogs.businessId, q.businessId));
    const rows = await getDb()
      .select({ error: errorLogs, businessName: businesses.name })
      .from(errorLogs)
      .leftJoin(businesses, eq(businesses.id, errorLogs.businessId))
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(errorLogs.createdAt))
      .limit(200);
    return { errors: rows };
  });

  app.get('/admin/audit', async (request) => {
    requireAdmin(request);
    const q = parse(z.object({ businessId: z.string().uuid().optional(), action: z.string().max(80).optional(), actorType: z.enum(['user', 'kai', 'system', 'integration', 'admin']).optional() }), request.query);
    const conds: SQL[] = [];
    if (q.businessId) conds.push(eq(auditLogs.businessId, q.businessId));
    if (q.action) conds.push(ilike(auditLogs.action, `${q.action.replace(/[%_]/g, '')}%`));
    if (q.actorType) conds.push(eq(auditLogs.actorType, q.actorType));
    const rows = await getDb()
      .select({ log: auditLogs, businessName: businesses.name, userEmail: users.email })
      .from(auditLogs)
      .leftJoin(businesses, eq(businesses.id, auditLogs.businessId))
      .leftJoin(users, eq(users.id, auditLogs.actorUserId))
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(auditLogs.createdAt))
      .limit(300);
    return { logs: rows };
  });

  app.get('/admin/integrations', async (request) => {
    requireAdmin(request);
    const db = getDb();
    const channels = await db
      .select({ id: channelConnections.id, businessName: businesses.name, channel: channelConnections.channel, status: channelConnections.status, displayName: channelConnections.displayName, lastError: channelConnections.lastError, lastEventAt: channelConnections.lastEventAt })
      .from(channelConnections)
      .innerJoin(businesses, eq(businesses.id, channelConnections.businessId))
      .orderBy(desc(channelConnections.updatedAt));
    const calendars = await db
      .select({ id: calendarConnections.id, businessName: businesses.name, provider: calendarConnections.provider, status: calendarConnections.status, accountEmail: calendarConnections.accountEmail, lastError: calendarConnections.lastError })
      .from(calendarConnections)
      .innerJoin(businesses, eq(businesses.id, calendarConnections.businessId))
      .orderBy(desc(calendarConnections.updatedAt));
    return { channels, calendars };
  });

  app.get('/admin/jobs', async (request) => {
    requireAdmin(request);
    const db = getDb();
    const stats = await db.select({ type: scheduledJobs.type, status: scheduledJobs.status, n: sql<number>`count(*)::int` }).from(scheduledJobs).groupBy(scheduledJobs.type, scheduledJobs.status);
    const failed = await db.select().from(scheduledJobs).where(eq(scheduledJobs.status, 'failed')).orderBy(desc(scheduledJobs.finishedAt)).limit(50);
    return { stats, failed };
  });

  app.post('/admin/jobs/:id/retry', async (request) => {
    const admin = requireAdmin(request);
    const { id } = parse(uuidParam, request.params);
    await getDb().update(scheduledJobs).set({ status: 'pending', runAt: new Date(), attempts: 0, lastError: null }).where(and(eq(scheduledJobs.id, id), eq(scheduledJobs.status, 'failed')));
    await audit({ actorType: 'admin', actorUserId: admin.id, action: 'admin.job_retried', entityType: 'job', entityId: id });
    return { ok: true };
  });
}
