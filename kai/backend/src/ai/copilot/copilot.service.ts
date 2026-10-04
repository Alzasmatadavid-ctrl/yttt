/**
 * KAI Copilot: el asistente del ENTRENADOR (no del lead).
 * Entiende peticiones como “¿a quién debería responder ahora?” o “cambia el tono para que sea más directo”,
 * consulta los datos reales del negocio y, para cualquier acción sensible, crea una acción pendiente
 * que el entrenador debe confirmar.
 */
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { DateTime } from 'luxon';
import { getDb } from '../../database/client.js';
import { appointments, businesses, conversations, copilotMessages, leads } from '../../database/schema.js';
import {
  CLOSED_STATUSES,
  LEAD_SOURCES,
  LEAD_STATUS_KEYS,
  LEAD_TEMPERATURES,
  leadSourceLabel,
  leadStatusLabel,
  temperatureLabel,
  type AiTone,
  type AutomationType,
  type LeadSource,
  type LeadStatus,
  type LeadTemperature,
} from '../../lib/domain.js';
import { AppError, errorMessage, limitReached } from '../../lib/errors.js';
import { normalize } from '../../lib/text.js';
import { audit, logError } from '../../audit/audit.service.js';
import type { TenantContext } from '../../auth/guards.js';
import { checkUsageLimit, getLimits, incrementUsage } from '../../plans/plans.service.js';
import { listLeads, type LeadFilters } from '../../crm/leads.service.js';
import { getAnalytics, getDashboard, periodRange } from '../../analytics/analytics.service.js';
import { getLLMProvider } from '../providers/index.js';
import type { ChatBlock, ChatMessage, ToolDefinition, ToolResultBlock } from '../providers/types.js';
import { textOf } from '../providers/types.js';
import { composeFollowUp } from '../setter/setter-engine.js';
import { canPropose, createPendingAction, NOT_ALLOWED_MESSAGE, type PendingActionType } from './copilot-actions.js';
import { env } from '../../config/env.js';

export interface CopilotCard {
  leads?: { id: string; name: string; score: number; temperature: string; status: string; source: string; goal: string | null; lastInboundAt: string | null; lastOutboundAt: string | null; conversationId?: string | null }[];
  appointments?: { id: string; leadId: string; leadName: string; startsAt: string; status: string }[];
  metrics?: Record<string, unknown>;
  draft?: { leadId: string; text: string };
  actions?: { id: string; type: string; summary: string }[];
}

export interface CopilotAnswer {
  text: string;
  data: CopilotCard;
}

// ───────────── Herramientas (lectura + propuestas) ─────────────

const nullable = (schema: Record<string, unknown>) => ({ anyOf: [schema, { type: 'null' }] });

export const COPILOT_TOOLS: ToolDefinition[] = [
  {
    name: 'search_leads',
    description:
      'Busca y ordena leads del negocio con filtros. Úsala para “más calientes”, “sin respuesta”, “de Instagram”, etc. Al filtrar por temperatura o por horas sin respuesta, si no indicas statuses se excluyen los clientes y los perdidos (pásalos en statuses si los quieres).',
    inputSchema: {
      type: 'object',
      properties: {
        temperatures: nullable({ type: 'array', items: { type: 'string', enum: LEAD_TEMPERATURES.map((t) => t.key) } }),
        statuses: nullable({ type: 'array', items: { type: 'string', enum: LEAD_STATUS_KEYS } }),
        sources: nullable({ type: 'array', items: { type: 'string', enum: LEAD_SOURCES.map((s) => s.key) } }),
        no_reply_hours: nullable({ type: 'number' }),
        created_within_days: nullable({ type: 'number' }),
        text: nullable({ type: 'string' }),
        sort: { type: 'string', enum: ['score', 'recent', 'created', 'oldest_reply'] },
        limit: { type: 'integer' },
      },
      required: ['temperatures', 'statuses', 'sources', 'no_reply_hours', 'created_within_days', 'text', 'sort', 'limit'],
      additionalProperties: false,
    },
  },
  {
    name: 'count_leads',
    description: 'Cuenta leads por origen en un periodo (por ejemplo, “¿cuántos leads de Instagram tengo esta semana?”).',
    inputSchema: {
      type: 'object',
      properties: {
        source: nullable({ type: 'string', enum: LEAD_SOURCES.map((s) => s.key) }),
        period: { type: 'string', enum: ['today', 'this_week', '7d', '30d', 'this_month'] },
      },
      required: ['source', 'period'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_appointments',
    description: 'Lista las llamadas agendadas entre dos fechas (YYYY-MM-DD, ambas incluidas).',
    inputSchema: {
      type: 'object',
      properties: { from_date: { type: 'string' }, to_date: { type: 'string' } },
      required: ['from_date', 'to_date'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_metrics',
    description: 'Métricas del embudo (leads, respuesta, cualificación, agendamiento, asistencia, conversión, ingresos).',
    inputSchema: { type: 'object', properties: { period: { type: 'string', enum: ['today', '7d', '30d', '90d'] } }, required: ['period'], additionalProperties: false },
  },
  {
    name: 'get_attention_items',
    description: 'Qué necesita atención ahora: avisos, leads esperando respuesta humana, leads a punto de perderse y llamadas de hoy.',
    inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
  },
  {
    name: 'draft_follow_up',
    description: 'Redacta (sin enviar) un mensaje de seguimiento contextual para un lead.',
    inputSchema: { type: 'object', properties: { lead_id: { type: 'string' } }, required: ['lead_id'], additionalProperties: false },
  },
  {
    name: 'propose_action',
    description:
      'Propone una acción SENSIBLE que el entrenador debe confirmar con un botón: enviar un mensaje, cambiar etapa, eliminar lead, cambiar el tono de KAI, activar/desactivar automatizaciones, pausar/reactivar KAI. Nunca digas que ya está hecha: queda pendiente de confirmación.',
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['send_message', 'change_lead_status', 'delete_lead', 'update_tone', 'toggle_automation', 'toggle_kai_conversation', 'toggle_autopilot'] },
        lead_id: nullable({ type: 'string' }),
        text: nullable({ type: 'string' }),
        status: nullable({ type: 'string', enum: LEAD_STATUS_KEYS }),
        tone: nullable({
          type: 'object',
          properties: {
            formality: nullable({ type: 'integer' }),
            energy: nullable({ type: 'integer' }),
            directness: nullable({ type: 'integer' }),
            emojiUsage: nullable({ type: 'string', enum: ['none', 'low', 'medium', 'high'] }),
            messageLength: nullable({ type: 'string', enum: ['short', 'medium', 'long'] }),
          },
          required: ['formality', 'energy', 'directness', 'emojiUsage', 'messageLength'],
          additionalProperties: false,
        }),
        automation: nullable({ type: 'string', enum: ['followup_no_reply', 'appointment_reminders', 'no_show_recovery', 'post_call'] }),
        enabled: nullable({ type: 'boolean' }),
        summary: { type: 'string', description: 'Resumen en español de lo que se va a hacer.' },
      },
      required: ['type', 'lead_id', 'text', 'status', 'tone', 'automation', 'enabled', 'summary'],
      additionalProperties: false,
    },
  },
];

/** Etapas de leads todavía “abiertos” (ni clientes ni perdidos). */
const OPEN_LEAD_STATUSES: LeadStatus[] = LEAD_STATUS_KEYS.filter((k) => !CLOSED_STATUSES.includes(k));

function leadCard(l: typeof leads.$inferSelect, conversationId?: string | null) {
  return {
    id: l.id,
    name: l.name || 'Sin nombre',
    score: l.score,
    temperature: l.temperature,
    status: l.status,
    source: l.source,
    goal: l.goalSummary,
    lastInboundAt: l.lastInboundAt?.toISOString() ?? null,
    lastOutboundAt: l.lastOutboundAt?.toISOString() ?? null,
    conversationId: conversationId ?? null,
  };
}

async function conversationIdsFor(businessId: string, leadIds: string[]) {
  if (leadIds.length === 0) return new Map<string, string>();
  const rows = await getDb()
    .select({ id: conversations.id, leadId: conversations.leadId })
    .from(conversations)
    .where(and(eq(conversations.businessId, businessId), inArray(conversations.leadId, leadIds)))
    .orderBy(desc(conversations.lastMessageAt));
  const map = new Map<string, string>();
  for (const r of rows) if (!map.has(r.leadId)) map.set(r.leadId, r.id);
  return map;
}

class CopilotTools {
  readonly card: CopilotCard = {};
  constructor(
    private readonly ctx: TenantContext,
    private readonly timezone: string,
  ) {}

  async run(name: string, input: Record<string, unknown>): Promise<unknown> {
    const b = this.ctx.businessId;
    switch (name) {
      case 'search_leads': {
        const temperatures = (input.temperatures as LeadTemperature[] | null) ?? undefined;
        const noReplyHours = (input.no_reply_hours as number | null) ?? undefined;
        let statuses = (input.statuses as LeadStatus[] | null) ?? undefined;
        // “Más calientes” o “sin responder” son leads por los que hay que hacer algo: los clientes ya ganados y
        // los perdidos no entran salvo que se pidan expresamente (con `statuses`).
        if (!statuses?.length && (temperatures?.length || noReplyHours !== undefined)) statuses = OPEN_LEAD_STATUSES;
        const f: LeadFilters = {
          temperature: temperatures,
          status: statuses,
          source: (input.sources as LeadSource[] | null) ?? undefined,
          noReplyHours,
          createdFrom: input.created_within_days ? new Date(Date.now() - Number(input.created_within_days) * 86_400_000) : undefined,
          search: (input.text as string | null) ?? undefined,
          sort: (input.sort as LeadFilters['sort']) ?? 'score',
          limit: Math.min(Math.max(Number(input.limit) || 10, 1), 25),
        };
        const rows = await listLeads(b, f);
        const convs = await conversationIdsFor(b, rows.map((r) => r.id));
        this.card.leads = rows.map((r) => leadCard(r, convs.get(r.id)));
        return { total: rows.length, leads: this.card.leads.map((l) => ({ ...l, status: leadStatusLabel(l.status as LeadStatus), temperature: temperatureLabel(l.temperature as LeadTemperature) })) };
      }
      case 'count_leads': {
        const now = DateTime.now().setZone(this.timezone);
        const p = String(input.period);
        const from =
          p === 'today' ? now.startOf('day') : p === 'this_week' ? now.startOf('week') : p === 'this_month' ? now.startOf('month') : p === '7d' ? now.minus({ days: 7 }) : now.minus({ days: 30 });
        const conds = [eq(leads.businessId, b), eq(leads.isTest, false), sql`${leads.createdAt} >= ${from.toJSDate()}`];
        if (input.source) conds.push(eq(leads.source, input.source as LeadSource));
        const [r] = await getDb().select({ n: sql<number>`count(*)::int` }).from(leads).where(and(...conds));
        const result = { count: r?.n ?? 0, source: input.source ? leadSourceLabel(input.source as LeadSource) : 'todos', since: from.toISODate() };
        this.card.metrics = { ...this.card.metrics, leadCount: result };
        return result;
      }
      case 'list_appointments': {
        const from = DateTime.fromISO(String(input.from_date), { zone: this.timezone }).startOf('day');
        const to = DateTime.fromISO(String(input.to_date), { zone: this.timezone }).endOf('day');
        if (!from.isValid || !to.isValid) return { error: 'Fechas no válidas (usa YYYY-MM-DD).' };
        const rows = await getDb()
          .select({ a: appointments, name: leads.name })
          .from(appointments)
          .innerJoin(leads, and(eq(leads.id, appointments.leadId), eq(leads.businessId, appointments.businessId)))
          .where(
            and(
              eq(appointments.businessId, b),
              // Las citas del simulador no son llamadas reales (igual que en el panel).
              eq(leads.isTest, false),
              sql`${appointments.startsAt} >= ${from.toJSDate()} and ${appointments.startsAt} <= ${to.toJSDate()}`,
              sql`${appointments.status} in ('scheduled','completed','no_show')`,
            ),
          )
          .orderBy(asc(appointments.startsAt));
        this.card.appointments = rows.map((r) => ({ id: r.a.id, leadId: r.a.leadId, leadName: r.name || 'Sin nombre', startsAt: r.a.startsAt.toISOString(), status: r.a.status }));
        return {
          appointments: rows.map((r) => ({ lead: r.name, when: DateTime.fromJSDate(r.a.startsAt).setZone(this.timezone).setLocale('es').toFormat("cccc d 'de' LLLL, HH:mm"), status: r.a.status })),
        };
      }
      case 'get_metrics': {
        const advanced = (await getLimits(b)).advancedAnalytics;
        const requested = (['today', '7d', '30d', '90d'] as const).find((p) => p === input.period) ?? '7d';
        // Sin analítica avanzada, el periodo de 90 días se limita a 30 (igual que en la pantalla de Analítica).
        const period = requested === '90d' && !advanced ? '30d' : requested;
        const a = await getAnalytics(b, period, undefined, { advanced });
        const m = { period, ...a.funnel, roi: a.roi, pipeline: a.value, insights: a.insights.map((i) => ({ title: i.title, detail: i.detail })), insightsLocked: a.insightsLocked };
        this.card.metrics = { ...this.card.metrics, funnel: a.funnel, roi: a.roi };
        return m;
      }
      case 'get_attention_items': {
        const d = await getDashboard(b);
        this.card.metrics = { ...this.card.metrics, activity: d.activity };
        return {
          alerts: d.attention.alerts.map((x) => ({ title: x.alert.title, body: x.alert.body, lead: x.leadName })),
          waitingForHuman: d.attention.waiting.map((w) => ({ lead: w.name, score: w.score, lastMessage: w.preview })),
          atRisk: d.attention.atRisk.map((l) => ({ lead: l.name, score: l.score, status: leadStatusLabel(l.status) })),
          callsToday: d.callsToday.map((c) => ({ lead: c.leadName, at: DateTime.fromJSDate(c.appointment.startsAt).setZone(this.timezone).toFormat('HH:mm') })),
          activity: d.activity,
        };
      }
      case 'draft_follow_up': {
        const leadId = String(input.lead_id);
        const convs = await conversationIdsFor(b, [leadId]);
        const convId = convs.get(leadId);
        if (!convId) return { error: 'Ese lead no tiene conversación.' };
        const draft = await composeFollowUp(b, convId, { step: 1, totalSteps: 3, angle: 'Retomar la conversación con algo concreto que dijo el lead.', hoursSilent: 24 });
        if (!draft.text) return { error: 'No se pudo redactar un seguimiento de calidad.' };
        this.card.draft = { leadId, text: draft.text };
        return { draft: draft.text };
      }
      case 'propose_action': {
        const type = String(input.type) as PendingActionType;
        const payload: Record<string, unknown> = { summary: input.summary };
        if (input.lead_id) payload.leadId = input.lead_id;
        if (input.text) payload.text = input.text;
        if (input.status) payload.status = input.status;
        if (input.automation) payload.automation = input.automation as AutomationType;
        if (input.enabled !== null && input.enabled !== undefined) payload.enabled = input.enabled;
        if (input.tone) {
          const t = input.tone as Record<string, unknown>;
          const tone: Partial<AiTone> = {};
          for (const k of ['formality', 'energy', 'directness'] as const) if (typeof t[k] === 'number') tone[k] = Math.min(5, Math.max(1, Math.round(t[k] as number)));
          if (t.emojiUsage) tone.emojiUsage = t.emojiUsage as AiTone['emojiUsage'];
          if (t.messageLength) tone.messageLength = t.messageLength as AiTone['messageLength'];
          payload.tone = tone;
        }
        if (!canPropose(this.ctx, type)) return { error: NOT_ALLOWED_MESSAGE, not_allowed: true };
        let action: Awaited<ReturnType<typeof createPendingAction>>;
        try {
          action = await createPendingAction(this.ctx, type, payload);
        } catch (err) {
          // Propuesta incompleta o que no pasa el control de calidad: se explica (al modelo o al entrenador) en vez de fallar.
          if (err instanceof AppError && err.statusCode < 500) return { error: err.message, ...(err.details ? { details: err.details } : {}) };
          throw err;
        }
        this.card.actions = [...(this.card.actions ?? []), { id: action.id, type: action.type, summary: action.summary }];
        return { pending_confirmation: true, summary: action.summary };
      }
      default:
        return { error: `Herramienta desconocida: ${name}` };
    }
  }
}

function copilotSystemPrompt(ctx: { businessName: string; timezone: string; userName: string }) {
  const now = DateTime.now().setZone(ctx.timezone).setLocale('es');
  return `Eres KAI Copilot, el asistente del entrenador dentro de KAI (setter IA + CRM + agenda).
Hablas con ${ctx.userName} sobre su negocio “${ctx.businessName}”. Fecha y hora: ${now.toFormat("cccc d 'de' LLLL yyyy, HH:mm")} (${ctx.timezone}). Hoy es ${now.toISODate()}, mañana es ${now.plus({ days: 1 }).toISODate()}.

Reglas:
- Usa SIEMPRE las herramientas para obtener datos reales. Nunca inventes leads, cifras ni citas.
- Acciones sensibles (enviar mensajes, cambiar configuraciones, cambiar etapas, eliminar, activar/desactivar automatizaciones, pausar KAI): usa propose_action. Quedan PENDIENTES de confirmación: dilo claramente (“te dejo la acción preparada para que la confirmes”).
- Para escribir un seguimiento, usa draft_follow_up y, si el entrenador quiere enviarlo, propose_action con type=send_message.
- Responde en español, breve, claro y accionable. Puedes usar listas cortas. Prioriza: qué hacer ahora y por qué.
- Los datos de los leads se muestran también como tarjetas en la interfaz: no hace falta repetir todos los campos.`;
}

// ───────────── Copilot con IA ─────────────

async function answerWithLLM(ctx: TenantContext, question: string, history: ChatMessage[], meta: { businessName: string; timezone: string; userName: string }): Promise<CopilotAnswer> {
  const provider = getLLMProvider()!;
  const tools = new CopilotTools(ctx, meta.timezone);
  const messages: ChatMessage[] = [...history, { role: 'user', content: question }];
  for (let i = 0; i < 6; i++) {
    const res = await provider.chat({ tier: 'main', system: [{ text: copilotSystemPrompt(meta), cache: false }], messages, tools: COPILOT_TOOLS, maxTokens: 4096, effort: env.AI_COPILOT_EFFORT });
    const calls = res.blocks.filter((b) => b.type === 'tool_call');
    if (calls.length === 0) return { text: textOf(res.blocks) || 'No he podido generar una respuesta.', data: tools.card };
    messages.push({ role: 'assistant', content: res.blocks as ChatBlock[], providerRaw: res.raw });
    const results: ToolResultBlock[] = [];
    for (const c of calls) {
      if (c.type !== 'tool_call') continue;
      try {
        results.push({ type: 'tool_result', toolCallId: c.id, content: JSON.stringify(await tools.run(c.name, c.input)) });
      } catch (err) {
        results.push({ type: 'tool_result', toolCallId: c.id, content: JSON.stringify({ error: errorMessage(err) }), isError: true });
      }
    }
    messages.push({ role: 'user', content: results });
  }
  return { text: 'He necesitado demasiados pasos para responder. ¿Puedes concretar un poco más la pregunta?', data: tools.card };
}

// ───────────── Copilot por reglas (modo simulación) ─────────────

type LeadRow = Awaited<ReturnType<typeof listLeads>>[number];

/** Palabras de un texto en minúsculas, sin tildes ni signos (para comparar nombres por palabra completa). */
function nameWords(text: string): string[] {
  return normalize(text)
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/**
 * Leads mencionados por su nombre en la petición del entrenador.
 * - Compara por palabras completas: “Eva” no está en “lleva”, ni “Ana” en “Mariana”.
 * - Se queda con la coincidencia más larga: con “para Carlos Ruiz”, Carlos Ruiz gana a otro Carlos.
 * Devuelve todos los que encajan igual de bien: si hay más de uno, hay que pedir que lo aclare
 * (mejor preguntar que preparar el mensaje para otra persona).
 */
export async function findLeadsByName(businessId: string, text: string): Promise<LeadRow[]> {
  const all = await listLeads(businessId, { sort: 'recent', limit: 200 });
  const said = nameWords(text);
  const mentions = (seq: string[]) => said.some((_, i) => seq.every((w, j) => said[i + j] === w));
  let best = 0;
  let matches: LeadRow[] = [];
  for (const lead of all) {
    const parts = nameWords(lead.name ?? '');
    if (!parts.length || parts[0].length < 3) continue;
    // Nº de palabras del nombre (empezando por el nombre de pila) que aparecen seguidas en la petición.
    let score = 0;
    for (let n = parts.length; n >= 1; n--) {
      if (mentions(parts.slice(0, n))) {
        score = n;
        break;
      }
    }
    if (score === 0 || score < best) continue;
    if (score > best) {
      best = score;
      matches = [];
    }
    matches.push(lead);
  }
  return matches;
}

async function answerWithRules(ctx: TenantContext, question: string, timezone: string): Promise<CopilotAnswer> {
  const tools = new CopilotTools(ctx, timezone);
  const n = normalize(question);
  const now = DateTime.now().setZone(timezone);

  if (/a quien (deberia|debo|tengo que) (responder|contestar|escribir)|que (hago|reviso) (ahora|primero)|necesita(n)? (atencion|respuesta)|prioridad/.test(n)) {
    const items = (await tools.run('get_attention_items', {})) as { waitingForHuman: { lead: string }[]; alerts: { title: string; lead: string | null }[]; atRisk: { lead: string }[]; callsToday: unknown[] };
    await tools.run('search_leads', { temperatures: ['caliente', 'muy_cualificado'], statuses: null, sources: null, no_reply_hours: null, created_within_days: null, text: null, sort: 'score', limit: 5 });
    const parts = [
      items.waitingForHuman.length ? `Esperan tu respuesta: ${items.waitingForHuman.map((w) => w.lead || 'sin nombre').join(', ')}.` : 'Ningún lead está esperando respuesta humana ahora mismo.',
      items.alerts.length ? `Tienes ${items.alerts.length} aviso(s) abiertos (el primero: “${items.alerts[0].title}”).` : '',
      items.atRisk.length ? `A punto de perderse: ${items.atRisk.map((a) => a.lead || 'sin nombre').join(', ')}.` : '',
    ].filter(Boolean);
    return { text: `${parts.join(' ')} Abajo tienes tus leads más calientes ordenados por puntuación.`, data: tools.card };
  }
  if (/(que|como) (puedo|podria|deberia) mejorar|que has aprendido|aprendizajes?|recomendaciones|consejos|que funciona mejor|donde (pierdo|se pierden)/.test(n)) {
    const m = (await tools.run('get_metrics', { period: '30d' })) as { insights: { title: string; detail: string }[]; insightsLocked: boolean };
    if (m.insightsLocked) return { text: 'Las recomendaciones basadas en tus datos están incluidas en los planes con analítica avanzada (Pro y Agency). Puedes ver tu plan en Ajustes → Plan.', data: tools.card };
    if (!m.insights.length) return { text: 'Todavía no hay datos suficientes para sacar conclusiones fiables. Cuando tengas más leads y llamadas, te diré qué funciona mejor y dónde se pierden.', data: tools.card };
    return { text: `Esto es lo que dicen tus datos de los últimos 30 días: ${m.insights.map((i) => `${i.title}. ${i.detail}`).join(' ')}`, data: tools.card };
  }
  if (/calientes|mas cualificados|mejores leads|leads? (mas )?interesados/.test(n)) {
    const r = (await tools.run('search_leads', { temperatures: ['caliente', 'muy_cualificado'], statuses: null, sources: null, no_reply_hours: null, created_within_days: null, text: null, sort: 'score', limit: 10 })) as { total: number };
    return { text: r.total ? `Estos son tus ${r.total} leads más calientes, ordenados por puntuación.` : 'Ahora mismo no tienes leads calientes. KAI seguirá cualificando las conversaciones abiertas.', data: tools.card };
  }
  const hoursMatch = /(\d+)\s*h(oras)?\b/.exec(n);
  if (/sin responder|sin respuesta|no (han )?respond|no contesta/.test(n)) {
    const hours = hoursMatch ? Number(hoursMatch[1]) : 24;
    const r = (await tools.run('search_leads', { temperatures: null, statuses: null, sources: null, no_reply_hours: hours, created_within_days: null, text: null, sort: 'oldest_reply', limit: 15 })) as { total: number };
    return { text: r.total ? `${r.total} lead(s) llevan más de ${hours} horas sin responder. KAI les hace seguimiento automático si la automatización está activa.` : `Nadie lleva más de ${hours} horas sin responder.`, data: tools.card };
  }
  if (/llamadas?|citas?|agenda/.test(n) && /hoy|manana|semana|proxim/.test(n)) {
    let from = now.startOf('day');
    let to = now.endOf('day');
    let label = 'hoy';
    if (/pasado manana/.test(n)) {
      from = from.plus({ days: 2 });
      to = to.plus({ days: 2 });
      label = 'pasado mañana';
    } else if (/manana/.test(n)) {
      from = from.plus({ days: 1 });
      to = to.plus({ days: 1 });
      label = 'mañana';
    } else if (/semana|proxim/.test(n)) {
      to = now.plus({ days: 7 }).endOf('day');
      label = 'los próximos 7 días';
    }
    const r = (await tools.run('list_appointments', { from_date: from.toISODate(), to_date: to.toISODate() })) as { appointments?: { lead: string; when: string }[] };
    const list = r.appointments ?? [];
    return { text: list.length ? `Tienes ${list.length} llamada(s) ${label}: ${list.map((a) => `${a.lead || 'sin nombre'} (${a.when})`).join('; ')}.` : `No tienes llamadas ${label}.`, data: tools.card };
  }
  if (/cuantos leads/.test(n)) {
    const source = LEAD_SOURCES.find((s) => n.includes(normalize(s.label)) || (s.key === 'meta_ads' && /anuncio|meta|facebook/.test(n)))?.key ?? null;
    const period = /hoy/.test(n) ? 'today' : /mes/.test(n) ? 'this_month' : 'this_week';
    const r = (await tools.run('count_leads', { source, period })) as { count: number; source: string };
    const periodLabel = period === 'today' ? 'hoy' : period === 'this_month' ? 'este mes' : 'esta semana';
    return { text: `Tienes ${r.count} lead(s) ${source ? `de ${r.source} ` : ''}${periodLabel}.`, data: tools.card };
  }
  if (/tono|mas directo|mas cercano|mas formal|mas informal|emojis/.test(n)) {
    const tone: Record<string, unknown> = { formality: null, energy: null, directness: null, emojiUsage: null, messageLength: null };
    const changes: string[] = [];
    const rules: [RegExp, string, unknown, string][] = [
      [/mas directo/, 'directness', 5, 'más directo'],
      [/menos directo|mas suave/, 'directness', 2, 'más suave'],
      [/mas formal/, 'formality', 4, 'más formal'],
      [/mas cercano|mas informal/, 'formality', 2, 'más cercano'],
      [/mas energ|mas motivador/, 'energy', 5, 'con más energía'],
      [/sin emojis|quita (los )?emojis/, 'emojiUsage', 'none', 'sin emojis'],
      [/mas corto|mensajes cortos/, 'messageLength', 'short', 'mensajes más cortos'],
    ];
    for (const [rx, key, value, label] of rules) {
      if (rx.test(n)) {
        tone[key] = value;
        changes.push(label);
      }
    }
    if (changes.length === 0) return { text: 'Dime cómo quieres el tono (más directo, más cercano, más formal, sin emojis, mensajes más cortos…) y te preparo el cambio para que lo confirmes.', data: {} };
    const proposed = (await tools.run('propose_action', { type: 'update_tone', lead_id: null, text: null, status: null, tone, automation: null, enabled: null, summary: changes.join(', ') })) as { error?: string };
    if (proposed.error) return { text: proposed.error, data: tools.card };
    return { text: `Te he preparado el cambio de tono (${changes.join(', ')}). Confírmalo para aplicarlo.`, data: tools.card };
  }
  if (/(escribe|redacta|prepara|haz).*(seguimiento|mensaje)/.test(n)) {
    const found = await findLeadsByName(ctx.businessId, question);
    if (found.length === 0) return { text: 'Dime el nombre del lead para el que quieres el seguimiento (o ábrelo desde la bandeja y pídemelo ahí).', data: {} };
    if (found.length > 1) {
      // Varios leads con ese nombre: se muestran para que el entrenador elija, sin preparar nada todavía.
      const shown = found.slice(0, 5);
      const convs = await conversationIdsFor(ctx.businessId, shown.map((l) => l.id));
      return {
        text: `Tienes varios leads que encajan con ese nombre (${shown.map((l) => l.name).join(', ')}). Dime el nombre completo de a quién quieres escribir, o abre su conversación y pídemelo desde ahí.`,
        data: { leads: shown.map((l) => leadCard(l, convs.get(l.id))) },
      };
    }
    const lead = found[0];
    const r = (await tools.run('draft_follow_up', { lead_id: lead.id })) as { draft?: string; error?: string };
    if (!r.draft) return { text: r.error ?? 'No he podido redactar el seguimiento.', data: tools.card };
    const proposed = (await tools.run('propose_action', { type: 'send_message', lead_id: lead.id, text: r.draft, status: null, tone: null, automation: null, enabled: null, summary: `Enviar seguimiento a ${lead.name}` })) as { error?: string };
    if (proposed.error) return { text: `Este es el seguimiento que propongo para ${lead.name}: “${r.draft}”. ${proposed.error}`, data: tools.card };
    return { text: `Este es el seguimiento que propongo para ${lead.name}. Si te encaja, confírmalo y se envía.`, data: tools.card };
  }
  if (/metricas|resumen|como vamos|estadisticas|conversion/.test(n)) {
    const m = (await tools.run('get_metrics', { period: /mes|30/.test(n) ? '30d' : '7d' })) as { leads: number; qualified: number; booked: number; clients: number; rates: { conversion: number } };
    return { text: `Resumen: ${m.leads} leads, ${m.qualified} cualificados, ${m.booked} con llamada y ${m.clients} clientes (conversión ${m.rates.conversion}%).`, data: tools.card };
  }
  return {
    text: 'Puedo ayudarte con cosas como: “¿A quién debería responder ahora?”, “¿Qué leads están más calientes?”, “¿Quién lleva más de 24 horas sin responder?”, “Muéstrame las llamadas de mañana”, “¿Cuántos leads de Instagram tengo esta semana?”, “Cambia el tono de KAI para que sea más directo” o “Escribe un seguimiento para Carlos”.',
    data: {},
  };
}

// ───────────── Entrada pública ─────────────

export async function askCopilot(ctx: TenantContext, question: string, userName: string): Promise<CopilotAnswer & { id: string }> {
  const db = getDb();
  const limits = await getLimits(ctx.businessId);
  if (!limits.copilot) throw limitReached('Tu plan no incluye KAI Copilot.');
  const usage = await checkUsageLimit(ctx.businessId, 'copilot_queries');
  if (!usage.allowed) throw limitReached('Has alcanzado el límite de uso de IA de tu plan este mes.');
  const [biz] = await db.select().from(businesses).where(eq(businesses.id, ctx.businessId)).limit(1);
  const meta = { businessName: biz?.name ?? '', timezone: biz?.timezone ?? 'Europe/Madrid', userName };

  await db.insert(copilotMessages).values({ businessId: ctx.businessId, userId: ctx.userId, role: 'user', content: question.slice(0, 2000) });
  const previous = await db
    .select()
    .from(copilotMessages)
    .where(and(eq(copilotMessages.businessId, ctx.businessId), eq(copilotMessages.userId, ctx.userId)))
    .orderBy(desc(copilotMessages.createdAt))
    .limit(9);
  const history: ChatMessage[] = previous
    .slice(1)
    .reverse()
    .map((m) => ({ role: m.role, content: m.content }));
  while (history.length && history[0].role !== 'user') history.shift();

  let answer: CopilotAnswer;
  try {
    answer = getLLMProvider() ? await answerWithLLM(ctx, question, history, meta) : await answerWithRules(ctx, question, meta.timezone);
  } catch (err) {
    await logError('ai.copilot', err, {}, ctx.businessId);
    answer = await answerWithRules(ctx, question, meta.timezone).catch(() => ({ text: 'Ahora mismo no puedo responder. Inténtalo de nuevo en un momento.', data: {} }));
  }
  const [saved] = await db
    .insert(copilotMessages)
    .values({ businessId: ctx.businessId, userId: ctx.userId, role: 'assistant', content: answer.text, data: answer.data as Record<string, unknown> })
    .returning();
  await incrementUsage(ctx.businessId, 'copilot_queries');
  await audit({ businessId: ctx.businessId, actorType: 'user', actorUserId: ctx.userId, action: 'copilot.query', metadata: { question: question.slice(0, 200) } });
  return { ...answer, id: saved.id };
}

export async function copilotHistory(ctx: TenantContext, limit = 40) {
  const rows = await getDb()
    .select()
    .from(copilotMessages)
    .where(and(eq(copilotMessages.businessId, ctx.businessId), eq(copilotMessages.userId, ctx.userId)))
    .orderBy(desc(copilotMessages.createdAt))
    .limit(limit);
  return rows.reverse();
}

export { periodRange };
