/**
 * Motor del setter: orquesta un turno completo de KAI.
 *
 *  1. Comprueba que KAI puede actuar (piloto automático, escalado, bajas, límites del plan).
 *  2. Analiza los últimos mensajes del lead → cualificación, señales, memoria, alertas.
 *  3. Aplica reglas de seguridad y escalado a humano (médico, enfado, petición de persona…).
 *  4. Decide el objetivo del mensaje (estrategia) y lo redacta (IA o reglas) con herramientas reales.
 *  5. Control de calidad → si falla, regenera; si sigue fallando, pasa la conversación al entrenador.
 *  6. Envía por el canal, actualiza CRM/estado y programa el seguimiento.
 */
import { and, eq } from 'drizzle-orm';
import { getDb } from '../../database/client.js';
import { messages, leads } from '../../database/schema.js';
import { env } from '../../config/env.js';
import { OVER_LIMIT_TAG, type ConversationState, type HandoffReason } from '../../lib/domain.js';
import { errorMessage } from '../../lib/errors.js';
import { audit, logError } from '../../audit/audit.service.js';
import { analyzeLeadMessages, type LeadAnalysis } from '../analysis/analyzer.js';
import { loadBusinessContext, loadConversationContext, loadLeadContext, type BusinessContext, type ConversationContext, type LeadContext } from '../context/context.js';
import { saveLeadMemories } from '../memory/lead-memory.js';
import { getLLMProvider } from '../providers/index.js';
import { SetterToolbox } from '../tools/setter-tools.js';
import { judgeReply, validateReply, type ValidationContext } from '../validation/output-validator.js';
import { createSetterAgent, RuleBasedSetterAgent, type AgentMode, type SetterAgent } from './agents.js';
import { decideDirective, type Directive } from './strategy.js';
import { applyPipelineEvent, markOptedOut, mergeQualification } from '../../crm/leads.service.js';
import { updateConversationState } from '../../crm/conversations.service.js';
import { triggerHandoff } from '../../crm/handoff.service.js';
import { sendMessage, type MessagePurpose } from '../../crm/messaging.service.js';
import { createAlert } from '../../crm/alerts.service.js';
import { checkUsageLimit } from '../../plans/plans.service.js';
import { scheduleNoReplyFollowUp } from '../../automation/followups.js';
import { firstName } from '../../lib/text.js';

export interface SetterRunResult {
  status: 'sent' | 'skipped' | 'handoff' | 'blocked' | 'failed';
  reason?: string;
  messageId?: string;
  text?: string;
  directive?: string;
  attempts?: number;
  analysis?: Pick<LeadAnalysis, 'engine' | 'summary' | 'flags' | 'objectionKey' | 'selectedSlotId'>;
}

const MAX_ATTEMPTS = 3;

export const MEDICAL_MESSAGE =
  'Eso sí que sería mejor revisarlo con un profesional sanitario. En cuanto al entrenamiento, podemos ayudarte a valorar tus objetivos dentro de lo que sea adecuado para ti.';

function defaultHandoffMessage(reason: HandoffReason, trainer: string): string | null {
  switch (reason) {
    case 'human_request':
      return `¡Claro! Le paso tu mensaje a ${trainer} y te escribe directamente en cuanto pueda.`;
    case 'complex_negotiation':
      return `Eso prefiero que lo veas directamente con ${trainer}. Le paso tu mensaje y te responde en cuanto pueda.`;
    case 'out_of_scope':
    case 'exceptional_request':
      return `Le paso tu mensaje a ${trainer} para que te responda directamente.`;
    case 'technical_issue':
      return 'Vaya, lo siento. Le paso el aviso al equipo para revisarlo y te escribimos enseguida.';
    default:
      return null; // enfado, médico (mensaje propio), calidad: sin mensaje automático
  }
}

export function buildValidationContext(biz: BusinessContext, toolbox: SetterToolbox | null, opts: { isFollowUp?: boolean } = {}): ValidationContext {
  const t = biz.trainer;
  return {
    tone: biz.settings.tone,
    wordsToAvoid: biz.settings.wordsToAvoid,
    timezone: biz.business.timezone,
    allowedTimes: toolbox?.allowedTimes() ?? [],
    allowedPricesCents: biz.services.filter((s) => s.priceCents > 0).map((s) => s.priceCents),
    allowedUrls: toolbox?.allowedUrls() ?? [],
    factsText: [t.credentials, t.methodDescription, t.transformation, t.idealClient, ...biz.services.map((s) => `${s.description} ${s.includes.join(' ')}`)].join('\n'),
    isFollowUp: opts.isFollowUp,
    assistantName: biz.settings.assistantName,
  };
}

function factsSummary(biz: BusinessContext, leadCtx: LeadContext, toolbox: SetterToolbox | null): string {
  const services = biz.services.map((s) => `${s.name}: ${(s.priceCents / 100).toFixed(2)} ${s.currency} (${s.billingPeriod}). ${s.description}`).join('\n');
  const times = toolbox?.allowedTimes().map((d) => d.toISOString()).join(', ') || '(ninguno)';
  return [
    `Entrenador: ${biz.trainer.displayName}. Especialidad: ${biz.trainer.specialty}. Método: ${biz.trainer.methodName} ${biz.trainer.methodDescription}`,
    `Credenciales reales: ${biz.trainer.credentials || '(ninguna)'}`,
    `Servicios: ${services || '(sin precio configurado)'}`,
    `Horarios reales ofrecidos/reservados (UTC): ${times}`,
    `Memoria del lead: ${leadCtx.memories.map((m) => m.content).join(' | ') || '(nada)'}`,
    `Cualificación conocida: ${Object.entries(leadCtx.lead.qualification).map(([k, v]) => `${k}=${v.value}`).join(' | ') || '(nada)'}`,
  ].join('\n');
}

/**
 * Genera un mensaje validado. Devuelve null si tras varios intentos no supera el control de calidad.
 */
export async function generateValidatedMessage(input: {
  agent: SetterAgent;
  biz: BusinessContext;
  leadCtx: LeadContext;
  convCtx: ConversationContext;
  state: ConversationState;
  directive: Directive;
  toolbox: SetterToolbox | null;
  mode: AgentMode;
  extraNote?: string;
  followUp?: { step: number; totalSteps: number; angle: string; hoursSilent: number };
  useJudge: boolean;
}): Promise<{ text: string | null; attempts: number; issues: string[]; meta: Record<string, unknown> }> {
  const provider = getLLMProvider();
  let feedback: string[] = [];
  let meta: Record<string, unknown> = {};
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const actionsDone = input.toolbox?.records.filter((r) => r.ok && ['book_call', 'reschedule_call', 'cancel_call'].includes(r.name)) ?? [];
    const extraNote = [
      input.extraNote,
      actionsDone.length ? `Acciones ya realizadas en este turno (no las repitas): ${actionsDone.map((a) => `${a.name} → ${JSON.stringify(a.result)}`).join('; ')}` : '',
    ]
      .filter(Boolean)
      .join('\n');
    let text: string;
    try {
      const out = await input.agent.respond({
        biz: input.biz,
        leadCtx: input.leadCtx,
        convCtx: input.convCtx,
        state: input.state,
        directive: input.directive,
        now: new Date(),
        feedback,
        toolbox: input.toolbox,
        mode: input.mode,
        extraNote,
        followUp: input.followUp,
        firstMessage: input.mode === 'reply' && !input.convCtx.kaiHasSpoken,
      });
      text = out.text;
      meta = out.meta;
    } catch (err) {
      feedback = [`Error al generar: ${errorMessage(err)}`];
      await logError('ai.setter.generate', err, { attempt, directive: input.directive.kind }, input.biz.business.id, 'warn');
      continue;
    }
    const vctx = buildValidationContext(input.biz, input.toolbox, { isFollowUp: input.mode === 'follow_up' });
    vctx.previousMessages = input.convCtx.history
      .filter((m) => m.direction === 'outbound')
      .slice(-4)
      .map((m) => m.content);
    let result = validateReply(text, vctx);
    if (result.ok && input.useJudge && provider && env.AI_JUDGE_ENABLED) {
      result = await judgeReply(provider, {
        reply: text,
        lastLeadMessages: input.convCtx.pendingInbound.map((m) => m.content).join('\n'),
        facts: factsSummary(input.biz, input.leadCtx, input.toolbox),
        objective: input.directive.instruction,
      });
    }
    if (result.ok) return { text, attempts: attempt, issues: [], meta };
    feedback = result.issues;
  }
  return { text: null, attempts: MAX_ATTEMPTS, issues: feedback, meta };
}

async function sendKai(
  biz: BusinessContext,
  conversationId: string,
  text: string,
  purpose: MessagePurpose,
  metadata: Record<string, unknown> = {},
) {
  return sendMessage({ businessId: biz.business.id, conversationId, text, sender: { type: 'kai' }, purpose, metadata });
}

/** Ejecuta un turno de respuesta de KAI en una conversación. */
export async function runSetterReply(businessId: string, conversationId: string, opts: { force?: boolean } = {}): Promise<SetterRunResult> {
  const biz = await loadBusinessContext(businessId);
  let convCtx = await loadConversationContext(businessId, conversationId);
  const conv = convCtx.conversation;
  let leadCtx = await loadLeadContext(businessId, conv.leadId);
  const lead = leadCtx.lead;

  // 1) Guardas.
  if (biz.business.status !== 'active') return { status: 'skipped', reason: 'business_suspended' };
  if (!biz.settings.autopilotEnabled) return { status: 'skipped', reason: 'autopilot_off' };
  if (!conv.aiEnabled) return { status: 'skipped', reason: 'ai_disabled' };
  if (conv.handoffActive) return { status: 'skipped', reason: 'handoff_active' };
  if (lead.optedOut) return { status: 'skipped', reason: 'opted_out' };
  if (lead.status === 'client') return { status: 'skipped', reason: 'already_client' };
  if (convCtx.pendingInbound.length === 0 && !opts.force) return { status: 'skipped', reason: 'nothing_to_answer' };
  if (lead.tags.includes(OVER_LIMIT_TAG)) {
    await triggerHandoff(businessId, conversationId, 'limit_reached', 'El lead entró con el límite de leads del plan superado.');
    return { status: 'handoff', reason: 'limit_reached' };
  }
  const usage = await checkUsageLimit(businessId, 'ai_messages');
  if (!usage.allowed && !lead.isTest) {
    await createAlert({
      businessId,
      type: 'limit_reached',
      severity: 'critical',
      title: 'Límite de mensajes de KAI alcanzado',
      body: `Has usado ${usage.used} de ${usage.limit} mensajes este mes. KAI ha dejado de responder automáticamente.`,
    });
    await triggerHandoff(businessId, conversationId, 'limit_reached');
    return { status: 'handoff', reason: 'limit_reached' };
  }

  const provider = getLLMProvider();
  const lastPending = convCtx.pendingInbound[convCtx.pendingInbound.length - 1];

  // 2) Análisis.
  let analysis: LeadAnalysis | null = null;
  if (convCtx.pendingInbound.length) {
    analysis = await analyzeLeadMessages(provider, {
      biz,
      lead,
      history: convCtx.history,
      pending: convCtx.pendingInbound,
      state: conv.state,
      now: new Date(),
    });
    await mergeQualification(businessId, lead.id, analysis.qualification, analysis.signals, { goalSummary: analysis.goalSummary, name: analysis.leadName });
    if (analysis.memories.length) await saveLeadMemories(businessId, lead.id, analysis.memories, lastPending?.id);
    await getDb()
      .update(messages)
      .set({ metadata: { ...(lastPending?.metadata ?? {}), analysis: { engine: analysis.engine, summary: analysis.summary, flags: analysis.flags, objectionKey: analysis.objectionKey, qualificationKeys: Object.keys(analysis.qualification) } } })
      .where(and(eq(messages.businessId, businessId), eq(messages.id, lastPending.id)));
    const statePatch: Partial<ConversationState> = { lastAnalysisAt: new Date().toISOString() };
    if (analysis.flags.asksPrice) statePatch.priceAskedCount = (conv.state.priceAskedCount ?? 0) + 1;
    if (analysis.flags.medical) statePatch.medicalFlag = true;
    conv.state = await updateConversationState(businessId, conversationId, statePatch);
    leadCtx = await loadLeadContext(businessId, lead.id);
  }
  const analysisSummary = analysis
    ? { engine: analysis.engine, summary: analysis.summary, flags: analysis.flags, objectionKey: analysis.objectionKey, selectedSlotId: analysis.selectedSlotId }
    : undefined;

  // 3) Seguridad y escalado.
  const rules = biz.settings.handoffRules;
  const trainer = biz.trainer.displayName || 'el entrenador';
  const lastText = convCtx.pendingInbound.map((m) => m.content).join(' ').slice(0, 200);
  const handoffDetail = lastText ? `Último mensaje: “${lastText}”` : '';
  if (analysis?.flags.optOut) {
    const bye = 'Entendido, no te escribiremos más. ¡Mucho ánimo!';
    const res = await sendKai(biz, conversationId, bye, 'reply', { kind: 'opt_out_ack' });
    await markOptedOut(businessId, lead.id);
    await audit({ businessId, actorType: 'kai', action: 'lead.opted_out', entityType: 'lead', entityId: lead.id });
    return { status: 'skipped', reason: 'opted_out', messageId: res.message.id, text: bye, analysis: analysisSummary };
  }
  const handoffChecks: [boolean, HandoffReason][] = [
    [Boolean(analysis?.flags.angry && rules.angry), 'angry'],
    [Boolean(analysis?.flags.humanRequest && rules.humanRequest), 'human_request'],
    [Boolean(analysis?.flags.complexNegotiation && rules.complexNegotiation), 'complex_negotiation'],
    [Boolean(analysis?.flags.technicalIssue && rules.technicalIssue), 'technical_issue'],
    [Boolean(analysis?.flags.outOfScope && rules.outOfScope), 'out_of_scope'],
  ];
  if (analysis?.flags.medical && rules.medical) {
    const res = await sendKai(biz, conversationId, MEDICAL_MESSAGE, 'reply', { kind: 'medical_redirect' });
    await triggerHandoff(businessId, conversationId, 'medical', handoffDetail);
    return { status: 'handoff', reason: 'medical', messageId: res.message.id, text: MEDICAL_MESSAGE, analysis: analysisSummary };
  }
  for (const [hit, reason] of handoffChecks) {
    if (!hit) continue;
    let msg = rules.handoffMessage?.trim() || defaultHandoffMessage(reason, trainer);
    if (msg && analysis?.flags.asksIfBot) msg = `Te soy sincero: soy ${biz.settings.assistantName || 'KAI'}, el asistente automatizado del equipo de ${trainer}. ${msg}`;
    let messageId: string | undefined;
    if (msg && reason !== 'angry') messageId = (await sendKai(biz, conversationId, msg, 'handoff', { kind: 'handoff', reason })).message.id;
    await triggerHandoff(businessId, conversationId, reason, handoffDetail);
    return { status: 'handoff', reason, messageId, text: msg ?? undefined, analysis: analysisSummary };
  }

  // 4) Estrategia + redacción.
  const directive = decideDirective({ biz, leadCtx, state: conv.state, analysis, kaiHasSpoken: convCtx.kaiHasSpoken });
  const notes: string[] = [];
  if (analysis?.flags.asksIfBot) notes.push(`El lead pregunta si eres un bot: responde con honestidad que eres el asistente automatizado del equipo de ${trainer} y ofrece pasarle con ${trainer} si lo prefiere.`);
  if (analysis?.flags.medical && !rules.medical) notes.push(`Ha mencionado un tema de salud: incluye con naturalidad esta idea: “${MEDICAL_MESSAGE}”`);
  const toolbox = new SetterToolbox(biz, leadCtx, conv);
  const agent = createSetterAgent(provider);
  let gen = await generateValidatedMessage({ agent, biz, leadCtx, convCtx, state: conv.state, directive, toolbox, mode: 'reply', extraNote: notes.join('\n'), useJudge: true });
  if (!gen.text && provider) {
    // Último recurso: el motor de reglas (determinista y validado) antes de escalar.
    gen = await generateValidatedMessage({ agent: new RuleBasedSetterAgent(), biz, leadCtx, convCtx, state: conv.state, directive, toolbox, mode: 'reply', extraNote: notes.join('\n'), useJudge: false });
  }
  if (!gen.text) {
    await triggerHandoff(businessId, conversationId, 'quality_check_failed', gen.issues.join(' · '));
    return { status: 'handoff', reason: 'quality_check_failed', directive: directive.kind, attempts: gen.attempts, analysis: analysisSummary };
  }

  // 5) ¿Ha cambiado algo mientras generábamos? (nuevo mensaje del lead o el entrenador tomó el control)
  convCtx = await loadConversationContext(businessId, conversationId);
  const newest = convCtx.history[convCtx.history.length - 1];
  if (newest && lastPending && newest.direction === 'inbound' && newest.id !== lastPending.id && !toolbox.booked) {
    return { status: 'skipped', reason: 'superseded', analysis: analysisSummary };
  }
  if (!convCtx.conversation.aiEnabled || convCtx.conversation.handoffActive) return { status: 'skipped', reason: 'taken_over', analysis: analysisSummary };

  // 6) Enviar y actualizar estado.
  const sent = await sendKai(biz, conversationId, gen.text, 'reply', {
    directive: directive.kind,
    attempts: gen.attempts,
    analysisEngine: analysis?.engine,
    toolCalls: toolbox.records,
    ...gen.meta,
  });
  const statePatch: Partial<ConversationState> = {};
  if (directive.questionKey && gen.text.includes('?')) statePatch.lastAskedKey = directive.questionKey;
  else if (!gen.text.includes('?')) statePatch.lastAskedKey = undefined;
  if (directive.kind === 'propose_call') {
    statePatch.callProposedAt = new Date().toISOString();
    if (sent.delivered) await applyPipelineEvent(businessId, lead.id, 'call_proposed');
  }
  if (directive.kind === 'share_price') statePatch.priceShared = true;
  if (directive.kind === 'handle_objection' && directive.objection) statePatch.objectionsHandled = [...(conv.state.objectionsHandled ?? []), directive.objection.key].slice(-10);
  await updateConversationState(businessId, conversationId, statePatch);

  if (toolbox.records.some((r) => r.name === 'get_available_slots' && r.ok && Array.isArray((r.result as { slots?: unknown[] }).slots) && (r.result as { slots: unknown[] }).slots.length === 0)) {
    await createAlert({
      businessId,
      type: 'no_availability',
      title: 'KAI no encontró huecos libres en tu agenda',
      body: `${lead.name || 'Un lead'} quiere agendar y no hay disponibilidad en los próximos días. Revisa tu horario en Agenda.`,
      leadId: lead.id,
      conversationId,
    });
  }
  if (toolbox.handoff) {
    await triggerHandoff(businessId, conversationId, toolbox.handoff.reason, toolbox.handoff.detail);
  } else if (sent.delivered && !toolbox.booked && !leadCtx.upcomingAppointment && directive.kind !== 'disqualify_kindly') {
    await scheduleNoReplyFollowUp(businessId, lead.id, conversationId);
  }
  await audit({ businessId, actorType: 'kai', action: 'kai.reply_sent', entityType: 'conversation', entityId: conversationId, metadata: { directive: directive.kind, attempts: gen.attempts, delivered: sent.delivered } });
  return {
    status: sent.delivered ? 'sent' : 'blocked',
    reason: sent.blockedReason,
    messageId: sent.message.id,
    text: gen.text,
    directive: directive.kind,
    attempts: gen.attempts,
    analysis: analysisSummary,
  };
}

/**
 * Primer contacto con un lead que llega por formulario/anuncio (todavía no ha escrito).
 * - WhatsApp: solo se puede iniciar con una plantilla aprobada (la envía messaging.service).
 * - Simulador: KAI redacta el mensaje con IA/reglas.
 */
export async function runFirstContact(businessId: string, conversationId: string): Promise<SetterRunResult> {
  const biz = await loadBusinessContext(businessId);
  const convCtx = await loadConversationContext(businessId, conversationId);
  const leadCtx = await loadLeadContext(businessId, convCtx.conversation.leadId);
  if (!biz.settings.autopilotEnabled || !convCtx.conversation.aiEnabled || leadCtx.lead.optedOut) return { status: 'skipped', reason: 'disabled' };
  if (convCtx.history.length > 0) return { status: 'skipped', reason: 'conversation_started' };
  const directive = decideDirective({ biz, leadCtx, state: convCtx.conversation.state, analysis: null, kaiHasSpoken: false, isFirstContact: true });
  const provider = getLLMProvider();

  let text: string | null;
  if (convCtx.conversation.channel === 'web') {
    const gen = await generateValidatedMessage({ agent: createSetterAgent(provider), biz, leadCtx, convCtx, state: convCtx.conversation.state, directive, toolbox: null, mode: 'first_contact', useJudge: false });
    text = gen.text ?? (await new RuleBasedSetterAgent().respond({ biz, leadCtx, convCtx, state: convCtx.conversation.state, directive, now: new Date(), feedback: [], toolbox: null, mode: 'first_contact' })).text;
  } else {
    // Texto de referencia; en WhatsApp lo que se envía es la plantilla aprobada.
    text = (await new RuleBasedSetterAgent().respond({ biz, leadCtx, convCtx, state: convCtx.conversation.state, directive, now: new Date(), feedback: [], toolbox: null, mode: 'first_contact' })).text;
  }
  const sent = await sendKai(biz, conversationId, text, 'first_contact', { directive: directive.kind });
  if (directive.questionKey && text.includes('?')) await updateConversationState(businessId, conversationId, { lastAskedKey: directive.questionKey });
  if (!sent.delivered) {
    await createAlert({
      businessId,
      type: 'new_lead_manual',
      title: 'Nuevo lead: contacto manual necesario',
      body: `${leadCtx.lead.name || 'Un lead'} (${leadCtx.lead.source}) no se pudo contactar automáticamente: ${sent.blockedReason ?? ''}`,
      leadId: leadCtx.lead.id,
      conversationId,
    });
  } else {
    await scheduleNoReplyFollowUp(businessId, leadCtx.lead.id, conversationId);
  }
  return { status: sent.delivered ? 'sent' : 'blocked', reason: sent.blockedReason, messageId: sent.message.id, text, directive: directive.kind };
}

/** Redacta un seguimiento contextual (usado por la automatización de seguimientos). */
export async function composeFollowUp(
  businessId: string,
  conversationId: string,
  followUp: { step: number; totalSteps: number; angle: string; hoursSilent: number },
): Promise<{ text: string | null; issues: string[]; meta: Record<string, unknown> }> {
  const biz = await loadBusinessContext(businessId);
  const convCtx = await loadConversationContext(businessId, conversationId);
  const leadCtx = await loadLeadContext(businessId, convCtx.conversation.leadId);
  const st = convCtx.conversation.state;
  const rule = biz.rules.find((r) => r.key === st.lastAskedKey);
  const question = st.callProposedAt
    ? `¿Te viene bien que lo veáis en una ${biz.settings.callLabel} esta semana?`
    : rule?.question;
  const directive: Directive = {
    kind: 'ask_qualification',
    questionKey: st.callProposedAt ? undefined : rule?.key,
    question,
    instruction: `Escribe un mensaje de seguimiento (paso ${followUp.step} de ${followUp.totalSteps}). Enfoque: ${followUp.angle}. Usa algo CONCRETO de la conversación o de la memoria del lead (su objetivo, su motivo, un evento). Prohibido el típico “solo hago seguimiento”. Breve, cercano, sin presión${followUp.step < followUp.totalSteps ? ' y terminando con UNA pregunta fácil de responder' : ', dejando la puerta abierta (sin pregunta obligatoria)'}.`,
  };
  const provider = getLLMProvider();
  const gen = await generateValidatedMessage({
    agent: createSetterAgent(provider),
    biz,
    leadCtx,
    convCtx,
    state: convCtx.conversation.state,
    directive,
    toolbox: null,
    mode: 'follow_up',
    followUp,
    useJudge: true,
  });
  if (gen.text || !provider) return gen;
  return generateValidatedMessage({ agent: new RuleBasedSetterAgent(), biz, leadCtx, convCtx, state: convCtx.conversation.state, directive, toolbox: null, mode: 'follow_up', followUp, useJudge: false });
}

export async function leadDisplayName(businessId: string, leadId: string) {
  const [l] = await getDb()
    .select({ name: leads.name })
    .from(leads)
    .where(and(eq(leads.businessId, businessId), eq(leads.id, leadId)))
    .limit(1);
  return firstName(l?.name) || 'el lead';
}
