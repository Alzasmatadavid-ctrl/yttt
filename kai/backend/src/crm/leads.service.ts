import { and, asc, desc, eq, gte, ilike, inArray, lt, or, sql, type SQL } from 'drizzle-orm';
import { getDb } from '../database/client.js';
import {
  aiSettings,
  appointments,
  conversations,
  leadEvents,
  leadMemories,
  leads,
  memberships,
  qualificationRules,
  scheduledJobs,
  followUps,
} from '../database/schema.js';
import {
  CLOSED_STATUSES,
  OVER_LIMIT_TAG,
  DEFAULT_SCORE_BANDS,
  type LeadQualification,
  type LeadSignals,
  type LeadSource,
  type LeadStatus,
  type LeadTemperature,
} from '../lib/domain.js';
import { badRequest, notFound } from '../lib/errors.js';
import { audit } from '../audit/audit.service.js';
import { incrementUsage, checkUsageLimit } from '../plans/plans.service.js';
import { bandMin, computeScore, requiredCaptured, temperatureFor } from './scoring.js';
import { nextStatus, type PipelineEvent } from './pipeline.js';
import { createAlert } from './alerts.service.js';

export type Lead = typeof leads.$inferSelect;
export type ActorType = 'user' | 'kai' | 'system' | 'integration' | 'lead';
export interface Actor {
  type: ActorType;
  userId?: string | null;
}

const eventActor = (a: Actor) => (a.type === 'user' ? 'human' : a.type) as 'kai' | 'human' | 'system' | 'lead' | 'integration';

export async function recordLeadEvent(businessId: string, leadId: string, type: string, actor: Actor, data: Record<string, unknown> = {}) {
  await getDb()
    .insert(leadEvents)
    .values({ businessId, leadId, type, actorType: eventActor(actor), actorUserId: actor.userId ?? null, data });
}

export interface CreateLeadInput {
  name?: string;
  phone?: string | null;
  email?: string | null;
  instagramUsername?: string | null;
  instagramUserId?: string | null;
  whatsappId?: string | null;
  avatarUrl?: string | null;
  source: LeadSource;
  sourceDetail?: string | null;
  notes?: string;
  goal?: string | null;
  isTest?: boolean;
}

export function normalizePhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const digits = phone.replace(/[^\d+]/g, '');
  if (digits.replace(/\D/g, '').length < 7) return null;
  return digits.startsWith('+') ? digits : digits.startsWith('00') ? `+${digits.slice(2)}` : digits;
}

/** Busca un lead existente por cualquiera de sus identificadores (evita duplicados entre canales). */
export async function findExistingLead(businessId: string, input: Partial<CreateLeadInput>): Promise<Lead | null> {
  const conds: SQL[] = [];
  if (input.whatsappId) conds.push(eq(leads.whatsappId, input.whatsappId));
  if (input.instagramUserId) conds.push(eq(leads.instagramUserId, input.instagramUserId));
  if (input.email) conds.push(eq(leads.email, input.email.trim().toLowerCase()));
  const phone = normalizePhone(input.phone);
  if (phone) {
    conds.push(eq(leads.phone, phone));
    // Mismo número con o sin prefijo de país (+34600111222 ≈ 600111222).
    const tail = phone.replace(/\D/g, '').slice(-9);
    if (tail.length === 9) conds.push(sql`right(regexp_replace(coalesce(${leads.phone}, ''), '[^0-9]', '', 'g'), 9) = ${tail}`);
  }
  if (conds.length === 0) return null;
  const [row] = await getDb()
    .select()
    .from(leads)
    .where(and(eq(leads.businessId, businessId), or(...conds)))
    .orderBy(asc(leads.createdAt))
    .limit(1);
  return row ?? null;
}

/** Completa en un lead existente los datos que le falten, sin sobrescribir los que ya tiene. */
async function completeExistingLead(businessId: string, existing: Lead, input: CreateLeadInput): Promise<Lead> {
  const patch: Partial<Lead> = {};
  if (!existing.name && input.name) patch.name = input.name;
  if (!existing.email && input.email) patch.email = input.email.trim().toLowerCase();
  if (!existing.phone && input.phone) patch.phone = normalizePhone(input.phone);
  if (!existing.whatsappId && input.whatsappId) patch.whatsappId = input.whatsappId;
  if (!existing.instagramUserId && input.instagramUserId) patch.instagramUserId = input.instagramUserId;
  if (!existing.instagramUsername && input.instagramUsername) patch.instagramUsername = input.instagramUsername;
  if (!existing.avatarUrl && input.avatarUrl) patch.avatarUrl = input.avatarUrl;
  if (Object.keys(patch).length === 0) return existing;
  try {
    const [updated] = await getDb()
      .update(leads)
      .set({ ...patch, updatedAt: new Date() })
      .where(and(eq(leads.businessId, businessId), eq(leads.id, existing.id)))
      .returning();
    return updated ?? existing;
  } catch (err) {
    // Otro lead ya tiene ese WhatsApp/Instagram (índice único): se conserva el lead tal cual.
    if (isUniqueViolation(err)) return existing;
    throw err;
  }
}

/** Error de PostgreSQL por índice único (23505), venga directo o envuelto por Drizzle. */
export function isUniqueViolation(err: unknown): boolean {
  for (let e = err as { code?: string; cause?: unknown } | undefined, i = 0; e && i < 5; e = e.cause as typeof e, i++) {
    if (e.code === '23505') return true;
  }
  return false;
}

export async function createLead(businessId: string, input: CreateLeadInput, actor: Actor): Promise<{ lead: Lead; created: boolean }> {
  const existing = await findExistingLead(businessId, input);
  if (existing) return { lead: await completeExistingLead(businessId, existing, input), created: false };

  const usage = await checkUsageLimit(businessId, 'leads');
  const qualification: LeadQualification = {};
  if (input.goal) qualification.goal = { value: input.goal.slice(0, 500), confidence: 0.8, updatedAt: new Date().toISOString() };
  // ON CONFLICT DO NOTHING: si llegan a la vez varios mensajes de un contacto nuevo (webhooks en paralelo),
  // solo uno crea el lead; los demás lo encuentran justo después y siguen con él (no se pierde ningún mensaje).
  const [lead] = await getDb()
    .insert(leads)
    .values({
      businessId,
      name: input.name?.trim() ?? '',
      phone: normalizePhone(input.phone),
      email: input.email?.trim().toLowerCase() || null,
      instagramUsername: input.instagramUsername ?? null,
      instagramUserId: input.instagramUserId ?? null,
      whatsappId: input.whatsappId ?? null,
      avatarUrl: input.avatarUrl ?? null,
      source: input.source,
      sourceDetail: input.sourceDetail ?? null,
      notes: input.notes ?? '',
      goalSummary: input.goal?.slice(0, 160) ?? null,
      qualification,
      tags: !usage.allowed && !input.isTest ? [OVER_LIMIT_TAG] : [],
      isTest: input.isTest ?? false,
      lastInteractionAt: new Date(),
    })
    .onConflictDoNothing()
    .returning();
  if (!lead) {
    const winner = await findExistingLead(businessId, input);
    if (!winner) throw new Error('No se pudo crear ni encontrar el lead tras un conflicto de duplicados.');
    return { lead: await completeExistingLead(businessId, winner, input), created: false };
  }
  if (!input.isTest) await incrementUsage(businessId, 'leads');
  await recordLeadEvent(businessId, lead.id, 'created', actor, { source: input.source, sourceDetail: input.sourceDetail });
  if (!usage.allowed && !input.isTest) {
    // Nunca se pierde un lead: se guarda, pero KAI no responde automáticamente.
    await createAlert({
      businessId,
      type: 'limit_reached',
      severity: 'critical',
      title: 'Has alcanzado el límite de leads de tu plan',
      body: `Este lead se ha guardado, pero KAI no responderá automáticamente hasta que amplíes el plan (${usage.used}/${usage.limit}).`,
      leadId: lead.id,
    });
  }
  return { lead, created: true };
}

export async function getLead(businessId: string, leadId: string): Promise<Lead> {
  const [row] = await getDb()
    .select()
    .from(leads)
    .where(and(eq(leads.businessId, businessId), eq(leads.id, leadId)))
    .limit(1);
  if (!row) throw notFound('Lead no encontrado.');
  return row;
}

export interface LeadFilters {
  status?: LeadStatus[];
  temperature?: LeadTemperature[];
  source?: LeadSource[];
  minScore?: number;
  search?: string;
  noReplyHours?: number;
  createdFrom?: Date;
  createdTo?: Date;
  includeTest?: boolean;
  sort?: 'score' | 'recent' | 'created' | 'oldest_reply';
  limit?: number;
  offset?: number;
}

export function leadFilterConditions(businessId: string, f: LeadFilters): SQL[] {
  const conds: SQL[] = [eq(leads.businessId, businessId)];
  if (!f.includeTest) conds.push(eq(leads.isTest, false));
  if (f.status?.length) conds.push(inArray(leads.status, f.status));
  if (f.temperature?.length) conds.push(inArray(leads.temperature, f.temperature));
  if (f.source?.length) conds.push(inArray(leads.source, f.source));
  if (f.minScore !== undefined) conds.push(gte(leads.score, f.minScore));
  if (f.createdFrom) conds.push(gte(leads.createdAt, f.createdFrom));
  if (f.createdTo) conds.push(lt(leads.createdAt, f.createdTo));
  if (f.noReplyHours !== undefined) {
    // El último mensaje fue nuestro y el lead lleva X horas sin contestar.
    const cutoff = new Date(Date.now() - f.noReplyHours * 3600_000);
    conds.push(sql`${leads.lastOutboundAt} is not null and ${leads.lastOutboundAt} < ${cutoff}`);
    conds.push(sql`(${leads.lastInboundAt} is null or ${leads.lastInboundAt} < ${leads.lastOutboundAt})`);
  }
  if (f.search?.trim()) {
    const q = `%${f.search.trim().replace(/[%_]/g, '')}%`;
    conds.push(
      or(ilike(leads.name, q), ilike(leads.email, q), ilike(leads.phone, q), ilike(leads.instagramUsername, q), ilike(leads.goalSummary, q))!,
    );
  }
  return conds;
}

export async function listLeads(businessId: string, f: LeadFilters = {}) {
  const order =
    f.sort === 'score'
      ? [desc(leads.score), desc(leads.lastInteractionAt)]
      : f.sort === 'created'
        ? [desc(leads.createdAt)]
        : f.sort === 'oldest_reply'
          ? [asc(leads.lastOutboundAt)]
          : [sql`${leads.lastInteractionAt} desc nulls last`];
  return getDb()
    .select()
    .from(leads)
    .where(and(...leadFilterConditions(businessId, f)))
    .orderBy(...order)
    .limit(Math.min(f.limit ?? 100, 500))
    .offset(f.offset ?? 0);
}

export interface UpdateLeadInput {
  name?: string;
  phone?: string | null;
  email?: string | null;
  instagramUsername?: string | null;
  notes?: string;
  tags?: string[];
  goalSummary?: string | null;
  nextAction?: string | null;
  nextActionAt?: Date | null;
  assignedUserId?: string | null;
  dealValueCents?: number | null;
}

export async function updateLead(businessId: string, leadId: string, patch: UpdateLeadInput, actor: Actor) {
  const current = await getLead(businessId, leadId);
  if (patch.assignedUserId) {
    // Solo se puede asignar a personas del equipo de ESTE negocio.
    const [member] = await getDb()
      .select({ id: memberships.id })
      .from(memberships)
      .where(and(eq(memberships.businessId, businessId), eq(memberships.userId, patch.assignedUserId)))
      .limit(1);
    if (!member) throw badRequest('Esa persona no forma parte del equipo de este negocio.');
  }
  if (patch.tags !== undefined && current.tags.includes(OVER_LIMIT_TAG) && !patch.tags.includes(OVER_LIMIT_TAG)) {
    // La etiqueta de “fuera de límite” no se puede quitar a mano mientras el negocio siga por encima
    // del límite de leads del plan (si no, bastaría con editar las etiquetas para saltárselo).
    const usage = await checkUsageLimit(businessId, 'leads');
    if (!usage.allowed) patch = { ...patch, tags: [...patch.tags.filter((t) => t !== OVER_LIMIT_TAG).slice(0, 19), OVER_LIMIT_TAG] };
  }
  const values: Partial<typeof leads.$inferInsert> = { updatedAt: new Date() };
  if (patch.name !== undefined) values.name = patch.name.trim();
  if (patch.phone !== undefined) values.phone = normalizePhone(patch.phone);
  if (patch.email !== undefined) values.email = patch.email?.trim().toLowerCase() || null;
  if (patch.instagramUsername !== undefined) values.instagramUsername = patch.instagramUsername;
  if (patch.notes !== undefined) values.notes = patch.notes;
  if (patch.tags !== undefined) values.tags = patch.tags.slice(0, 20);
  if (patch.goalSummary !== undefined) values.goalSummary = patch.goalSummary;
  if (patch.nextAction !== undefined) values.nextAction = patch.nextAction;
  if (patch.nextActionAt !== undefined) values.nextActionAt = patch.nextActionAt;
  if (patch.assignedUserId !== undefined) values.assignedUserId = patch.assignedUserId;
  if (patch.dealValueCents !== undefined) values.dealValueCents = patch.dealValueCents;
  const [row] = await getDb()
    .update(leads)
    .set(values)
    .where(and(eq(leads.businessId, businessId), eq(leads.id, leadId)))
    .returning();
  await audit({
    businessId,
    actorType: actor.type === 'lead' ? 'system' : actor.type,
    actorUserId: actor.userId,
    action: 'lead.updated',
    entityType: 'lead',
    entityId: leadId,
    metadata: { fields: Object.keys(patch) },
  });
  return row;
}

/** Cambio de estado (manual o automático). Registra evento, auditoría y fechas clave. */
export async function setLeadStatus(
  businessId: string,
  leadId: string,
  status: LeadStatus,
  actor: Actor,
  meta: { reason?: string; dealValueCents?: number | null } = {},
) {
  const lead = await getLead(businessId, leadId);
  if (lead.status === status) return lead;
  const values: Partial<typeof leads.$inferInsert> = { status, updatedAt: new Date() };
  if (status === 'client') {
    values.wonAt = new Date();
    if (meta.dealValueCents !== undefined) values.dealValueCents = meta.dealValueCents;
  }
  if (status === 'lost') {
    values.lostAt = new Date();
    values.lostReason = meta.reason ?? null;
  }
  if (['qualified', 'call_proposed', 'call_booked', 'client'].includes(status) && !lead.qualifiedAt) values.qualifiedAt = new Date();
  const [row] = await getDb()
    .update(leads)
    .set(values)
    .where(and(eq(leads.businessId, businessId), eq(leads.id, leadId)))
    .returning();
  await recordLeadEvent(businessId, leadId, 'status_changed', actor, { from: lead.status, to: status, reason: meta.reason });
  if (actor.type === 'user') {
    await audit({
      businessId,
      actorType: 'user',
      actorUserId: actor.userId,
      action: 'lead.status_changed',
      entityType: 'lead',
      entityId: leadId,
      metadata: { from: lead.status, to: status },
    });
  }
  if (status === 'client' || status === 'lost') await cancelPendingAutomationsForLead(businessId, leadId);
  return row;
}

/** Aplica un evento real del pipeline y mueve el lead si corresponde. */
export async function applyPipelineEvent(businessId: string, leadId: string, event: PipelineEvent, actor: Actor = { type: 'kai' }) {
  const lead = await getLead(businessId, leadId);
  let ctx;
  if (event === 'score_updated') ctx = await pipelineContext(businessId, lead);
  const target = nextStatus(lead.status, event, ctx);
  if (target && target !== lead.status) return setLeadStatus(businessId, leadId, target, actor, { reason: event });
  return lead;
}

async function pipelineContext(businessId: string, lead: Lead) {
  const db = getDb();
  const [settings] = await db.select().from(aiSettings).where(eq(aiSettings.businessId, businessId)).limit(1);
  const rules = await db.select().from(qualificationRules).where(eq(qualificationRules.businessId, businessId));
  const bands = settings?.scoreBands ?? DEFAULT_SCORE_BANDS;
  return {
    score: lead.score,
    interestedMin: bandMin(bands, 'interesado', 51),
    qualifiedMin: bandMin(bands, 'caliente', 71),
    requiredCaptured: requiredCaptured(rules, lead.qualification),
    fitNo: lead.signals.fit === 'no',
  };
}

/** Recalcula la puntuación con las reglas actuales del negocio y avanza el pipeline si procede. */
export async function recomputeLeadScore(businessId: string, leadId: string) {
  const db = getDb();
  const lead = await getLead(businessId, leadId);
  const [settings] = await db.select().from(aiSettings).where(eq(aiSettings.businessId, businessId)).limit(1);
  const rules = await db.select().from(qualificationRules).where(eq(qualificationRules.businessId, businessId));
  const { score, breakdown } = computeScore(rules, lead.qualification, lead.signals);
  const temperature = temperatureFor(score, settings?.scoreBands ?? DEFAULT_SCORE_BANDS);
  if (score !== lead.score || temperature !== lead.temperature) {
    await db
      .update(leads)
      .set({ score, temperature, updatedAt: new Date() })
      .where(and(eq(leads.businessId, businessId), eq(leads.id, leadId)));
    await recordLeadEvent(businessId, leadId, 'score_changed', { type: 'kai' }, { from: lead.score, to: score, temperature });
  }
  await applyPipelineEvent(businessId, leadId, 'score_updated');
  return { score, temperature, breakdown };
}

/** Fusiona información de cualificación y señales extraídas por la IA. */
export async function mergeQualification(
  businessId: string,
  leadId: string,
  updates: LeadQualification,
  signals: LeadSignals,
  extra: { goalSummary?: string | null; name?: string | null } = {},
) {
  const lead = await getLead(businessId, leadId);
  const qualification = { ...lead.qualification };
  for (const [key, item] of Object.entries(updates)) {
    if (!item?.value) continue;
    const prev = qualification[key];
    // Solo sustituye si la nueva información es al menos igual de fiable.
    if (!prev || (item.confidence ?? 0) >= (prev.confidence ?? 0) - 0.1) qualification[key] = item;
  }
  const mergedSignals: LeadSignals = { ...lead.signals };
  for (const [k, v] of Object.entries(signals)) if (v) (mergedSignals as Record<string, unknown>)[k] = v;
  const goalSummary = extra.goalSummary ?? lead.goalSummary ?? qualification.goal?.value?.slice(0, 160) ?? null;
  await getDb()
    .update(leads)
    .set({
      qualification,
      signals: mergedSignals,
      goalSummary,
      ...(extra.name && !lead.name ? { name: extra.name } : {}),
      updatedAt: new Date(),
    })
    .where(and(eq(leads.businessId, businessId), eq(leads.id, leadId)));
  return recomputeLeadScore(businessId, leadId);
}

/** Trabajos que envían mensajes al lead (no incluye el aviso post-llamada, que es para el entrenador). */
const LEAD_MESSAGE_JOBS = ['kai_reply', 'first_contact', 'followup', 'appointment_confirmation', 'appointment_reminder', 'no_show_message'];

/**
 * Baja: el lead pidió no recibir más mensajes. KAI se pausa en todas sus conversaciones y se cancelan
 * seguimientos, primeros contactos, confirmaciones y recordatorios de cita pendientes.
 */
export async function markOptedOut(businessId: string, leadId: string, actor: Actor = { type: 'lead' }, meta: Record<string, unknown> = {}) {
  const db = getDb();
  await db
    .update(leads)
    .set({ optedOut: true, updatedAt: new Date() })
    .where(and(eq(leads.businessId, businessId), eq(leads.id, leadId)));
  await db
    .update(conversations)
    .set({ aiEnabled: false, updatedAt: new Date() })
    .where(and(eq(conversations.businessId, businessId), eq(conversations.leadId, leadId)));
  await cancelPendingAutomationsForLead(businessId, leadId);
  await db
    .update(scheduledJobs)
    .set({ status: 'cancelled', finishedAt: new Date() })
    .where(
      and(
        eq(scheduledJobs.businessId, businessId),
        eq(scheduledJobs.status, 'pending'),
        inArray(scheduledJobs.type, LEAD_MESSAGE_JOBS),
        sql`${scheduledJobs.payload}->>'leadId' = ${leadId}`,
      ),
    );
  await recordLeadEvent(businessId, leadId, 'opted_out', actor, meta);
}

/** Alta manual (el lead vuelve a aceptar mensajes). KAI sigue pausado hasta que el entrenador lo reactive. */
export async function markOptedIn(businessId: string, leadId: string, actor: Actor) {
  await getDb()
    .update(leads)
    .set({ optedOut: false, updatedAt: new Date() })
    .where(and(eq(leads.businessId, businessId), eq(leads.id, leadId)));
  await recordLeadEvent(businessId, leadId, 'opted_in', actor);
}

/** Cancela seguimientos y trabajos pendientes de un lead (cuando responde, se cierra o se borra). */
export async function cancelPendingAutomationsForLead(businessId: string, leadId: string, reasons?: string[]) {
  const db = getDb();
  const pending = await db
    .select()
    .from(followUps)
    .where(and(eq(followUps.businessId, businessId), eq(followUps.leadId, leadId), eq(followUps.status, 'scheduled')));
  const toCancel = reasons ? pending.filter((f) => reasons.includes(f.reason)) : pending;
  if (toCancel.length === 0) return 0;
  const ids = toCancel.map((f) => f.id);
  await db.update(followUps).set({ status: 'cancelled', note: 'Cancelado automáticamente' }).where(inArray(followUps.id, ids));
  const jobIds = toCancel.map((f) => f.jobId).filter((x): x is string => Boolean(x));
  if (jobIds.length)
    await db
      .update(scheduledJobs)
      .set({ status: 'cancelled', finishedAt: new Date() })
      .where(and(inArray(scheduledJobs.id, jobIds), eq(scheduledJobs.status, 'pending')));
  return toCancel.length;
}

export async function deleteLead(businessId: string, leadId: string, actor: Actor) {
  const lead = await getLead(businessId, leadId);
  const db = getDb();
  // Sus citas programadas se borran con él: antes hay que quitar los eventos de Google Calendar y sus
  // recordatorios, o quedarían huérfanos ocupando el hueco para siempre. (Import dinámico: calendar.service
  // importa este módulo.)
  const { releaseLeadAppointments } = await import('../calendar/calendar.service.js');
  await releaseLeadAppointments(businessId, leadId);
  await db
    .update(scheduledJobs)
    .set({ status: 'cancelled', finishedAt: new Date() })
    .where(and(eq(scheduledJobs.businessId, businessId), eq(scheduledJobs.status, 'pending'), sql`${scheduledJobs.payload}->>'leadId' = ${leadId}`));
  await db.delete(leads).where(and(eq(leads.businessId, businessId), eq(leads.id, leadId)));
  await audit({
    businessId,
    actorType: actor.type === 'lead' ? 'system' : actor.type,
    actorUserId: actor.userId,
    action: 'lead.deleted',
    entityType: 'lead',
    entityId: leadId,
    metadata: { name: lead.name, source: lead.source },
  });
}

export async function getLeadProfile(businessId: string, leadId: string) {
  const db = getDb();
  const lead = await getLead(businessId, leadId);
  const [memories, events, appts, convs, rules] = await Promise.all([
    db
      .select()
      .from(leadMemories)
      .where(and(eq(leadMemories.businessId, businessId), eq(leadMemories.leadId, leadId)))
      .orderBy(desc(leadMemories.createdAt)),
    db
      .select()
      .from(leadEvents)
      .where(and(eq(leadEvents.businessId, businessId), eq(leadEvents.leadId, leadId)))
      .orderBy(desc(leadEvents.createdAt))
      .limit(100),
    db
      .select()
      .from(appointments)
      .where(and(eq(appointments.businessId, businessId), eq(appointments.leadId, leadId)))
      .orderBy(desc(appointments.startsAt)),
    db
      .select()
      .from(conversations)
      .where(and(eq(conversations.businessId, businessId), eq(conversations.leadId, leadId))),
    db
      .select()
      .from(qualificationRules)
      .where(eq(qualificationRules.businessId, businessId))
      .orderBy(asc(qualificationRules.sortOrder)),
  ]);
  const { breakdown } = computeScore(rules, lead.qualification, lead.signals);
  return { lead, memories, events, appointments: appts, conversations: convs, qualificationRules: rules, scoreBreakdown: breakdown };
}

export function isClosed(status: LeadStatus) {
  return CLOSED_STATUSES.includes(status);
}

export function assertCanMessage(lead: Lead) {
  if (lead.optedOut) throw badRequest('Este lead pidió no recibir más mensajes.');
}

