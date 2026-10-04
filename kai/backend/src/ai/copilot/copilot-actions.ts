/**
 * Acciones sensibles de Copilot: NUNCA se ejecutan directamente.
 * Copilot crea una “acción pendiente” y el entrenador la confirma (o cancela) desde la interfaz.
 */
import { and, desc, eq, gt, lt } from 'drizzle-orm';
import { getDb } from '../../database/client.js';
import { aiSettings, automations, conversations, pendingActions } from '../../database/schema.js';
import { AUTOMATION_LABELS, isLeadStatus, leadStatusLabel, type AiTone, type AutomationType, type LeadStatus, type Permission } from '../../lib/domain.js';
import { badRequest, forbidden, notFound } from '../../lib/errors.js';
import { audit } from '../../audit/audit.service.js';
import type { TenantContext } from '../../auth/guards.js';
import { deleteLead, getLead, setLeadStatus } from '../../crm/leads.service.js';
import { sendMessage } from '../../crm/messaging.service.js';
import { firstName } from '../../lib/text.js';
import { loadBusinessContext, loadLeadContext } from '../context/context.js';
import { buildValidationContext } from '../setter/setter-engine.js';
import { validateReply } from '../validation/output-validator.js';

export type PendingActionType =
  | 'send_message'
  | 'change_lead_status'
  | 'delete_lead'
  | 'update_tone'
  | 'toggle_automation'
  | 'toggle_kai_conversation'
  | 'toggle_autopilot';

const REQUIRED_PERMISSION: Record<PendingActionType, Permission> = {
  send_message: 'conversations:reply',
  change_lead_status: 'leads:write',
  delete_lead: 'leads:delete',
  update_tone: 'settings:write',
  toggle_automation: 'automations:manage',
  toggle_kai_conversation: 'conversations:reply',
  toggle_autopilot: 'settings:write',
};

const ACTION_TTL_MS = 24 * 3600_000;
const MESSAGE_MAX_LENGTH = 1000;
const AUTOMATION_TYPES: AutomationType[] = ['followup_no_reply', 'appointment_reminders', 'no_show_recovery', 'post_call'];

/** ¿Puede este usuario proponer (y luego confirmar) este tipo de acción con su rol? */
export function canPropose(ctx: TenantContext, type: PendingActionType): boolean {
  return ctx.permissions.includes(REQUIRED_PERMISSION[type]);
}

export const NOT_ALLOWED_MESSAGE = 'Tu rol no tiene permiso para esta acción. Pídesela a la persona titular de la cuenta.';

// ───────────── Tono: valores válidos y cambios legibles ─────────────

/** Etiquetas del tono, iguales que en Configuración del setter → Personalidad. */
const TONE_SCALES: Record<'formality' | 'energy' | 'directness', { label: string; scale: string[] }> = {
  formality: { label: 'Formalidad', scale: ['Muy cercano', 'Cercano', 'Equilibrado', 'Formal', 'Muy formal'] },
  energy: { label: 'Energía', scale: ['Muy calmado', 'Tranquilo', 'Equilibrado', 'Enérgico', 'Muy enérgico'] },
  directness: { label: 'Directividad', scale: ['Muy suave', 'Suave', 'Equilibrado', 'Directo', 'Muy directo'] },
};
const EMOJI_LABELS: Record<AiTone['emojiUsage'], string> = { none: 'Ninguno', low: 'Pocos', medium: 'Algunos', high: 'Muchos' };
const LENGTH_LABELS: Record<AiTone['messageLength'], string> = { short: 'Cortos', medium: 'Medios', long: 'Largos' };
const ADDRESSING_LABELS: Record<AiTone['addressing'], string> = { tu: 'De tú', usted: 'De usted' };

/** Cambios de tono válidos (lo que no sea un valor permitido se descarta). */
function sanitizeTone(raw: unknown): Partial<AiTone> {
  const t = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const tone: Partial<AiTone> = {};
  for (const k of ['formality', 'energy', 'directness'] as const) {
    const v = t[k];
    if (typeof v === 'number' && Number.isFinite(v)) tone[k] = Math.min(5, Math.max(1, Math.round(v)));
  }
  if (typeof t.emojiUsage === 'string' && t.emojiUsage in EMOJI_LABELS) tone.emojiUsage = t.emojiUsage as AiTone['emojiUsage'];
  if (typeof t.messageLength === 'string' && t.messageLength in LENGTH_LABELS) tone.messageLength = t.messageLength as AiTone['messageLength'];
  if (typeof t.addressing === 'string' && t.addressing in ADDRESSING_LABELS) tone.addressing = t.addressing as AiTone['addressing'];
  return tone;
}

/** “Formalidad: Cercano → Formal”… solo de lo que cambia de verdad respecto al tono actual. */
function toneChanges(current: AiTone, next: Partial<AiTone>): string[] {
  const out: string[] = [];
  for (const k of ['formality', 'energy', 'directness'] as const) {
    const v = next[k];
    if (v !== undefined && v !== current[k]) out.push(`${TONE_SCALES[k].label}: ${TONE_SCALES[k].scale[current[k] - 1] ?? current[k]} → ${TONE_SCALES[k].scale[v - 1]}`);
  }
  if (next.emojiUsage && next.emojiUsage !== current.emojiUsage) out.push(`Emojis: ${EMOJI_LABELS[current.emojiUsage]} → ${EMOJI_LABELS[next.emojiUsage]}`);
  if (next.messageLength && next.messageLength !== current.messageLength) out.push(`Longitud de los mensajes: ${LENGTH_LABELS[current.messageLength]} → ${LENGTH_LABELS[next.messageLength]}`);
  if (next.addressing && next.addressing !== current.addressing) out.push(`Trato: ${ADDRESSING_LABELS[current.addressing]} → ${ADDRESSING_LABELS[next.addressing]}`);
  return out;
}

// ───────────── Crear la acción pendiente ─────────────

/**
 * Control de calidad del mensaje que Copilot propone enviar a un lead: las mismas reglas que los mensajes de KAI
 * (horarios y precios reales, una sola pregunta, sin presión ni promesas, tono y palabras prohibidas).
 */
async function messageQualityIssues(businessId: string, leadId: string, text: string): Promise<string[]> {
  const [biz, leadCtx, convs] = await Promise.all([
    loadBusinessContext(businessId),
    loadLeadContext(businessId, leadId),
    getDb()
      .select({ state: conversations.state })
      .from(conversations)
      .where(and(eq(conversations.businessId, businessId), eq(conversations.leadId, leadId))),
  ]);
  const offered = convs.flatMap((c) => c.state.offeredSlots ?? []);
  const upcoming = leadCtx.upcomingAppointment;
  const ctx = buildValidationContext(biz, null);
  ctx.allowedTimes = [...offered.map((s) => new Date(s.start)), ...(upcoming ? [upcoming.startsAt] : [])];
  ctx.allowedUrls = [...offered.map((s) => s.bookingUrl).filter((u): u is string => Boolean(u)), ...(upcoming?.meetingUrl ? [upcoming.meetingUrl] : [])];
  return validateReply(text, ctx).issues;
}

/**
 * Comprueba y limpia lo que Copilot propone ANTES de pedir confirmación: si falta algo (el texto del mensaje,
 * el lead, si activar o desactivar…), la acción no se crea. Así nunca se confirma algo incompleto
 * (p. ej. enviar “undefined” a un lead, o desactivar una automatización porque no se indicó nada).
 */
async function normalizePayload(businessId: string, type: PendingActionType, p: Record<string, unknown>): Promise<Record<string, unknown>> {
  const leadId = typeof p.leadId === 'string' && p.leadId.trim() ? p.leadId.trim() : null;
  const needLead = async () => {
    if (!leadId) throw badRequest('Indica a qué lead se refiere la acción.');
    await getLead(businessId, leadId);
    return leadId;
  };
  const needEnabled = () => {
    if (typeof p.enabled !== 'boolean') throw badRequest('Indica si hay que activar o desactivar.');
    return p.enabled;
  };
  switch (type) {
    case 'send_message': {
      const id = await needLead();
      const text = typeof p.text === 'string' ? p.text.trim() : '';
      if (!text) throw badRequest('Falta el texto del mensaje que quieres enviar.');
      if (text.length > MESSAGE_MAX_LENGTH) throw badRequest(`El mensaje es demasiado largo (máximo ${MESSAGE_MAX_LENGTH} caracteres).`);
      const issues = await messageQualityIssues(businessId, id, text);
      if (issues.length) throw badRequest(`El mensaje no supera el control de calidad: ${issues.join(' ')}`, { issues });
      return { leadId: id, text };
    }
    case 'change_lead_status': {
      const id = await needLead();
      if (!isLeadStatus(p.status)) throw badRequest('Etapa no válida.');
      return { leadId: id, status: p.status, ...(typeof p.reason === 'string' && p.reason.trim() ? { reason: p.reason.trim().slice(0, 300) } : {}) };
    }
    case 'delete_lead':
      return { leadId: await needLead() };
    case 'update_tone': {
      const words = Array.isArray(p.addWordsToAvoid) ? (p.addWordsToAvoid as unknown[]).filter((w): w is string => typeof w === 'string') : [];
      const addWordsToAvoid = [...new Set(words.map((w) => w.trim()).filter((w) => w.length >= 2 && w.length <= 60))].slice(0, 20);
      return { tone: sanitizeTone(p.tone), ...(addWordsToAvoid.length ? { addWordsToAvoid } : {}) };
    }
    case 'toggle_automation':
      if (typeof p.automation !== 'string' || !AUTOMATION_TYPES.includes(p.automation as AutomationType)) throw badRequest('Automatización no válida.');
      return { automation: p.automation, enabled: needEnabled() };
    case 'toggle_kai_conversation':
      return { leadId: await needLead(), enabled: needEnabled() };
    case 'toggle_autopilot':
      return { enabled: needEnabled() };
  }
}

export async function createPendingAction(ctx: TenantContext, type: PendingActionType, rawPayload: Record<string, unknown>) {
  if (!ctx.permissions.includes(REQUIRED_PERMISSION[type])) throw forbidden('No tienes permiso para proponer esta acción.');
  const payload = await normalizePayload(ctx.businessId, type, rawPayload);
  const summary = await summarize(ctx.businessId, type, payload);
  const [row] = await getDb()
    .insert(pendingActions)
    .values({ businessId: ctx.businessId, userId: ctx.userId, type, summary, payload, expiresAt: new Date(Date.now() + ACTION_TTL_MS) })
    .returning();
  return row;
}

/**
 * Lo que verá el entrenador antes de confirmar. Para un mensaje, el texto COMPLETO que se va a enviar
 * (sin recortes); para el tono, los cambios reales (antes → después), no un resumen redactado por el modelo.
 */
async function summarize(businessId: string, type: PendingActionType, p: Record<string, unknown>): Promise<string> {
  switch (type) {
    case 'send_message': {
      const lead = await getLead(businessId, String(p.leadId));
      return `Enviar a ${lead.name || 'este lead'} este mensaje: “${String(p.text)}”`;
    }
    case 'change_lead_status': {
      const lead = await getLead(businessId, String(p.leadId));
      return `Mover a ${lead.name || 'este lead'} a “${leadStatusLabel(p.status as LeadStatus)}”`;
    }
    case 'delete_lead': {
      const lead = await getLead(businessId, String(p.leadId));
      return `Eliminar definitivamente a ${lead.name || 'este lead'} y su historial`;
    }
    case 'update_tone': {
      const [settings] = await getDb()
        .select({ tone: aiSettings.tone, wordsToAvoid: aiSettings.wordsToAvoid })
        .from(aiSettings)
        .where(eq(aiSettings.businessId, businessId))
        .limit(1);
      if (!settings) throw notFound();
      const changes = toneChanges(settings.tone, p.tone as Partial<AiTone>);
      const known = new Set(settings.wordsToAvoid.map((w) => w.toLowerCase()));
      const newWords = ((p.addWordsToAvoid as string[] | undefined) ?? []).filter((w) => !known.has(w.toLowerCase()));
      if (newWords.length) changes.push(`Palabras a evitar: añadir ${newWords.map((w) => `“${w}”`).join(', ')}`);
      if (changes.length === 0) throw badRequest('El tono de KAI ya está así: no hay nada que cambiar.');
      return `Cambiar el tono de KAI. ${changes.join(' · ')}`;
    }
    case 'toggle_automation':
      return `${p.enabled ? 'Activar' : 'Desactivar'} la automatización “${AUTOMATION_LABELS[p.automation as AutomationType] ?? String(p.automation)}”`;
    case 'toggle_kai_conversation': {
      const lead = await getLead(businessId, String(p.leadId));
      return `${p.enabled ? 'Reactivar' : 'Pausar'} a KAI en la conversación con ${firstName(lead.name) || 'este lead'}`;
    }
    case 'toggle_autopilot':
      return `${p.enabled ? 'Activar' : 'Pausar'} el piloto automático de KAI para todas las conversaciones`;
  }
}

// ───────────── Listar, cancelar y confirmar ─────────────

/** Acciones pendientes de confirmar (las caducadas ya no aparecen). */
export async function listPendingActions(ctx: TenantContext) {
  return getDb()
    .select()
    .from(pendingActions)
    .where(
      and(
        eq(pendingActions.businessId, ctx.businessId),
        eq(pendingActions.userId, ctx.userId),
        eq(pendingActions.status, 'pending'),
        gt(pendingActions.expiresAt, new Date()),
      ),
    )
    .orderBy(desc(pendingActions.createdAt))
    .limit(20);
}

/** Explica por qué una acción ya no se puede confirmar ni cancelar (y caduca la que haya vencido). */
async function explainUnavailable(ctx: TenantContext, id: string): Promise<never> {
  const [row] = await getDb()
    .select()
    .from(pendingActions)
    .where(and(eq(pendingActions.businessId, ctx.businessId), eq(pendingActions.id, id)))
    .limit(1);
  if (!row) throw notFound('Acción no encontrada.');
  if (row.status === 'pending' && row.expiresAt <= new Date()) {
    await getDb()
      .update(pendingActions)
      .set({ status: 'expired', resolvedAt: new Date() })
      .where(and(eq(pendingActions.id, id), eq(pendingActions.status, 'pending')));
    throw badRequest('Esta acción ha caducado. Pídesela de nuevo a Copilot.');
  }
  throw badRequest('Esta acción ya fue resuelta.');
}

/**
 * Resuelve una acción pendiente de forma ATÓMICA: solo una petición puede sacarla de “pendiente”.
 * Un doble clic o dos pestañas no ejecutan la acción dos veces.
 */
async function claimPending(ctx: TenantContext, id: string, status: 'confirmed' | 'cancelled') {
  const [row] = await getDb()
    .update(pendingActions)
    .set({ status, resolvedAt: new Date() })
    .where(
      and(eq(pendingActions.businessId, ctx.businessId), eq(pendingActions.id, id), eq(pendingActions.status, 'pending'), gt(pendingActions.expiresAt, new Date())),
    )
    .returning();
  return row ?? explainUnavailable(ctx, id);
}

export async function cancelPendingAction(ctx: TenantContext, id: string) {
  await claimPending(ctx, id, 'cancelled');
  return { ok: true };
}

/** Ejecuta la acción tras la confirmación explícita del entrenador. */
export async function confirmPendingAction(ctx: TenantContext, id: string) {
  const [existing] = await getDb()
    .select({ type: pendingActions.type })
    .from(pendingActions)
    .where(and(eq(pendingActions.businessId, ctx.businessId), eq(pendingActions.id, id)))
    .limit(1);
  if (!existing) throw notFound('Acción no encontrada.');
  if (!ctx.permissions.includes(REQUIRED_PERMISSION[existing.type as PendingActionType])) throw forbidden();
  // Se reclama ANTES de ejecutar: si otra petición se adelantó, esta no hace nada.
  const action = await claimPending(ctx, id, 'confirmed');
  const type = action.type as PendingActionType;
  const p = action.payload;
  const db = getDb();
  const actor = { type: 'user' as const, userId: ctx.userId };
  let result: Record<string, unknown> = {};
  try {
    switch (type) {
      case 'send_message': {
        const leadId = String(p.leadId);
        const text = typeof p.text === 'string' ? p.text.trim() : '';
        if (!text) throw badRequest('La acción no tiene ningún texto que enviar.');
        await getLead(ctx.businessId, leadId);
        const convs = await db
          .select()
          .from(conversations)
          .where(and(eq(conversations.businessId, ctx.businessId), eq(conversations.leadId, leadId)))
          .orderBy(desc(conversations.lastMessageAt));
        const conv = convs.find((c) => c.channel !== 'web') ?? convs[0];
        if (!conv) throw badRequest('Este lead no tiene ninguna conversación abierta.');
        const sent = await sendMessage({ businessId: ctx.businessId, conversationId: conv.id, text, sender: { type: 'human', userId: ctx.userId }, purpose: 'manual', metadata: { via: 'copilot' } });
        result = { delivered: sent.delivered, reason: sent.blockedReason ?? null, messageId: sent.message.id };
        break;
      }
      case 'change_lead_status': {
        if (!isLeadStatus(p.status)) throw badRequest('Etapa no válida.');
        await setLeadStatus(ctx.businessId, String(p.leadId), p.status, actor, { reason: String(p.reason ?? 'Copilot') });
        result = { ok: true };
        break;
      }
      case 'delete_lead':
        await deleteLead(ctx.businessId, String(p.leadId), actor);
        result = { ok: true };
        break;
      case 'update_tone': {
        const [settings] = await db.select().from(aiSettings).where(eq(aiSettings.businessId, ctx.businessId)).limit(1);
        if (!settings) throw notFound();
        const tone: AiTone = { ...settings.tone, ...sanitizeTone(p.tone) };
        const addAvoid = Array.isArray(p.addWordsToAvoid) ? (p.addWordsToAvoid as unknown[]).filter((w): w is string => typeof w === 'string') : [];
        await db
          .update(aiSettings)
          .set({ tone, wordsToAvoid: [...new Set([...settings.wordsToAvoid, ...addAvoid])].slice(0, 100), updatedAt: new Date() })
          .where(eq(aiSettings.businessId, ctx.businessId));
        result = { tone };
        break;
      }
      case 'toggle_automation':
        if (typeof p.enabled !== 'boolean') throw badRequest('La acción no indica si activar o desactivar.');
        await db
          .update(automations)
          .set({ enabled: p.enabled, updatedAt: new Date() })
          .where(and(eq(automations.businessId, ctx.businessId), eq(automations.type, p.automation as AutomationType)));
        result = { ok: true };
        break;
      case 'toggle_kai_conversation':
        if (typeof p.enabled !== 'boolean') throw badRequest('La acción no indica si pausar o reactivar a KAI.');
        await db
          .update(conversations)
          .set({ aiEnabled: p.enabled, ...(p.enabled ? { handoffActive: false } : {}), updatedAt: new Date() })
          .where(and(eq(conversations.businessId, ctx.businessId), eq(conversations.leadId, String(p.leadId))));
        result = { ok: true };
        break;
      case 'toggle_autopilot':
        if (typeof p.enabled !== 'boolean') throw badRequest('La acción no indica si activar o pausar el piloto automático.');
        await db.update(aiSettings).set({ autopilotEnabled: p.enabled, updatedAt: new Date() }).where(eq(aiSettings.businessId, ctx.businessId));
        result = { ok: true };
        break;
    }
  } catch (err) {
    await db
      .update(pendingActions)
      .set({ status: 'failed', resolvedAt: new Date(), result: { error: err instanceof Error ? err.message : String(err) } })
      .where(eq(pendingActions.id, id));
    throw err;
  }
  await db.update(pendingActions).set({ result }).where(eq(pendingActions.id, id));
  await audit({ businessId: ctx.businessId, actorType: 'user', actorUserId: ctx.userId, action: `copilot.${type}`, entityType: 'pending_action', entityId: id, metadata: { payload: p, result } });
  return { ok: true, result, summary: action.summary };
}

/** Caduca acciones antiguas (mantenimiento). */
export async function expireOldActions() {
  await getDb()
    .update(pendingActions)
    .set({ status: 'expired', resolvedAt: new Date() })
    .where(and(eq(pendingActions.status, 'pending'), lt(pendingActions.expiresAt, new Date())));
}
