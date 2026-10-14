/**
 * Revisión nº5 (motor del setter), de extremo a extremo con base de datos en memoria:
 *  - si el calendario conectado no responde, la conversación pasa al entrenador (y no se programa seguimiento);
 *  - los textos fijos de traspaso, baja y aviso sanitario respetan el trato «de usted»;
 *  - el juez con IA revisa también el primer contacto y, si no responde, el borrador no se aprueba en silencio;
 *  - tras proponer la llamada u ofrecer horarios, la siguiente respuesta ya no cuenta como la última variable preguntada;
 *  - al lead que no encaja no se le programan seguimientos aunque se le dé el precio;
 *  - el juez recibe los mismos datos del negocio que la IA (lo que incluye el servicio, duración, la llamada…);
 *  - la IA no puede reservar ni cancelar por su cuenta (solo lo que pide el objetivo del turno);
 *  - si el lead escribe mientras KAI cancela o envía su respuesta, la acción se confirma y su mensaje no se pierde.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { getDb } from '../../src/database/client.js';
import { alerts, appointments, conversations, errorLogs, followUps, leadEvents, messages, scheduledJobs } from '../../src/database/schema.js';
import { ensureDirectiveAction, factsSummary, qualityIssueSummary, runFirstContact, runSetterReply } from '../../src/ai/setter/setter-engine.js';
import type { Directive, SetterState } from '../../src/ai/setter/strategy.js';
import { isDeniedRecord, SetterToolbox, type ToolboxPolicy } from '../../src/ai/tools/setter-tools.js';
import { loadBusinessContext, loadConversationContext, loadLeadContext, withLateInboundLast, type MessageRow } from '../../src/ai/context/context.js';
import { bookAppointment } from '../../src/calendar/calendar.service.js';
import { saveCalendarConnection } from '../../src/calendar/connections.js';
import { slotStartFromId } from '../../src/calendar/availability.js';
import { ingestExternalLead, receiveInboundForConversation } from '../../src/webhooks/inbound.service.js';
import { setLLMProvider } from '../../src/ai/providers/index.js';
import type { ChatRequest, ChatResponse, LLMProvider } from '../../src/ai/providers/types.js';
import { DEFAULT_TONE } from '../../src/lib/domain.js';
import { futureLocal, openAgenda, registerTrainer, setupTestApp, teardownTestApp, type Trainer } from './helpers.js';

const SERVICE = {
  name: 'Programa Recomposición',
  priceCents: 14900,
  billingPeriod: 'monthly',
  description: 'Entrenamiento y nutrición online con seguimiento.',
  durationWeeks: 12,
  includes: ['Plan de entrenamiento personalizado', 'Pautas de nutrición flexibles', 'Seguimiento semanal por WhatsApp'],
};

const ANSWERS: Record<string, string> = {
  goal: 'Quiero perder unos 10 kilos, sobre todo la barriga',
  current_situation: 'Trabajo en oficina, ahora mismo no entreno y como bastante mal',
  problem: 'Me cuesta ser constante, lo dejo a las dos semanas',
  motivation: 'Por salud, tengo dos hijos pequeños y quiero estar bien',
  previous_attempts: 'He probado dietas y el gimnasio por mi cuenta',
  frustration: 'Que siempre recupero el peso y me desanimo',
  urgency: 'Quiero empezar ya, cuanto antes',
  commitment: 'Sí, estoy dispuesto, voy en serio',
  budget: 'Sí, puedo invertir si merece la pena',
};

interface SetterResult {
  status: 'sent' | 'skipped' | 'handoff' | 'blocked' | 'failed';
  reason?: string;
  text?: string;
  directive?: string;
}

let app: FastifyInstance;
let T: Trainer;

beforeAll(async () => {
  app = await setupTestApp();
  T = await registerTrainer(app, { name: 'Álex Romero', businessName: 'Álex Fit' });
  await openAgenda(T.client);
  const svc = await T.client.put('/api/settings/primary-service', SERVICE);
  expect(svc.statusCode, svc.body).toBe(200);
});

afterAll(async () => {
  await teardownTestApp(app);
});

afterEach(() => {
  setLLMProvider(undefined);
  vi.unstubAllGlobals();
});

class Sim {
  constructor(
    readonly t: Trainer,
    readonly id: string,
    readonly leadId: string,
  ) {}

  static async start(leadName: string, t: Trainer = T) {
    const res = await t.client.post('/api/simulator/conversations', { leadName });
    expect(res.statusCode).toBe(200);
    return new Sim(t, res.json().conversationId, res.json().leadId);
  }

  async say(text: string): Promise<SetterResult> {
    const res = await this.t.client.post(`/api/simulator/conversations/${this.id}/messages`, { text });
    expect(res.statusCode, res.body).toBe(200);
    return res.json().result as SetterResult;
  }

  async conversation() {
    const [c] = await getDb().select().from(conversations).where(eq(conversations.id, this.id));
    return c;
  }

  async state(): Promise<SetterState> {
    return (await this.conversation()).state as SetterState;
  }

  async messages() {
    return getDb().select().from(messages).where(eq(messages.conversationId, this.id)).orderBy(messages.createdAt);
  }

  async appointments() {
    return getDb().select().from(appointments).where(eq(appointments.leadId, this.leadId));
  }

  async scheduledFollowUps() {
    return getDb()
      .select()
      .from(followUps)
      .where(and(eq(followUps.leadId, this.leadId), eq(followUps.status, 'scheduled')));
  }

  /** Llamada ya agendada (la reserva el entrenador a mano). */
  async book(daysAhead: number, hour: number) {
    return bookAppointment({ businessId: this.t.businessId, leadId: this.leadId, conversationId: this.id, start: futureLocal(daysAhead, hour), bookedBy: 'human', actor: { type: 'user', userId: this.t.userId } });
  }

  async toolbox(policy?: ToolboxPolicy) {
    const biz = await loadBusinessContext(this.t.businessId);
    const leadCtx = await loadLeadContext(this.t.businessId, this.leadId);
    const conv = (await loadConversationContext(this.t.businessId, this.id)).conversation;
    return { box: new SetterToolbox(biz, leadCtx, conv, policy), biz, leadCtx };
  }
}

// ───────────── Proveedor de IA falso ─────────────

const USAGE = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0 };
const textReply = (text: string): ChatResponse => ({ blocks: [{ type: 'text', text }], stopReason: 'end_turn', raw: null, usage: USAGE, model: 'fake' });
const toolReply = (name: string, input: Record<string, unknown>): ChatResponse => ({
  blocks: [{ type: 'tool_call', id: `call_${name}`, name, input }],
  stopReason: 'tool_use',
  raw: null,
  usage: USAGE,
  model: 'fake',
});

const OK_VERDICT = { responds_to_last_message: true, sounds_human: true, invents_information: false, pressures_lead: false, breaks_business_rules: false, issues: [] as string[] };

/**
 * IA falsa: `chat` responde con la función indicada (n = número de llamada). `structured` hace de juez: con
 * judge 'ok' aprueba, con 'fail' falla; cualquier otra petición estructurada (el análisis) falla y se usan las reglas.
 */
function fakeProvider(chat: (req: ChatRequest, n: number) => ChatResponse | Promise<ChatResponse>, judge: 'ok' | 'fail' = 'ok') {
  const calls = { chat: 0, judge: 0 };
  const provider: LLMProvider = {
    id: 'fake',
    describe: () => ({ provider: 'fake', mainModel: 'fake', fastModel: 'fake' }),
    chat: async (req) => chat(req, ++calls.chat),
    structured: (async (req: { schema: { safeParse: (v: unknown) => { success: boolean } } }) => {
      if (!req.schema.safeParse(OK_VERDICT).success) throw new Error('análisis no simulado');
      calls.judge++;
      if (judge === 'fail') throw new Error('Juez caído (simulado)');
      return OK_VERDICT;
    }) as LLMProvider['structured'],
  };
  setLLMProvider(provider);
  return calls;
}

// ───────────── Calendario caído ─────────────

describe('calendario conectado que no responde', () => {
  it('KAI no deja colgada la promesa de «te escribo con opciones»: pasa la conversación al entrenador y no programa seguimiento', async () => {
    const G = await registerTrainer(app, { name: 'Gonzalo Google', businessName: 'Gonzalo Coach' });
    await openAgenda(G.client);
    await saveCalendarConnection(G.businessId, G.userId, {
      provider: 'google',
      credentials: { accessToken: 'token-caducado', refreshToken: 'refresh-revocado', expiresAt: Date.now() + 24 * 3600_000 },
      calendarId: 'primary',
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ error: { code: 401, message: 'Invalid Credentials' } }, { status: 401 })),
    );

    // La herramienta: devuelve el error con instrucciones y deja marcado el traspaso.
    const probe = await Sim.start('Prueba Agenda', G);
    await probe.say('Hola');
    const { box } = await probe.toolbox();
    const r = await box.run('get_available_slots', { date: null, part_of_day: 'any' });
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content).note).toMatch(/no inventes horarios/);
    expect(box.handoff?.reason).toBe('technical_issue');
    expect(box.handoff?.detail).toMatch(/Google Calendar.*Integraciones/);

    // De extremo a extremo: el lead pide la llamada y KAI no puede consultar la agenda.
    const sim = await Sim.start('Pablo Ruiz', G);
    let res = await sim.say('Hola, quiero hacer la llamada contigo, ¿cuándo podría ser?');
    for (let i = 0; i < 12 && res.status === 'sent' && !(await sim.conversation()).handoffActive; i++) {
      const key = (await sim.state()).lastAskedKey;
      res = await sim.say((key && ANSWERS[key]) || 'Quiero hacer la llamada, ¿qué horarios tienes?');
    }
    const conv = await sim.conversation();
    expect(conv.handoffActive).toBe(true);
    expect(conv.handoffReason).toBe('technical_issue');
    // (Con leads de prueba no se crean avisos: el motivo queda en la ficha del lead, igual que en el aviso real.)
    const handoffs = await getDb()
      .select()
      .from(leadEvents)
      .where(and(eq(leadEvents.leadId, sim.leadId), eq(leadEvents.type, 'handoff')));
    expect(handoffs).toHaveLength(1);
    expect(handoffs[0].data).toMatchObject({ reason: 'technical_issue' });
    expect(String(handoffs[0].data.detail)).toMatch(/Google Calendar.*calendario en Integraciones/);
    expect(await sim.scheduledFollowUps()).toHaveLength(0);
    // No es falta de disponibilidad: no se le pide al entrenador que revise su horario.
    const noAvailability = await getDb()
      .select()
      .from(alerts)
      .where(and(eq(alerts.businessId, G.businessId), eq(alerts.type, 'no_availability')));
    expect(noAvailability).toHaveLength(0);
  });
});

// ───────────── Trato de usted ─────────────

describe('trato «de usted» en los textos fijos', () => {
  it('traspaso, aviso sanitario y baja no tutean al lead', async () => {
    const U = await registerTrainer(app, { name: 'Ursula Usted', businessName: 'Ursula Coach' });
    const put = await U.client.put('/api/settings/ai', { tone: { ...DEFAULT_TONE, addressing: 'usted' } });
    expect(put.statusCode, put.body).toBe(200);

    const human = await (await Sim.start('Luis', U)).say('Quiero hablar con una persona real');
    expect(human).toMatchObject({ status: 'handoff', reason: 'human_request' });
    expect(human.text).toContain('Le paso su mensaje a');
    expect(human.text).not.toMatch(/\b(?:tu|te)\b/);

    const medical = await (await Sim.start('Elena', U)).say('Hola, tengo diabetes, ¿puedo entrenar?');
    expect(medical).toMatchObject({ status: 'handoff', reason: 'medical' });
    expect(medical.text).toContain('podemos ayudarle a valorar sus objetivos dentro de lo que sea adecuado para usted');

    const bye = await (await Sim.start('Óscar', U)).say('No me escribáis más, por favor');
    expect(bye).toMatchObject({ status: 'skipped', reason: 'opted_out' });
    expect(bye.text).toContain('no le escribiremos más');
  });
});

// ───────────── Juez con IA ─────────────

describe('juez con IA', () => {
  const AI_FIRST = '¡Hola Real! Soy KAI, el asistente virtual del equipo de Álex Romero. ¿Qué te gustaría conseguir exactamente?';

  it('también revisa el primer contacto', async () => {
    const calls = fakeProvider(() => textReply(AI_FIRST));
    const lead = await ingestExternalLead({ businessId: T.businessId, source: 'landing', name: 'Real Pérez', goal: 'perder grasa', firstContactChannel: 'web' });
    const r = await runFirstContact(T.businessId, lead.conversationId!);
    expect(r.status).toBe('sent');
    expect(r.text).toBe(AI_FIRST);
    expect(calls.judge).toBe(1);
  });

  it('si el juez no responde, se reintenta una vez y el borrador de la IA no se envía (lo sustituye el motor de reglas)', async () => {
    const calls = fakeProvider(() => textReply(AI_FIRST), 'fail');
    const lead = await ingestExternalLead({ businessId: T.businessId, source: 'landing', name: 'Real Gómez', goal: 'perder grasa', firstContactChannel: 'web' });
    const r = await runFirstContact(T.businessId, lead.conversationId!);
    expect(r.status).toBe('sent');
    expect(r.text).not.toBe(AI_FIRST);
    expect(calls.chat).toBe(1); // no se vuelve a redactar con la IA mientras el juez no responda
    expect(calls.judge).toBe(2);
    const logs = await getDb()
      .select()
      .from(errorLogs)
      .where(and(eq(errorLogs.businessId, T.businessId), eq(errorLogs.source, 'ai.setter.judge')));
    expect(logs.length).toBeGreaterThan(0);
    expect(qualityIssueSummary(['El control de calidad con IA no respondió.'])).toBe('KAI no ha encontrado una respuesta segura: la IA no respondió por un problema técnico temporal.');
  });

  it('recibe lo que incluye el servicio, su duración, la modalidad y los datos de la llamada', async () => {
    const put = await T.client.put('/api/settings/ai', { callDescription: 'Revisamos tu caso y te explico cómo trabajaríamos.' });
    expect(put.statusCode, put.body).toBe(200);
    const sim = await Sim.start('Datos Juez');
    const biz = await loadBusinessContext(T.businessId);
    const facts = factsSummary(biz, await loadLeadContext(T.businessId, sim.leadId), null);
    for (const item of SERVICE.includes) expect(facts).toContain(item);
    expect(facts).toContain('duración 12 semanas');
    expect(facts).toContain(`Modalidad: ${biz.trainer.modality}`);
    expect(facts).toContain(`${biz.settings.callLabel} de ${biz.settings.callDurationMinutes} minutos. Revisamos tu caso y te explico cómo trabajaríamos.`);
    expect(facts).toMatch(/asistente virtual del equipo de Álex Romero/);
  });
});

// ───────────── Estado de la conversación y seguimientos ─────────────

describe('estado tras proponer la llamada y seguimientos', () => {
  it('al proponer la llamada se olvida la última variable preguntada (la respuesta siguiente no la rebaja)', async () => {
    const sim = await Sim.start('Hugo Martín');
    let r = await sim.say('Hola, vi tu anuncio en Instagram');
    for (let i = 0; i < 12 && r.directive !== 'propose_call'; i++) {
      const key = (await sim.state()).lastAskedKey ?? 'goal';
      r = await sim.say(ANSWERS[key] ?? 'Vale, te cuento lo que necesites');
    }
    expect(r.directive).toBe('propose_call');
    expect(r.text).toContain('?');
    expect((await sim.state()).lastAskedKey).toBeUndefined();
  });

  it('al lead que no encaja no se le programan seguimientos aunque insista en el precio y se le dé', async () => {
    const sim = await Sim.start('Menor Pérez');
    const directives: (string | undefined)[] = [];
    for (const text of ['Hola, tengo 16 años y quiero perder grasa', '¿Cuánto cuesta?', 'Dime el precio porfa']) directives.push((await sim.say(text)).directive);
    expect(directives).toContain('share_price');
    expect(await sim.scheduledFollowUps()).toHaveLength(0);
  });
});

// ───────────── Herramientas según el objetivo del turno ─────────────

describe('la IA no reserva ni cancela por su cuenta', () => {
  it('no reserva un horario que el lead aún no ha visto; sí uno que se le ofreció antes', async () => {
    const sim = await Sim.start('Reserva Prudente');
    await sim.say('Hola');
    const { box } = await sim.toolbox({ directive: { kind: 'offer_slots' } });
    const got = JSON.parse((await box.run('get_available_slots', { date: null, part_of_day: 'any' })).content) as { slots: { slot_id: string }[] };
    expect(got.slots.length).toBeGreaterThan(0);
    const first = got.slots[0].slot_id;
    const denied = await box.run('book_call', { slot_id: first });
    expect(denied.isError).toBe(true);
    expect(isDeniedRecord(box.records.at(-1)!)).toBe(true);
    expect(box.booked).toBeNull();
    expect(await sim.appointments()).toHaveLength(0);

    // Otro objetivo sin elección de horario: tampoco.
    const { box: other } = await sim.toolbox({ directive: { kind: 'propose_call' } });
    expect((await other.run('book_call', { slot_id: first })).isError).toBe(true);

    // En el turno siguiente ese horario ya lo ha visto: si lo nombra, se puede reservar.
    const { box: next } = await sim.toolbox({ directive: { kind: 'offer_slots' } });
    const ok = await next.run('book_call', { slot_id: first });
    expect(ok.isError, ok.content).toBe(false);
    expect((await sim.appointments()).filter((a) => a.status === 'scheduled')).toHaveLength(1);
  });

  it('con book_slot solo reserva el horario elegido (y un intento con otro no impide reservar el bueno)', async () => {
    const sim = await Sim.start('Elige Bien');
    await sim.say('Hola');
    const { box: offer } = await sim.toolbox();
    const got = JSON.parse((await offer.run('get_available_slots', { date: null, part_of_day: 'any' })).content) as { slots: { slot_id: string }[] };
    expect(got.slots.length).toBe(2);
    const [chosen, otherSlot] = got.slots.map((s) => s.slot_id);
    const directive = { kind: 'book_slot', slotId: chosen, instruction: '' } as Directive;
    const { box, leadCtx } = await sim.toolbox({ directive });
    expect((await box.run('book_call', { slot_id: otherSlot })).isError).toBe(true);
    expect(await ensureDirectiveAction(directive, box, leadCtx)).toBe(true);
    const appts = (await sim.appointments()).filter((a) => a.status === 'scheduled');
    expect(appts).toHaveLength(1);
    expect(appts[0].startsAt.getTime()).toBe(slotStartFromId(chosen)!.getTime());
  });

  it('no cancela mientras se pregunta si cancelar (confirm_cancel), aunque la IA llame a cancel_call', async () => {
    const sim = await Sim.start('Duda Llamada');
    await sim.say('Hola');
    const appt = await sim.book(3, 10);
    fakeProvider((_req, n) => (n === 1 ? toolReply('cancel_call', { reason: 'No quiere la llamada' }) : textReply('Sin problema. ¿Prefieres que la cancele o que la movamos a otro día?')));
    const r = await sim.say('Al final prefiero no hacer la llamada');
    expect(r.directive).toBe('confirm_cancel');
    const [row] = await getDb().select().from(appointments).where(eq(appointments.id, appt.id));
    expect(row.status).toBe('scheduled');

    // Con el objetivo de cancelar (lo pidió explícitamente), sí.
    const { box } = await sim.toolbox({ directive: { kind: 'cancel_booking' } });
    expect((await box.run('cancel_call', { reason: 'Lo pidió' })).isError).toBe(false);
    expect(box.cancelled).toBe(true);
  });
});

// ───────────── Mensajes que llegan mientras KAI responde ─────────────

describe('mensajes del lead que llegan mientras KAI responde', () => {
  it('si escribe mientras KAI cancela su llamada, la cancelación se le confirma y su mensaje se contesta después', async () => {
    const sim = await Sim.start('Cancela Rápido');
    await sim.say('Hola');
    const appt = await sim.book(4, 11);
    const CONFIRM = 'Hecho, he cancelado la llamada. Si más adelante quieres retomarlo, escríbeme por aquí.';
    fakeProvider(async (_req, n) => {
      if (n === 1) return toolReply('cancel_call', { reason: 'El lead pidió cancelar' });
      if (n === 2) await receiveInboundForConversation(T.businessId, sim.id, 'Perdona las molestias');
      return textReply(CONFIRM);
    });
    const r = await sim.say('Cancela la llamada, por favor');
    expect(r).toMatchObject({ status: 'sent', directive: 'cancel_booking', text: CONFIRM });
    const [row] = await getDb().select().from(appointments).where(eq(appointments.id, appt.id));
    expect(row.status).toBe('cancelled');
    // El mensaje nuevo sigue pendiente y hay un turno de KAI programado para contestarlo.
    const ctx = await loadConversationContext(T.businessId, sim.id);
    expect(ctx.pendingInbound.map((m) => m.content)).toEqual(['Perdona las molestias']);
    const jobs = await getDb()
      .select()
      .from(scheduledJobs)
      .where(and(eq(scheduledJobs.dedupeKey, `reply:${sim.id}`), eq(scheduledJobs.status, 'pending')));
    expect(jobs).toHaveLength(1);

    setLLMProvider(undefined);
    const next = await runSetterReply(T.businessId, sim.id);
    expect(next.status, next.reason).toBe('sent');
    expect((await loadConversationContext(T.businessId, sim.id)).pendingInbound).toHaveLength(0);
  });

  it('un mensaje que el canal fecha antes que la respuesta de KAI no se da por contestado', async () => {
    const sim = await Sim.start('Meta Lento');
    expect((await sim.say('Hola, quiero perder 10 kilos')).status).toBe('sent');
    const all = await sim.messages();
    const lead = all.filter((m) => m.direction === 'inbound').at(-1)!;
    const kai = all.filter((m) => m.direction === 'outbound').at(-1)!;
    expect(kai.metadata.repliesTo).toEqual([lead.id]);
    // Llega por webhook DESPUÉS de la respuesta, pero con la hora de Meta (truncada a segundos), anterior a ella.
    await getDb()
      .insert(messages)
      .values({
        businessId: T.businessId,
        conversationId: sim.id,
        leadId: sim.leadId,
        direction: 'inbound',
        senderType: 'lead',
        content: '¿Y cuánto cuesta?',
        contentType: 'text',
        status: 'received',
        metadata: {},
        createdAt: new Date(Math.floor((lead.createdAt.getTime() + kai.createdAt.getTime()) / 2)),
      });
    const ctx = await loadConversationContext(T.businessId, sim.id);
    expect(ctx.pendingInbound.map((m) => m.content)).toEqual(['¿Y cuánto cuesta?']);
    expect(ctx.history.at(-1)!.content).toBe('¿Y cuánto cuesta?');

    const r = await runSetterReply(T.businessId, sim.id);
    expect(r.status, r.reason).toBe('sent');
    expect((await loadConversationContext(T.businessId, sim.id)).pendingInbound).toHaveLength(0);
  });

  it('sin constancia de a qué contestaba la última respuesta (o si no hay mensajes intercalados), el orden no cambia', () => {
    const msg = (id: string, direction: 'inbound' | 'outbound', metadata: Record<string, unknown> = {}) => ({ id, direction, metadata }) as unknown as MessageRow;
    const R = msg('r', 'inbound');
    const L = msg('l', 'inbound');
    expect(withLateInboundLast([R, L, msg('b', 'outbound', { repliesTo: ['r'] })]).map((m) => m.id)).toEqual(['r', 'b', 'l']);
    expect(withLateInboundLast([R, L, msg('b', 'outbound')]).map((m) => m.id)).toEqual(['r', 'l', 'b']);
    expect(withLateInboundLast([R, L, msg('b', 'outbound', { repliesTo: ['r', 'l'] })]).map((m) => m.id)).toEqual(['r', 'l', 'b']);
    expect(withLateInboundLast([R, msg('b', 'outbound', { repliesTo: ['r'] }), L]).map((m) => m.id)).toEqual(['r', 'b', 'l']);
    // Lo anterior a lo que contestaba ya se contestó antes.
    expect(withLateInboundLast([L, msg('a', 'outbound'), R, msg('b', 'outbound', { repliesTo: ['r'] })]).map((m) => m.id)).toEqual(['l', 'a', 'r', 'b']);
  });
});
