/**
 * Construcción del contexto que recibe la IA, separado en tres capas:
 *  - Business Context: quién es el entrenador, qué vende, cómo habla, reglas.
 *  - Lead Context: quién es el lead, qué sabemos de él (cualificación + memoria), citas.
 *  - Conversation Context: historial reciente y estado de la conversación.
 */
import { and, asc, desc, eq, gte } from 'drizzle-orm';
import { getDb } from '../../database/client.js';
import {
  aiSettings,
  appointments,
  businesses,
  conversations,
  leads,
  messages,
  objections,
  qualificationRules,
  services,
  trainers,
} from '../../database/schema.js';
import { notFound } from '../../lib/errors.js';
import { getCalendarConnection } from '../../calendar/connections.js';
import { listLeadMemories } from '../memory/lead-memory.js';

export type BusinessRow = typeof businesses.$inferSelect;
export type TrainerRow = typeof trainers.$inferSelect;
export type AiSettingsRow = typeof aiSettings.$inferSelect;
export type ServiceRow = typeof services.$inferSelect;
export type RuleRow = typeof qualificationRules.$inferSelect;
export type ObjectionRow = typeof objections.$inferSelect;
export type LeadRow = typeof leads.$inferSelect;
export type ConversationRow = typeof conversations.$inferSelect;
export type MessageRow = typeof messages.$inferSelect;
export type AppointmentRow = typeof appointments.$inferSelect;

export interface BusinessContext {
  business: BusinessRow;
  trainer: TrainerRow;
  settings: AiSettingsRow;
  services: ServiceRow[];
  rules: RuleRow[];
  objections: ObjectionRow[];
  calendarProvider: 'internal' | 'google' | 'calendly';
}

export interface LeadContext {
  lead: LeadRow;
  memories: { kind: string; content: string }[];
  upcomingAppointment: AppointmentRow | null;
}

export interface ConversationContext {
  conversation: ConversationRow;
  history: MessageRow[];
  /** Mensajes del lead todavía sin respuesta (pueden ser varios seguidos). */
  pendingInbound: MessageRow[];
  kaiHasSpoken: boolean;
}

export async function loadBusinessContext(businessId: string): Promise<BusinessContext> {
  const db = getDb();
  const [[business], [trainer], [settings], svc, rules, objs, calendar] = await Promise.all([
    db.select().from(businesses).where(eq(businesses.id, businessId)).limit(1),
    db.select().from(trainers).where(eq(trainers.businessId, businessId)).limit(1),
    db.select().from(aiSettings).where(eq(aiSettings.businessId, businessId)).limit(1),
    db
      .select()
      .from(services)
      .where(and(eq(services.businessId, businessId), eq(services.isActive, true)))
      .orderBy(desc(services.isPrimary), asc(services.createdAt)),
    db
      .select()
      .from(qualificationRules)
      .where(and(eq(qualificationRules.businessId, businessId), eq(qualificationRules.enabled, true)))
      .orderBy(asc(qualificationRules.sortOrder)),
    db
      .select()
      .from(objections)
      .where(and(eq(objections.businessId, businessId), eq(objections.enabled, true)))
      .orderBy(asc(objections.sortOrder)),
    getCalendarConnection(businessId),
  ]);
  if (!business || !trainer || !settings) throw notFound('Configuración del negocio incompleta.');
  return { business, trainer, settings, services: svc, rules, objections: objs, calendarProvider: calendar?.provider ?? 'internal' };
}

export async function loadLeadContext(businessId: string, leadId: string): Promise<LeadContext> {
  const db = getDb();
  const [lead] = await db
    .select()
    .from(leads)
    .where(and(eq(leads.businessId, businessId), eq(leads.id, leadId)))
    .limit(1);
  if (!lead) throw notFound('Lead no encontrado.');
  const [memories, [upcoming]] = await Promise.all([
    listLeadMemories(businessId, leadId, 15),
    db
      .select()
      .from(appointments)
      .where(and(eq(appointments.businessId, businessId), eq(appointments.leadId, leadId), eq(appointments.status, 'scheduled'), gte(appointments.endsAt, new Date())))
      .orderBy(asc(appointments.startsAt))
      .limit(1),
  ]);
  return { lead, memories: memories.map((m) => ({ kind: m.kind, content: m.content })), upcomingAppointment: upcoming ?? null };
}

export async function loadConversationContext(businessId: string, conversationId: string, historyLimit = 40): Promise<ConversationContext> {
  const db = getDb();
  const [conversation] = await db
    .select()
    .from(conversations)
    .where(and(eq(conversations.businessId, businessId), eq(conversations.id, conversationId)))
    .limit(1);
  if (!conversation) throw notFound('Conversación no encontrada.');
  const rows = await db
    .select()
    .from(messages)
    .where(and(eq(messages.businessId, businessId), eq(messages.conversationId, conversationId)))
    .orderBy(desc(messages.createdAt))
    .limit(historyLimit);
  const history = rows.reverse().filter((m) => m.status !== 'failed' && m.status !== 'skipped');
  const pendingInbound: MessageRow[] = [];
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].direction === 'inbound') pendingInbound.unshift(history[i]);
    else break;
  }
  return { conversation, history, pendingInbound, kaiHasSpoken: history.some((m) => m.direction === 'outbound') };
}
