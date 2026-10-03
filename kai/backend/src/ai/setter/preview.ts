/**
 * Vista previa del estilo de KAI: genera el primer mensaje que enviaría a un lead de ejemplo
 * con la configuración actual. No guarda nada ni envía nada.
 */
import { randomUUID } from 'node:crypto';
import { analyzeHeuristically } from '../analysis/analyzer.js';
import { loadBusinessContext, type BusinessContext, type ConversationContext, type LeadContext, type LeadRow, type MessageRow } from '../context/context.js';
import { getLLMProvider } from '../providers/index.js';
import { createSetterAgent } from './agents.js';
import { generateValidatedMessage } from './setter-engine.js';
import { decideDirective } from './strategy.js';

export async function previewSetterMessage(businessId: string, leadMessage: string, overrides?: Partial<BusinessContext['settings']>) {
  const loaded = await loadBusinessContext(businessId);
  const biz: BusinessContext = overrides ? { ...loaded, settings: { ...loaded.settings, ...overrides } } : loaded;
  const now = new Date();
  const leadId = randomUUID();
  const conversationId = randomUUID();
  const lead = {
    id: leadId,
    businessId,
    name: 'Carlos',
    phone: null,
    email: null,
    instagramUsername: null,
    instagramUserId: null,
    whatsappId: null,
    avatarUrl: null,
    source: 'instagram',
    sourceDetail: null,
    status: 'new',
    score: 0,
    temperature: 'frio',
    qualification: {},
    signals: {},
    goalSummary: null,
    nextAction: null,
    nextActionAt: null,
    assignedUserId: null,
    tags: [],
    notes: '',
    optedOut: false,
    isTest: true,
    lastInboundAt: now,
    lastOutboundAt: null,
    lastInteractionAt: now,
    firstResponseSeconds: null,
    qualifiedAt: null,
    wonAt: null,
    lostAt: null,
    lostReason: null,
    dealValueCents: null,
    createdAt: now,
    updatedAt: now,
  } satisfies LeadRow;
  const message: MessageRow = {
    id: randomUUID(),
    businessId,
    conversationId,
    leadId,
    direction: 'inbound',
    senderType: 'lead',
    senderUserId: null,
    content: leadMessage,
    contentType: 'text',
    externalId: null,
    status: 'received',
    error: null,
    metadata: {},
    createdAt: now,
  };
  const convCtx: ConversationContext = {
    conversation: {
      id: conversationId,
      businessId,
      leadId,
      channel: 'instagram',
      channelConnectionId: null,
      status: 'open',
      aiEnabled: true,
      handoffActive: false,
      handoffReason: null,
      handoffAt: null,
      unreadCount: 1,
      lastMessageAt: now,
      lastMessagePreview: leadMessage,
      lastInboundAt: now,
      summary: '',
      state: {},
      createdAt: now,
      updatedAt: now,
    },
    history: [message],
    pendingInbound: [message],
    kaiHasSpoken: false,
  };
  const analysis = analyzeHeuristically({ biz, lead, history: [message], pending: [message], state: {}, now });
  const enrichedLead: LeadRow = { ...lead, qualification: analysis.qualification, signals: analysis.signals };
  const leadCtx: LeadContext = { lead: enrichedLead, memories: analysis.memories.map((m) => ({ kind: m.kind, content: m.content })), upcomingAppointment: null };
  const directive = decideDirective({ biz, leadCtx, state: {}, analysis: { ...analysis, flags: { ...analysis.flags, wantsCall: false, asksPrice: false } }, kaiHasSpoken: false });
  const provider = getLLMProvider();
  const gen = await generateValidatedMessage({
    agent: createSetterAgent(provider),
    biz,
    leadCtx,
    convCtx,
    state: {},
    directive,
    toolbox: null,
    mode: 'reply',
    useJudge: false,
  });
  return { leadMessage, reply: gen.text, issues: gen.issues, engine: provider ? 'llm' : 'rules' };
}
