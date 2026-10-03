/**
 * Acciones sensibles de Copilot: NUNCA se ejecutan directamente.
 * Copilot crea una “acción pendiente” y el entrenador la confirma (o cancela) desde la interfaz.
 */
import { and, desc, eq, lt } from 'drizzle-orm';
import { getDb } from '../../database/client.js';
import { aiSettings, automations, conversations, pendingActions } from '../../database/schema.js';
import { AUTOMATION_LABELS, isLeadStatus, leadStatusLabel, type AiTone, type AutomationType, type Permission } from '../../lib/domain.js';
import { badRequest, forbidden, notFound } from '../../lib/errors.js';
import { audit } from '../../audit/audit.service.js';
import type { TenantContext } from '../../auth/guards.js';
import { deleteLead, getLead, setLeadStatus } from '../../crm/leads.service.js';
import { sendMessage } from '../../crm/messaging.service.js';
import { firstName, truncate } from '../../lib/text.js';

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

export async function createPendingAction(ctx: TenantContext, type: PendingActionType, payload: Record<string, unknown>) {
  if (!ctx.permissions.includes(REQUIRED_PERMISSION[type])) throw forbidden('No tienes permiso para proponer esta acción.');
  const summary = await summarize(ctx.businessId, type, payload);
  const [row] = await getDb()
    .insert(pendingActions)
    .values({ businessId: ctx.businessId, userId: ctx.userId, type, summary, payload, expiresAt: new Date(Date.now() + ACTION_TTL_MS) })
    .returning();
  return row;
}

async function summarize(businessId: string, type: PendingActionType, p: Record<string, unknown>): Promise<string> {
  switch (type) {
    case 'send_message': {
      const lead = await getLead(businessId, String(p.leadId));
      return `Enviar a ${lead.name || 'este lead'}: “${truncate(String(p.text ?? ''), 160)}”`;
    }
    case 'change_lead_status': {
      const lead = await getLead(businessId, String(p.leadId));
      if (!isLeadStatus(p.status)) throw badRequest('Etapa no válida.');
      return `Mover a ${lead.name || 'este lead'} a “${leadStatusLabel(p.status)}”`;
    }
    case 'delete_lead': {
      const lead = await getLead(businessId, String(p.leadId));
      return `Eliminar definitivamente a ${lead.name || 'este lead'} y su historial`;
    }
    case 'update_tone':
      return `Cambiar el tono de KAI: ${String(p.summary ?? 'ajustes de estilo')}`;
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

export async function listPendingActions(ctx: TenantContext) {
  return getDb()
    .select()
    .from(pendingActions)
    .where(and(eq(pendingActions.businessId, ctx.businessId), eq(pendingActions.userId, ctx.userId), eq(pendingActions.status, 'pending')))
    .orderBy(desc(pendingActions.createdAt))
    .limit(20);
}

async function loadPending(ctx: TenantContext, id: string) {
  const [row] = await getDb()
    .select()
    .from(pendingActions)
    .where(and(eq(pendingActions.businessId, ctx.businessId), eq(pendingActions.id, id)))
    .limit(1);
  if (!row) throw notFound('Acción no encontrada.');
  if (row.status !== 'pending') throw badRequest('Esta acción ya fue resuelta.');
  if (row.expiresAt < new Date()) {
    await getDb().update(pendingActions).set({ status: 'expired', resolvedAt: new Date() }).where(eq(pendingActions.id, id));
    throw badRequest('Esta acción ha caducado. Pídesela de nuevo a Copilot.');
  }
  return row;
}

export async function cancelPendingAction(ctx: TenantContext, id: string) {
  await loadPending(ctx, id);
  await getDb().update(pendingActions).set({ status: 'cancelled', resolvedAt: new Date() }).where(eq(pendingActions.id, id));
  return { ok: true };
}

/** Ejecuta la acción tras la confirmación explícita del entrenador. */
export async function confirmPendingAction(ctx: TenantContext, id: string) {
  const action = await loadPending(ctx, id);
  const type = action.type as PendingActionType;
  if (!ctx.permissions.includes(REQUIRED_PERMISSION[type])) throw forbidden();
  const p = action.payload;
  const db = getDb();
  const actor = { type: 'user' as const, userId: ctx.userId };
  let result: Record<string, unknown> = {};
  try {
    switch (type) {
      case 'send_message': {
        const leadId = String(p.leadId);
        await getLead(ctx.businessId, leadId);
        const convs = await db
          .select()
          .from(conversations)
          .where(and(eq(conversations.businessId, ctx.businessId), eq(conversations.leadId, leadId)))
          .orderBy(desc(conversations.lastMessageAt));
        const conv = convs.find((c) => c.channel !== 'web') ?? convs[0];
        if (!conv) throw badRequest('Este lead no tiene ninguna conversación abierta.');
        const sent = await sendMessage({ businessId: ctx.businessId, conversationId: conv.id, text: String(p.text), sender: { type: 'human', userId: ctx.userId }, purpose: 'manual', metadata: { via: 'copilot' } });
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
        const tone: AiTone = { ...settings.tone, ...(p.tone as Partial<AiTone>) };
        const addAvoid = Array.isArray(p.addWordsToAvoid) ? (p.addWordsToAvoid as string[]) : [];
        await db
          .update(aiSettings)
          .set({ tone, wordsToAvoid: [...new Set([...settings.wordsToAvoid, ...addAvoid])].slice(0, 100), updatedAt: new Date() })
          .where(eq(aiSettings.businessId, ctx.businessId));
        result = { tone };
        break;
      }
      case 'toggle_automation':
        await db
          .update(automations)
          .set({ enabled: Boolean(p.enabled), updatedAt: new Date() })
          .where(and(eq(automations.businessId, ctx.businessId), eq(automations.type, p.automation as AutomationType)));
        result = { ok: true };
        break;
      case 'toggle_kai_conversation':
        await db
          .update(conversations)
          .set({ aiEnabled: Boolean(p.enabled), ...(p.enabled ? { handoffActive: false } : {}), updatedAt: new Date() })
          .where(and(eq(conversations.businessId, ctx.businessId), eq(conversations.leadId, String(p.leadId))));
        result = { ok: true };
        break;
      case 'toggle_autopilot':
        await db.update(aiSettings).set({ autopilotEnabled: Boolean(p.enabled), updatedAt: new Date() }).where(eq(aiSettings.businessId, ctx.businessId));
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
  await db.update(pendingActions).set({ status: 'confirmed', resolvedAt: new Date(), result }).where(eq(pendingActions.id, id));
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
