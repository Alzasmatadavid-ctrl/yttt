import { and, asc, desc, eq, inArray, or, sql, type SQL } from 'drizzle-orm';
import { getDb } from '../database/client.js';
import { appointments, channelConnections, conversations, leadMemories, leads, messages } from '../database/schema.js';
import type { ChannelKey, ConversationState } from '../lib/domain.js';
import { notFound } from '../lib/errors.js';
import { truncate } from '../lib/text.js';
import { audit } from '../audit/audit.service.js';
import { resolveAlertsFor } from './alerts.service.js';

export type Conversation = typeof conversations.$inferSelect;
export type Message = typeof messages.$inferSelect;

export async function getOrCreateConversation(
  businessId: string,
  leadId: string,
  channel: ChannelKey,
  channelConnectionId?: string | null,
): Promise<Conversation> {
  const db = getDb();
  const [existing] = await db
    .select()
    .from(conversations)
    .where(and(eq(conversations.businessId, businessId), eq(conversations.leadId, leadId), eq(conversations.channel, channel)))
    .limit(1);
  if (existing) {
    if (channelConnectionId && existing.channelConnectionId !== channelConnectionId) {
      await db.update(conversations).set({ channelConnectionId }).where(eq(conversations.id, existing.id));
      return { ...existing, channelConnectionId };
    }
    return existing;
  }
  const [created] = await db
    .insert(conversations)
    .values({ businessId, leadId, channel, channelConnectionId: channelConnectionId ?? null })
    .onConflictDoNothing()
    .returning();
  if (created) return created;
  const [again] = await db
    .select()
    .from(conversations)
    .where(and(eq(conversations.businessId, businessId), eq(conversations.leadId, leadId), eq(conversations.channel, channel)))
    .limit(1);
  return again;
}

export async function getConversation(businessId: string, conversationId: string): Promise<Conversation> {
  const [row] = await getDb()
    .select()
    .from(conversations)
    .where(and(eq(conversations.businessId, businessId), eq(conversations.id, conversationId)))
    .limit(1);
  if (!row) throw notFound('Conversación no encontrada.');
  return row;
}

export async function updateConversationState(businessId: string, conversationId: string, patch: Partial<ConversationState>) {
  const conv = await getConversation(businessId, conversationId);
  const state = { ...conv.state, ...patch };
  await getDb()
    .update(conversations)
    .set({ state, updatedAt: new Date() })
    .where(and(eq(conversations.businessId, businessId), eq(conversations.id, conversationId)));
  return state;
}

/** Inserta un mensaje y actualiza los contadores de conversación y lead. */
export async function insertMessage(input: {
  businessId: string;
  conversationId: string;
  leadId: string;
  direction: 'inbound' | 'outbound';
  senderType: 'lead' | 'kai' | 'human' | 'system';
  senderUserId?: string | null;
  content: string;
  contentType?: 'text' | 'template' | 'media' | 'unsupported';
  externalId?: string | null;
  status?: Message['status'];
  error?: string | null;
  metadata?: Record<string, unknown>;
  createdAt?: Date;
}): Promise<Message> {
  const db = getDb();
  const at = input.createdAt ?? new Date();
  const [msg] = await db
    .insert(messages)
    .values({
      businessId: input.businessId,
      conversationId: input.conversationId,
      leadId: input.leadId,
      direction: input.direction,
      senderType: input.senderType,
      senderUserId: input.senderUserId ?? null,
      content: input.content,
      contentType: input.contentType ?? 'text',
      externalId: input.externalId ?? null,
      status: input.status ?? (input.direction === 'inbound' ? 'received' : 'sent'),
      error: input.error ?? null,
      metadata: input.metadata ?? {},
      createdAt: at,
    })
    .returning();

  const delivered = input.direction === 'inbound' || !['failed', 'skipped'].includes(msg.status);
  if (delivered) {
    const convPatch: Partial<typeof conversations.$inferInsert> = {
      lastMessageAt: at,
      lastMessagePreview: truncate(input.content.replace(/\s+/g, ' '), 140),
      updatedAt: new Date(),
    };
    if (input.direction === 'inbound') {
      convPatch.lastInboundAt = at;
      convPatch.unreadCount = sql`${conversations.unreadCount} + 1` as unknown as number;
      convPatch.status = 'open';
    }
    await db.update(conversations).set(convPatch).where(eq(conversations.id, input.conversationId));

    const leadPatch: Partial<typeof leads.$inferInsert> = { lastInteractionAt: at, updatedAt: new Date() };
    if (input.direction === 'inbound') leadPatch.lastInboundAt = at;
    else {
      leadPatch.lastOutboundAt = at;
      leadPatch.firstResponseSeconds = sql`coalesce(${leads.firstResponseSeconds}, greatest(0, extract(epoch from (${at.toISOString()}::timestamptz - ${leads.createdAt}))::int))` as unknown as number;
    }
    await db.update(leads).set(leadPatch).where(and(eq(leads.businessId, input.businessId), eq(leads.id, input.leadId)));
  }
  return msg;
}

export async function listMessages(businessId: string, conversationId: string, limit = 200) {
  const rows = await getDb()
    .select()
    .from(messages)
    .where(and(eq(messages.businessId, businessId), eq(messages.conversationId, conversationId)))
    .orderBy(desc(messages.createdAt))
    .limit(limit);
  return rows.reverse();
}

export type InboxFilter = 'all' | 'new' | 'hot' | 'qualified' | 'pending' | 'booked' | 'no_reply' | 'clients' | 'handoff';

function inboxFilterCondition(filter: InboxFilter): SQL | undefined {
  switch (filter) {
    case 'new':
      return inArray(leads.status, ['new', 'contacted']);
    case 'hot':
      return inArray(leads.temperature, ['caliente', 'muy_cualificado']);
    case 'qualified':
      return inArray(leads.status, ['qualified', 'call_proposed']);
    case 'pending':
      // Necesita respuesta humana: KAI escalada/pausada o el último mensaje es del lead y nadie ha contestado.
      return or(
        eq(conversations.handoffActive, true),
        and(eq(conversations.aiEnabled, false), sql`${conversations.lastInboundAt} is not null and (${leads.lastOutboundAt} is null or ${leads.lastOutboundAt} < ${conversations.lastInboundAt})`),
      );
    case 'handoff':
      return eq(conversations.handoffActive, true);
    case 'booked':
      return inArray(leads.status, ['call_booked', 'reminder_sent']);
    case 'no_reply':
      return sql`${leads.lastOutboundAt} is not null and (${leads.lastInboundAt} is null or ${leads.lastInboundAt} < ${leads.lastOutboundAt}) and ${leads.lastOutboundAt} < now() - interval '24 hours' and ${leads.status} not in ('client','lost')`;
    case 'clients':
      return eq(leads.status, 'client');
    default:
      return undefined;
  }
}

export async function listInbox(
  businessId: string,
  opts: { filter?: InboxFilter; search?: string; limit?: number; offset?: number; includeTest?: boolean } = {},
) {
  const conds: SQL[] = [eq(conversations.businessId, businessId)];
  if (!opts.includeTest) conds.push(eq(leads.isTest, false));
  const fc = inboxFilterCondition(opts.filter ?? 'all');
  if (fc) conds.push(fc);
  if (opts.search?.trim()) {
    const q = `%${opts.search.trim().replace(/[%_]/g, '')}%`;
    conds.push(sql`(${leads.name} ilike ${q} or ${leads.phone} ilike ${q} or ${leads.instagramUsername} ilike ${q} or ${leads.email} ilike ${q})`);
  }
  const rows = await getDb()
    .select({
      conversation: conversations,
      lead: {
        id: leads.id,
        name: leads.name,
        avatarUrl: leads.avatarUrl,
        source: leads.source,
        status: leads.status,
        score: leads.score,
        temperature: leads.temperature,
        goalSummary: leads.goalSummary,
        nextAction: leads.nextAction,
        nextActionAt: leads.nextActionAt,
        lastInboundAt: leads.lastInboundAt,
        lastOutboundAt: leads.lastOutboundAt,
        instagramUsername: leads.instagramUsername,
        phone: leads.phone,
        optedOut: leads.optedOut,
        isTest: leads.isTest,
      },
    })
    .from(conversations)
    .innerJoin(leads, eq(leads.id, conversations.leadId))
    .where(and(...conds))
    .orderBy(sql`${conversations.handoffActive} desc`, sql`${conversations.lastMessageAt} desc nulls last`)
    .limit(Math.min(opts.limit ?? 50, 200))
    .offset(opts.offset ?? 0);
  return rows;
}

export async function inboxCounts(businessId: string) {
  const filters: InboxFilter[] = ['all', 'new', 'hot', 'qualified', 'pending', 'booked', 'no_reply', 'clients'];
  const out: Record<string, number> = {};
  await Promise.all(
    filters.map(async (f) => {
      const conds: SQL[] = [eq(conversations.businessId, businessId), eq(leads.isTest, false)];
      const fc = inboxFilterCondition(f);
      if (fc) conds.push(fc);
      const [r] = await getDb()
        .select({ n: sql<number>`count(*)::int` })
        .from(conversations)
        .innerJoin(leads, eq(leads.id, conversations.leadId))
        .where(and(...conds));
      out[f] = Number(r?.n ?? 0);
    }),
  );
  return out;
}

export async function getConversationDetail(businessId: string, conversationId: string) {
  const db = getDb();
  const conversation = await getConversation(businessId, conversationId);
  const [lead] = await db
    .select()
    .from(leads)
    .where(and(eq(leads.businessId, businessId), eq(leads.id, conversation.leadId)))
    .limit(1);
  const [msgs, memories, appts, connection] = await Promise.all([
    listMessages(businessId, conversationId),
    db
      .select()
      .from(leadMemories)
      .where(and(eq(leadMemories.businessId, businessId), eq(leadMemories.leadId, conversation.leadId)))
      .orderBy(desc(leadMemories.createdAt))
      .limit(30),
    db
      .select()
      .from(appointments)
      .where(and(eq(appointments.businessId, businessId), eq(appointments.leadId, conversation.leadId)))
      .orderBy(asc(appointments.startsAt)),
    conversation.channelConnectionId
      ? db
          .select({ id: channelConnections.id, displayName: channelConnections.displayName, status: channelConnections.status })
          .from(channelConnections)
          .where(and(eq(channelConnections.businessId, businessId), eq(channelConnections.id, conversation.channelConnectionId)))
          .limit(1)
          .then((r) => r[0] ?? null)
      : Promise.resolve(null),
  ]);
  return { conversation, lead, messages: msgs, memories, appointments: appts, connection };
}

export async function markConversationRead(businessId: string, conversationId: string) {
  await getDb()
    .update(conversations)
    .set({ unreadCount: 0 })
    .where(and(eq(conversations.businessId, businessId), eq(conversations.id, conversationId)));
}

/** El entrenador toma el control: KAI deja de responder en esta conversación. */
export async function takeOverConversation(businessId: string, conversationId: string, userId: string) {
  const conv = await getConversation(businessId, conversationId);
  await getDb()
    .update(conversations)
    .set({ aiEnabled: false, updatedAt: new Date() })
    .where(and(eq(conversations.businessId, businessId), eq(conversations.id, conversationId)));
  await audit({ businessId, actorType: 'user', actorUserId: userId, action: 'conversation.taken_over', entityType: 'conversation', entityId: conv.id });
}

/**
 * Escalado atendido: una persona ya ha respondido al lead. La conversación deja de estar “pendiente”
 * y se cierra el aviso “KAI necesita tu intervención”, pero KAI sigue pausado (el entrenador mantiene
 * el control hasta que pulse «Devolver a KAI»). No hace nada si no había escalado.
 */
export async function markHandoffAttended(
  businessId: string,
  conversationId: string,
  actor: { type: 'user'; userId: string } | { type: 'integration' },
): Promise<boolean> {
  const [conv] = await getDb()
    .update(conversations)
    .set({ handoffActive: false, aiEnabled: false, updatedAt: new Date() })
    .where(and(eq(conversations.businessId, businessId), eq(conversations.id, conversationId), eq(conversations.handoffActive, true)))
    .returning();
  if (!conv) return false;
  await resolveAlertsFor(businessId, { leadId: conv.leadId, type: 'handoff' });
  await audit({
    businessId,
    actorType: actor.type,
    actorUserId: actor.type === 'user' ? actor.userId : null,
    action: 'conversation.handoff_attended',
    entityType: 'conversation',
    entityId: conv.id,
    metadata: { reason: conv.handoffReason },
  });
  return true;
}

/** Devuelve la conversación a KAI y cierra el escalado si lo había. */
export async function releaseConversation(businessId: string, conversationId: string, userId: string) {
  const conv = await getConversation(businessId, conversationId);
  await getDb()
    .update(conversations)
    .set({ aiEnabled: true, handoffActive: false, handoffReason: null, updatedAt: new Date() })
    .where(and(eq(conversations.businessId, businessId), eq(conversations.id, conversationId)));
  await resolveAlertsFor(businessId, { leadId: conv.leadId, type: 'handoff' });
  await audit({ businessId, actorType: 'user', actorUserId: userId, action: 'conversation.released_to_kai', entityType: 'conversation', entityId: conv.id });
}
