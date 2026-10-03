import type { FastifyInstance } from 'fastify';
import { and, asc, eq, notInArray } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../database/client.js';
import {
  aiSettings,
  automations,
  businesses,
  invitations,
  leads,
  memberships,
  objections,
  plans,
  qualificationRules,
  services,
  trainers,
  users,
} from '../database/schema.js';
import { parse, uuidParam, timezoneSchema } from '../lib/http.js';
import { badRequest, forbidden, notFound } from '../lib/errors.js';
import { requireTenant } from '../auth/guards.js';
import { audit } from '../audit/audit.service.js';
import { STANDARD_QUALIFICATION_KEYS, type AutomationType } from '../lib/domain.js';
import { temperatureFor, validateBands } from '../crm/scoring.js';
import { recomputeLeadScore } from '../crm/leads.service.js';
import { getLimits, getUsage, countSeats, countChannels } from '../plans/plans.service.js';
import { inviteMember } from '../auth/auth.service.js';
import { getAvailabilityConfig } from '../calendar/calendar.service.js';
import { previewSetterMessage } from '../ai/setter/preview.js';
import { aiModeInfo } from '../ai/providers/index.js';

const level = z.number().int().min(1).max(5);
export const ToneSchema = z.object({
  formality: level,
  energy: level,
  directness: level,
  emojiUsage: z.enum(['none', 'low', 'medium', 'high']),
  messageLength: z.enum(['short', 'medium', 'long']),
  addressing: z.enum(['tu', 'usted']),
});

export const AiSettingsSchema = z.object({
  autopilotEnabled: z.boolean(),
  assistantName: z.string().trim().min(1).max(40),
  persona: z.enum(['team_member', 'trainer']),
  disclosureMode: z.enum(['first_message', 'on_request']),
  tone: ToneSchema,
  wordsToUse: z.array(z.string().trim().min(1).max(40)).max(50),
  wordsToAvoid: z.array(z.string().trim().min(1).max(40)).max(100),
  examplesWhatsapp: z.string().max(6000),
  examplesInstagram: z.string().max(6000),
  examplesOther: z.string().max(6000),
  extraInstructions: z.string().max(3000),
  pricePolicy: z.enum(['contextualize_first', 'share_directly']),
  callLabel: z.string().trim().min(3).max(60),
  callDurationMinutes: z.number().int().min(10).max(120),
  callDescription: z.string().max(500),
  proposeCallMinScore: z.number().int().min(0).max(100),
  handoffRules: z.object({
    angry: z.boolean(),
    medical: z.boolean(),
    humanRequest: z.boolean(),
    complexNegotiation: z.boolean(),
    outOfScope: z.boolean(),
    technicalIssue: z.boolean(),
    handoffMessage: z.string().max(500),
  }),
  replyDelayMinSeconds: z.number().int().min(0).max(3600),
  replyDelayMaxSeconds: z.number().int().min(0).max(3600),
});

const TrainerSchema = z.object({
  displayName: z.string().trim().max(80),
  specialty: z.string().trim().max(200),
  idealClient: z.string().trim().max(1000),
  transformation: z.string().trim().max(1000),
  methodName: z.string().trim().max(80),
  methodDescription: z.string().trim().max(2000),
  modality: z.enum(['online', 'presencial', 'hibrido']),
  credentials: z.string().trim().max(1000),
});

const ServiceSchema = z.object({
  name: z.string().trim().min(2).max(120),
  description: z.string().trim().max(1000).default(''),
  priceCents: z.number().int().min(0).max(100_000_000),
  currency: z.string().length(3).default('EUR'),
  billingPeriod: z.enum(['one_time', 'monthly', 'quarterly', 'semiannual', 'annual']),
  durationWeeks: z.number().int().min(1).max(520).nullable().optional(),
  includes: z.array(z.string().trim().min(1).max(120)).max(15).default([]),
  isPrimary: z.boolean().default(false),
  isActive: z.boolean().default(true),
});

const RuleSchema = z.object({
  key: z.string().trim().regex(/^[a-z][a-z0-9_]{1,40}$/, 'Clave en minúsculas y sin espacios'),
  label: z.string().trim().min(2).max(60),
  description: z.string().trim().max(300).default(''),
  question: z.string().trim().max(300).default(''),
  weight: z.number().int().min(0).max(50),
  required: z.boolean(),
  enabled: z.boolean(),
  disqualifyWhen: z.string().trim().max(300).default(''),
});

const ObjectionSchema = z.object({
  key: z.string().trim().regex(/^[a-z][a-z0-9_]{1,40}$/),
  label: z.string().trim().min(2).max(80),
  triggers: z.array(z.string().trim().min(2).max(60)).max(20),
  strategy: z.string().trim().max(1500),
  exampleResponse: z.string().trim().max(700),
  enabled: z.boolean(),
});

const StepSchema = z.object({ delayHours: z.number().min(0.25).max(24 * 30), angle: z.string().trim().min(3).max(300) });
const QuietSchema = z.object({ start: z.string().regex(/^\d{2}:\d{2}$/), end: z.string().regex(/^\d{2}:\d{2}$/) });
const AutomationConfigSchema = z.object({
  steps: z.array(StepSchema).max(6).optional(),
  quietHours: QuietSchema.optional(),
  confirmation: z.boolean().optional(),
  reminder24h: z.boolean().optional(),
  reminder1h: z.boolean().optional(),
  delayMinutes: z.number().int().min(0).max(24 * 60).optional(),
});

export async function settingsRoutes(app: FastifyInstance) {
  app.get('/settings', async (request) => {
    const ctx = await requireTenant(request, 'settings:read');
    const db = getDb();
    const b = ctx.businessId;
    const [[business], [trainer], [ai], svc, rules, objs, autos, availability, limits, usage] = await Promise.all([
      db.select().from(businesses).where(eq(businesses.id, b)).limit(1),
      db.select().from(trainers).where(eq(trainers.businessId, b)).limit(1),
      db.select().from(aiSettings).where(eq(aiSettings.businessId, b)).limit(1),
      db.select().from(services).where(eq(services.businessId, b)).orderBy(asc(services.createdAt)),
      db.select().from(qualificationRules).where(eq(qualificationRules.businessId, b)).orderBy(asc(qualificationRules.sortOrder)),
      db.select().from(objections).where(eq(objections.businessId, b)).orderBy(asc(objections.sortOrder)),
      db.select().from(automations).where(eq(automations.businessId, b)),
      getAvailabilityConfig(b),
      getLimits(b),
      getUsage(b),
    ]);
    const { webhookSecretEnc: _secret, ...safeBusiness } = business;
    return { business: safeBusiness, trainer, aiSettings: ai, services: svc, qualificationRules: rules, objections: objs, automations: autos, availability, limits, usage, ai: aiModeInfo() };
  });

  app.put('/settings/business', async (request) => {
    const ctx = await requireTenant(request, 'settings:write');
    const body = parse(
      z.object({
        name: z.string().trim().min(2).max(120),
        timezone: timezoneSchema,
        currency: z.string().length(3),
        monthlyAdSpendCents: z.number().int().min(0).max(100_000_000),
      }),
      request.body,
    );
    await getDb().update(businesses).set({ ...body, updatedAt: new Date() }).where(eq(businesses.id, ctx.businessId));
    await audit({ businessId: ctx.businessId, actorType: 'user', actorUserId: ctx.userId, action: 'settings.business_updated' });
    return { ok: true };
  });

  app.put('/settings/trainer', async (request) => {
    const ctx = await requireTenant(request, 'settings:write');
    const body = parse(TrainerSchema.partial(), request.body);
    await getDb().update(trainers).set({ ...body, updatedAt: new Date() }).where(eq(trainers.businessId, ctx.businessId));
    await audit({ businessId: ctx.businessId, actorType: 'user', actorUserId: ctx.userId, action: 'settings.trainer_updated', metadata: { fields: Object.keys(body) } });
    return { ok: true };
  });

  app.put('/settings/ai', async (request) => {
    const ctx = await requireTenant(request, 'settings:write');
    const body = parse(AiSettingsSchema.partial(), request.body);
    if (body.replyDelayMinSeconds !== undefined && body.replyDelayMaxSeconds !== undefined && body.replyDelayMinSeconds > body.replyDelayMaxSeconds)
      throw badRequest('El retardo mínimo no puede ser mayor que el máximo.');
    await getDb().update(aiSettings).set({ ...body, updatedAt: new Date() }).where(eq(aiSettings.businessId, ctx.businessId));
    await audit({ businessId: ctx.businessId, actorType: 'user', actorUserId: ctx.userId, action: 'settings.ai_updated', metadata: { fields: Object.keys(body) } });
    return { ok: true };
  });

  app.post('/settings/ai/preview', async (request) => {
    const ctx = await requireTenant(request, 'settings:read');
    const body = parse(
      z.object({
        leadMessage: z.string().trim().min(1).max(500).default('Hola! Vi tu anuncio, quiero perder grasa'),
        /** Cambios todavía sin guardar: permiten ver cómo sonaría KAI antes de guardarlos. */
        overrides: AiSettingsSchema.partial().optional(),
      }),
      request.body ?? {},
    );
    return previewSetterMessage(ctx.businessId, body.leadMessage, body.overrides);
  });

  app.put('/settings/score-bands', async (request) => {
    const ctx = await requireTenant(request, 'settings:write');
    const body = parse(
      z.object({
        bands: z.array(z.object({ key: z.enum(['frio', 'curioso', 'interesado', 'caliente', 'muy_cualificado']), label: z.string().trim().min(2).max(40), min: z.number().int().min(0).max(100), max: z.number().int().min(0).max(100) })).length(5),
      }),
      request.body,
    );
    const err = validateBands(body.bands);
    if (err) throw badRequest(err);
    const db = getDb();
    await db.update(aiSettings).set({ scoreBands: body.bands, updatedAt: new Date() }).where(eq(aiSettings.businessId, ctx.businessId));
    // Reetiquetar la temperatura de los leads con las nuevas bandas.
    const all = await db.select({ id: leads.id, score: leads.score, temperature: leads.temperature }).from(leads).where(eq(leads.businessId, ctx.businessId));
    for (const l of all) {
      const t = temperatureFor(l.score, body.bands);
      if (t !== l.temperature) await db.update(leads).set({ temperature: t }).where(eq(leads.id, l.id));
    }
    await audit({ businessId: ctx.businessId, actorType: 'user', actorUserId: ctx.userId, action: 'settings.score_bands_updated' });
    return { ok: true };
  });

  app.put('/settings/qualification', async (request) => {
    const ctx = await requireTenant(request, 'settings:write');
    const body = parse(z.object({ rules: z.array(RuleSchema).min(1).max(25) }), request.body);
    const keys = body.rules.map((r) => r.key);
    if (new Set(keys).size !== keys.length) throw badRequest('Hay variables de cualificación repetidas.');
    if (!body.rules.some((r) => r.enabled && r.weight > 0)) throw badRequest('Activa al menos una variable con peso mayor que 0.');
    const db = getDb();
    await db.transaction(async (tx) => {
      // Las variables estándar no se borran (solo se desactivan); las personalizadas sí.
      await tx
        .delete(qualificationRules)
        .where(and(eq(qualificationRules.businessId, ctx.businessId), notInArray(qualificationRules.key, [...keys, ...STANDARD_QUALIFICATION_KEYS])));
      for (const [i, r] of body.rules.entries()) {
        await tx
          .insert(qualificationRules)
          .values({ businessId: ctx.businessId, ...r, sortOrder: i })
          .onConflictDoUpdate({ target: [qualificationRules.businessId, qualificationRules.key], set: { ...r, sortOrder: i, updatedAt: new Date() } });
      }
    });
    await audit({ businessId: ctx.businessId, actorType: 'user', actorUserId: ctx.userId, action: 'settings.qualification_updated' });
    return { ok: true };
  });

  app.post('/settings/rescore-all', async (request) => {
    const ctx = await requireTenant(request, 'settings:write');
    const all = await getDb()
      .select({ id: leads.id })
      .from(leads)
      .where(and(eq(leads.businessId, ctx.businessId), notInArray(leads.status, ['client', 'lost'])))
      .limit(2000);
    for (const l of all) await recomputeLeadScore(ctx.businessId, l.id);
    return { ok: true, rescored: all.length };
  });

  app.put('/settings/objections', async (request) => {
    const ctx = await requireTenant(request, 'settings:write');
    const body = parse(z.object({ objections: z.array(ObjectionSchema).max(40) }), request.body);
    const keys = body.objections.map((o) => o.key);
    if (new Set(keys).size !== keys.length) throw badRequest('Hay objeciones con la misma clave.');
    await getDb().transaction(async (tx) => {
      await tx.delete(objections).where(and(eq(objections.businessId, ctx.businessId), keys.length ? notInArray(objections.key, keys) : undefined));
      for (const [i, o] of body.objections.entries()) {
        await tx
          .insert(objections)
          .values({ businessId: ctx.businessId, ...o, sortOrder: i })
          .onConflictDoUpdate({ target: [objections.businessId, objections.key], set: { ...o, sortOrder: i, updatedAt: new Date() } });
      }
    });
    await audit({ businessId: ctx.businessId, actorType: 'user', actorUserId: ctx.userId, action: 'settings.objections_updated' });
    return { ok: true };
  });

  // ───────────── Servicios y precio ─────────────
  app.post('/settings/services', async (request) => {
    const ctx = await requireTenant(request, 'settings:write');
    const body = parse(ServiceSchema, request.body);
    const db = getDb();
    const existing = await db.select({ id: services.id }).from(services).where(eq(services.businessId, ctx.businessId));
    const isPrimary = body.isPrimary || existing.length === 0;
    if (isPrimary) await db.update(services).set({ isPrimary: false }).where(eq(services.businessId, ctx.businessId));
    const [row] = await db.insert(services).values({ businessId: ctx.businessId, ...body, isPrimary }).returning();
    await audit({ businessId: ctx.businessId, actorType: 'user', actorUserId: ctx.userId, action: 'settings.service_created', entityType: 'service', entityId: row.id });
    return { service: row };
  });

  /** Crea o actualiza el servicio principal (usado por el onboarding). */
  app.put('/settings/primary-service', async (request) => {
    const ctx = await requireTenant(request, 'settings:write');
    const body = parse(ServiceSchema.partial().extend({ name: z.string().trim().min(2).max(120) }), request.body);
    const db = getDb();
    const [primary] = await db
      .select()
      .from(services)
      .where(and(eq(services.businessId, ctx.businessId), eq(services.isPrimary, true)))
      .limit(1);
    const [row] = primary
      ? await db.update(services).set({ ...body, updatedAt: new Date() }).where(eq(services.id, primary.id)).returning()
      : await db.insert(services).values({ businessId: ctx.businessId, billingPeriod: 'monthly', priceCents: 0, ...body, isPrimary: true }).returning();
    await audit({ businessId: ctx.businessId, actorType: 'user', actorUserId: ctx.userId, action: 'settings.primary_service_updated', entityType: 'service', entityId: row.id, metadata: { priceCents: row.priceCents, name: row.name } });
    return { service: row };
  });

  app.patch('/settings/services/:id', async (request) => {
    const ctx = await requireTenant(request, 'settings:write');
    const { id } = parse(uuidParam, request.params);
    const body = parse(ServiceSchema.partial(), request.body);
    const db = getDb();
    if (body.isPrimary) await db.update(services).set({ isPrimary: false }).where(eq(services.businessId, ctx.businessId));
    const [row] = await db
      .update(services)
      .set({ ...body, updatedAt: new Date() })
      .where(and(eq(services.businessId, ctx.businessId), eq(services.id, id)))
      .returning();
    if (!row) throw notFound('Servicio no encontrado.');
    await audit({ businessId: ctx.businessId, actorType: 'user', actorUserId: ctx.userId, action: 'settings.service_updated', entityType: 'service', entityId: id });
    return { service: row };
  });

  app.delete('/settings/services/:id', async (request) => {
    const ctx = await requireTenant(request, 'settings:write');
    const { id } = parse(uuidParam, request.params);
    await getDb()
      .delete(services)
      .where(and(eq(services.businessId, ctx.businessId), eq(services.id, id)));
    await audit({ businessId: ctx.businessId, actorType: 'user', actorUserId: ctx.userId, action: 'settings.service_deleted', entityType: 'service', entityId: id });
    return { ok: true };
  });

  // ───────────── Automatizaciones ─────────────
  app.put('/settings/automations/:type', async (request) => {
    const ctx = await requireTenant(request, 'automations:manage');
    const { type } = parse(z.object({ type: z.enum(['followup_no_reply', 'appointment_reminders', 'no_show_recovery', 'post_call']) }), request.params);
    const body = parse(z.object({ enabled: z.boolean(), config: AutomationConfigSchema }), request.body);
    await getDb()
      .update(automations)
      .set({ enabled: body.enabled, config: body.config, updatedAt: new Date() })
      .where(and(eq(automations.businessId, ctx.businessId), eq(automations.type, type as AutomationType)));
    await audit({ businessId: ctx.businessId, actorType: 'user', actorUserId: ctx.userId, action: 'automation.updated', metadata: { type, enabled: body.enabled } });
    return { ok: true };
  });

  // ───────────── Plan y uso ─────────────
  app.get('/settings/plan', async (request) => {
    const ctx = await requireTenant(request, 'settings:read');
    const db = getDb();
    const [row] = await db.select({ business: businesses, plan: plans }).from(businesses).leftJoin(plans, eq(plans.id, businesses.planId)).where(eq(businesses.id, ctx.businessId)).limit(1);
    const available = await db.select().from(plans).where(and(eq(plans.isActive, true), eq(plans.isPublic, true))).orderBy(asc(plans.sortOrder));
    return {
      plan: row?.plan ?? null,
      subscriptionStatus: row?.business.subscriptionStatus,
      trialEndsAt: row?.business.trialEndsAt,
      limits: await getLimits(ctx.businessId),
      usage: await getUsage(ctx.businessId),
      seats: await countSeats(ctx.businessId),
      channels: await countChannels(ctx.businessId),
      availablePlans: available,
    };
  });

  // ───────────── Equipo ─────────────
  app.get('/team', async (request) => {
    const ctx = await requireTenant(request, 'settings:read');
    const db = getDb();
    const members = await db
      .select({ userId: users.id, name: users.name, email: users.email, role: memberships.role, joinedAt: memberships.createdAt, lastLoginAt: users.lastLoginAt })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(eq(memberships.businessId, ctx.businessId));
    const invites = await db
      .select({ id: invitations.id, email: invitations.email, role: invitations.role, expiresAt: invitations.expiresAt, acceptedAt: invitations.acceptedAt })
      .from(invitations)
      .where(eq(invitations.businessId, ctx.businessId));
    return { members, invitations: invites.filter((i) => !i.acceptedAt && i.expiresAt > new Date()) };
  });

  app.post('/team/invite', async (request) => {
    const ctx = await requireTenant(request, 'team:manage');
    const body = parse(z.object({ email: z.string().trim().email().max(200), role: z.enum(['trainer', 'team_member']).default('team_member') }), request.body);
    const { invitation, link, emailed } = await inviteMember(ctx.businessId, ctx.userId, body.email, body.role);
    return { invitation: { id: invitation.id, email: invitation.email, role: invitation.role, expiresAt: invitation.expiresAt }, link, emailed };
  });

  app.delete('/team/invitations/:id', async (request) => {
    const ctx = await requireTenant(request, 'team:manage');
    const { id } = parse(uuidParam, request.params);
    await getDb()
      .delete(invitations)
      .where(and(eq(invitations.businessId, ctx.businessId), eq(invitations.id, id)));
    return { ok: true };
  });

  app.patch('/team/members/:id', async (request) => {
    const ctx = await requireTenant(request, 'team:manage');
    const { id } = parse(uuidParam, request.params);
    const body = parse(z.object({ role: z.enum(['trainer', 'team_member']) }), request.body);
    if (id === ctx.userId) throw forbidden('No puedes cambiar tu propio rol.');
    await getDb()
      .update(memberships)
      .set({ role: body.role })
      .where(and(eq(memberships.businessId, ctx.businessId), eq(memberships.userId, id)));
    await audit({ businessId: ctx.businessId, actorType: 'user', actorUserId: ctx.userId, action: 'team.role_changed', entityType: 'user', entityId: id, metadata: body });
    return { ok: true };
  });

  app.delete('/team/members/:id', async (request) => {
    const ctx = await requireTenant(request, 'team:manage');
    const { id } = parse(uuidParam, request.params);
    if (id === ctx.userId) throw forbidden('No puedes eliminarte a ti mismo del equipo.');
    const db = getDb();
    const trainersLeft = await db
      .select({ userId: memberships.userId })
      .from(memberships)
      .where(and(eq(memberships.businessId, ctx.businessId), eq(memberships.role, 'trainer')));
    if (trainersLeft.length <= 1 && trainersLeft[0]?.userId === id) throw forbidden('El negocio debe tener al menos un entrenador.');
    await db.delete(memberships).where(and(eq(memberships.businessId, ctx.businessId), eq(memberships.userId, id)));
    await audit({ businessId: ctx.businessId, actorType: 'user', actorUserId: ctx.userId, action: 'team.member_removed', entityType: 'user', entityId: id });
    return { ok: true };
  });

  // ───────────── Onboarding ─────────────
  app.put('/onboarding/progress', async (request) => {
    const ctx = await requireTenant(request, 'settings:write');
    const body = parse(z.object({ step: z.number().int().min(1).max(15) }), request.body);
    const db = getDb();
    const [b] = await db.select({ step: businesses.onboardingStep }).from(businesses).where(eq(businesses.id, ctx.businessId)).limit(1);
    if (body.step > (b?.step ?? 1)) await db.update(businesses).set({ onboardingStep: body.step, updatedAt: new Date() }).where(eq(businesses.id, ctx.businessId));
    return { ok: true };
  });

  app.post('/onboarding/complete', async (request) => {
    const ctx = await requireTenant(request, 'settings:write');
    const db = getDb();
    const [primary] = await db.select({ id: services.id }).from(services).where(and(eq(services.businessId, ctx.businessId), eq(services.isActive, true))).limit(1);
    const [trainer] = await db.select().from(trainers).where(eq(trainers.businessId, ctx.businessId)).limit(1);
    const missing: string[] = [];
    if (!trainer?.displayName) missing.push('nombre del entrenador');
    if (!primary) missing.push('servicio');
    if (missing.length) throw badRequest(`Completa antes: ${missing.join(', ')}.`);
    await db.update(businesses).set({ onboardingCompletedAt: new Date(), onboardingStep: 15, updatedAt: new Date() }).where(eq(businesses.id, ctx.businessId));
    await audit({ businessId: ctx.businessId, actorType: 'user', actorUserId: ctx.userId, action: 'onboarding.completed' });
    return { ok: true, message: 'KAI ya está listo para trabajar.' };
  });

}
