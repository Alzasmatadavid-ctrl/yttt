import { and, eq } from 'drizzle-orm';
import { getDb } from '../database/client.js';
import { conversations, leads } from '../database/schema.js';
import { HANDOFF_REASONS, type HandoffReason } from '../lib/domain.js';
import { audit } from '../audit/audit.service.js';
import { createAlert } from './alerts.service.js';
import { getConversation } from './conversations.service.js';
import { recordLeadEvent } from './leads.service.js';

/**
 * Escalado a humano: KAI deja de actuar en la conversación y avisa al entrenador
 * con el mensaje “KAI necesita tu intervención”.
 */
export async function triggerHandoff(businessId: string, conversationId: string, reason: HandoffReason, detail = '') {
  const conv = await getConversation(businessId, conversationId);
  if (conv.handoffActive) return conv;
  const [updated] = await getDb()
    .update(conversations)
    .set({ handoffActive: true, handoffReason: reason, handoffAt: new Date(), updatedAt: new Date() })
    .where(and(eq(conversations.businessId, businessId), eq(conversations.id, conversationId)))
    .returning();
  const [lead] = await getDb().select({ name: leads.name }).from(leads).where(eq(leads.id, conv.leadId)).limit(1);
  await createAlert({
    businessId,
    type: 'handoff',
    severity: reason === 'medical' || reason === 'angry' ? 'critical' : 'warning',
    title: 'KAI necesita tu intervención',
    body: `${lead?.name || 'Un lead'}: ${HANDOFF_REASONS[reason]}${detail ? ` — ${detail}` : ''}`,
    leadId: conv.leadId,
    conversationId,
  });
  await recordLeadEvent(businessId, conv.leadId, 'handoff', { type: 'kai' }, { reason, detail });
  await audit({ businessId, actorType: 'kai', action: 'conversation.handoff', entityType: 'conversation', entityId: conversationId, metadata: { reason, detail } });
  return updated;
}
