/**
 * Revisión nº 1 (conversación), de extremo a extremo con base de datos en memoria:
 *  - cuenta desactivada y límites del plan en primer contacto, seguimientos, simulador y vista previa;
 *  - aviso sanitario obligatorio aunque el escalado médico esté desactivado;
 *  - presentación como asistente en mensajes fijos que son el primero de KAI;
 *  - rechazo y cancelación de la llamada, precio y transparencia con la cita agendada;
 *  - reservas idempotentes (sin doble cita) y avisos de calidad en lenguaje claro.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { getDb } from '../../src/database/client.js';
import { alerts, appointments, businesses, conversations, errorLogs, leadEvents, leads, messages } from '../../src/database/schema.js';
import { composeFollowUp, MEDICAL_MESSAGE, qualityIssueSummary, runFirstContact } from '../../src/ai/setter/setter-engine.js';
import { RuleBasedSetterAgent } from '../../src/ai/setter/agents.js';
import { SetterToolbox } from '../../src/ai/tools/setter-tools.js';
import { loadBusinessContext, loadConversationContext, loadLeadContext } from '../../src/ai/context/context.js';
import { updateConversationState } from '../../src/crm/conversations.service.js';
import { ingestExternalLead } from '../../src/webhooks/inbound.service.js';
import { getUsage, incrementUsage } from '../../src/plans/plans.service.js';
import { setLLMProvider } from '../../src/ai/providers/index.js';
import type { LLMProvider } from '../../src/ai/providers/types.js';
import { DEFAULT_HANDOFF_RULES } from '../../src/config/defaults.js';
import { OVER_LIMIT_TAG, type OfferedSlot } from '../../src/lib/domain.js';
import { openAgenda, registerTrainer, setupTestApp, teardownTestApp, type Trainer } from './helpers.js';

const SERVICE = { name: 'Plan Transformación 12 semanas', priceCents: 14900, billingPeriod: 'monthly', includes: ['Plan de entrenamiento', 'Pautas de nutrición'] };

const ANSWERS: Record<string, string> = {
  goal: 'Quiero perder 10 kilos para mi boda en junio',
  current_situation: 'Ahora mismo no entreno nada, trabajo en una oficina y ceno mal',
  problem: 'No soy constante, me cuesta organizarme con el trabajo',
  motivation: 'Quiero sentirme bien conmigo misma el día de mi boda',
  previous_attempts: 'He probado dietas y el gimnasio pero lo dejo siempre',
  frustration: 'Que nunca me funciona a largo plazo y recupero el peso',
  urgency: 'Me caso en junio y quiero empezar cuanto antes',
  commitment: 'Sí, estoy dispuesta, voy en serio',
  budget: 'Sí, puedo invertir en ello',
};

interface SetterResult {
  status: string;
  reason?: string;
  text?: string;
  directive?: string;
}

let app: FastifyInstance;

beforeAll(async () => {
  app = await setupTestApp();
});

afterAll(async () => {
  await teardownTestApp(app);
});

afterEach(() => {
  setLLMProvider(undefined);
});

async function newTrainer(name = 'Laura Gómez'): Promise<Trainer> {
  const t = await registerTrainer(app, { name, businessName: `Negocio de ${name}` });
  await openAgenda(t.client);
  expect((await t.client.put('/api/settings/primary-service', SERVICE)).statusCode).toBe(200);
  return t;
}

class Sim {
  constructor(
    readonly t: Trainer,
    readonly id: string,
    readonly leadId: string,
  ) {}

  static async start(t: Trainer, leadName = 'Marta') {
    const res = await t.client.post('/api/simulator/conversations', { leadName });
    expect(res.statusCode).toBe(200);
    return new Sim(t, res.json().conversationId, res.json().leadId);
  }

  async say(text: string): Promise<SetterResult> {
    const res = await this.t.client.post(`/api/simulator/conversations/${this.id}/messages`, { text });
    expect(res.statusCode, res.body).toBe(200);
    return res.json().result as SetterResult;
  }

  async state() {
    const [c] = await getDb().select().from(conversations).where(eq(conversations.id, this.id));
    return c;
  }

  async outbound() {
    const rows = await getDb().select().from(messages).where(eq(messages.conversationId, this.id)).orderBy(messages.createdAt);
    return rows.filter((m) => m.direction === 'outbound' && m.status !== 'skipped');
  }

  async qualifyUntilCallProposed() {
    let r = await this.say('Hola! Vi tu anuncio');
    for (let i = 0; i < 12 && r.directive !== 'propose_call'; i++) {
      const key = (await this.state()).state.lastAskedKey;
      r = await this.say((key && ANSWERS[key]) || 'Vale, te cuento lo que necesites');
    }
    expect(r.directive).toBe('propose_call');
    return r;
  }
}

/** Lead real de formulario con primer contacto por el chat web (sin canal externo). */
async function formLead(t: Trainer, name = 'Real Pérez') {
  const res = await ingestExternalLead({ businessId: t.businessId, source: 'landing', name, goal: 'perder grasa', firstContactChannel: 'web' });
  expect(res.conversationId).toBeTruthy();
  return { leadId: res.lead.id, conversationId: res.conversationId! };
}

const FOLLOW_UP = { step: 1, totalSteps: 3, angle: 'Retomar la conversación', hoursSilent: 5 };

// ───────────── Cuenta desactivada y límites del plan ─────────────

describe('cuenta desactivada', () => {
  it('KAI no hace el primer contacto ni redacta seguimientos', async () => {
    const t = await newTrainer();
    const { conversationId } = await formLead(t);
    await getDb().update(businesses).set({ status: 'suspended' }).where(eq(businesses.id, t.businessId));

    const r = await runFirstContact(t.businessId, conversationId);
    expect(r).toMatchObject({ status: 'skipped', reason: 'business_suspended' });
    expect(await getDb().select().from(messages).where(eq(messages.conversationId, conversationId))).toHaveLength(0);

    const fu = await composeFollowUp(t.businessId, conversationId, FOLLOW_UP);
    expect(fu.text).toBeNull();
    expect(fu.skipped?.reason).toBe('business_suspended');
  });
});

describe('límites del plan', () => {
  it('un lead que entró por encima del límite de leads no recibe primer contacto ni seguimientos', async () => {
    const t = await newTrainer();
    const { leadId, conversationId } = await formLead(t);
    await getDb().update(leads).set({ tags: [OVER_LIMIT_TAG] }).where(eq(leads.id, leadId));

    expect(await runFirstContact(t.businessId, conversationId)).toMatchObject({ status: 'skipped', reason: 'limit_reached' });
    expect(await getDb().select().from(messages).where(eq(messages.conversationId, conversationId))).toHaveLength(0);
    expect((await composeFollowUp(t.businessId, conversationId, FOLLOW_UP)).skipped?.reason).toBe('limit_reached');
  });

  it('con el límite de mensajes de IA agotado: sin primer contacto (aviso de contacto manual), sin seguimientos y sin simulador', async () => {
    const t = await newTrainer();
    const { leadId, conversationId } = await formLead(t);
    await incrementUsage(t.businessId, 'ai_messages', 1_000_000);

    expect(await runFirstContact(t.businessId, conversationId)).toMatchObject({ status: 'skipped', reason: 'limit_reached' });
    const manual = await getDb().select().from(alerts).where(and(eq(alerts.businessId, t.businessId), eq(alerts.type, 'new_lead_manual'), eq(alerts.leadId, leadId)));
    expect(manual).toHaveLength(1);
    expect(manual[0].body).toMatch(/límite de mensajes de KAI/);
    expect((await composeFollowUp(t.businessId, conversationId, FOLLOW_UP)).skipped?.reason).toBe('limit_reached');

    // El simulador usa el mismo motor (y el mismo modelo): también respeta el límite.
    const sim = await Sim.start(t);
    const r = await sim.say('Hola');
    expect(r).toMatchObject({ status: 'handoff', reason: 'limit_reached' });
    expect(await sim.outbound()).toHaveLength(0);
  });

  it('la vista previa con IA cuenta como uso y se bloquea al llegar al límite', async () => {
    const t = await newTrainer();
    const reply = '¡Hola Carlos! Soy KAI, el asistente virtual del equipo de Laura Gómez. ¿Qué te gustaría conseguir exactamente?';
    let chats = 0;
    const provider: LLMProvider = {
      id: 'fake',
      describe: () => ({ provider: 'fake', mainModel: 'fake', fastModel: 'fake' }),
      chat: async () => {
        chats++;
        return { blocks: [{ type: 'text', text: reply }], stopReason: 'end_turn', raw: null, usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0 }, model: 'fake' };
      },
      structured: (async () => {
        throw new Error('no se usa');
      }) as LLMProvider['structured'],
    };
    setLLMProvider(provider);

    const before = (await getUsage(t.businessId)).ai_messages;
    const ok = await t.client.post('/api/settings/ai/preview', { leadMessage: 'Hola, quiero perder grasa' });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().reply).toBe(reply);
    expect((await getUsage(t.businessId)).ai_messages).toBe(before + 1);

    await incrementUsage(t.businessId, 'ai_messages', 1_000_000);
    const calls = chats;
    const blocked = await t.client.post('/api/settings/ai/preview', { leadMessage: 'Hola' });
    expect(blocked.statusCode).toBe(402);
    expect(blocked.json().error).toBe('limit_reached');
    expect(chats).toBe(calls); // no se llama al modelo
  });
});

// ───────────── Salud y transparencia ─────────────

describe('aviso sanitario y presentación', () => {
  it('con el escalado médico desactivado, el aviso sanitario se envía igualmente (una vez) y KAI sigue', async () => {
    const t = await newTrainer();
    const put = await t.client.put('/api/settings/ai', { handoffRules: { ...DEFAULT_HANDOFF_RULES, medical: false } });
    expect(put.statusCode, put.body).toBe(200);
    const sim = await Sim.start(t, 'Elena');
    await sim.say('Hola');
    const r = await sim.say('Tengo una hernia discal, ¿puedo entrenar?');
    expect(r.status).toBe('sent');

    let out = await sim.outbound();
    const notices = out.filter((m) => m.content === MEDICAL_MESSAGE);
    expect(notices).toHaveLength(1);
    expect(notices[0].metadata.kind).toBe('medical_notice');
    expect(out.at(-1)!.content).toBe(r.text);
    expect(out.at(-2)!.content).toBe(MEDICAL_MESSAGE); // justo antes de la respuesta
    expect((await sim.state()).handoffActive).toBe(false);

    await sim.say('Lo de la hernia me preocupa un poco, la verdad');
    out = await sim.outbound();
    expect(out.filter((m) => m.content.includes(MEDICAL_MESSAGE))).toHaveLength(1);
  });

  it('si el primer mensaje de KAI es el aviso sanitario o un traspaso, se presenta como asistente', async () => {
    const t = await newTrainer();
    const medical = await Sim.start(t, 'Elena');
    const r = await medical.say('Hola, tengo diabetes, ¿puedo entrenar?');
    expect(r).toMatchObject({ status: 'handoff', reason: 'medical' });
    expect(r.text).toMatch(/^¡Hola Elena! Soy KAI, el asistente virtual del equipo de Laura Gómez\./);
    expect(r.text).toContain(MEDICAL_MESSAGE);

    const human = await Sim.start(t, 'Luis');
    const h = await human.say('Quiero hablar con una persona real');
    expect(h).toMatchObject({ status: 'handoff', reason: 'human_request' });
    expect(h.text).toMatch(/asistente virtual/);
  });
});

// ───────────── Rechazo de la llamada ─────────────

describe('rechazo de la llamada', () => {
  it('tras rechazarla, KAI no vuelve a ofrecer horarios ni a proponerla (tampoco en el seguimiento)', async () => {
    const t = await newTrainer();
    const sim = await Sim.start(t, 'Irene');
    await sim.qualifyUntilCallProposed();

    const no = await sim.say('No quiero llamada, prefiero seguir por aquí');
    expect(no.directive).toBe('continue_without_call');
    expect((await sim.state()).state).toHaveProperty('callDeclinedAt');

    for (const text of ['Vale. Trabajo a turnos y ceno tarde', 'Me interesa sobre todo la parte de nutrición']) {
      const r = await sim.say(text);
      expect(r.status).toBe('sent');
      expect(['offer_slots', 'propose_call', 'reassure_call', 'clarify_slot']).not.toContain(r.directive);
      expect(r.text).not.toMatch(/\d{1,2}:\d{2}/);
    }

    const fu = await composeFollowUp(t.businessId, sim.id, { ...FOLLOW_UP, step: 2 });
    expect(fu.text).toBeTruthy();
    expect(fu.text).not.toMatch(/llamada|esta semana/);

    // Si la pide explícitamente, entonces sí.
    const yes = await sim.say('Bueno, al final sí quiero la llamada');
    expect(yes.directive).toBe('offer_slots');
    expect((await sim.state()).state).not.toHaveProperty('callDeclinedAt');
  });
});

// ───────────── Con la llamada agendada ─────────────

describe('con la llamada agendada', () => {
  it('da el precio real, responde con transparencia y cancela si se lo pide', async () => {
    const t = await newTrainer();
    const sim = await Sim.start(t, 'Nuria');
    await sim.qualifyUntilCallProposed();
    await sim.say('Sí, me encaja. Mejor mañana por la tarde');
    const booked = await sim.say('La primera');
    expect(booked.directive).toBe('book_slot');

    const price = await sim.say('¿Cuánto cuesta el programa?');
    expect(price.directive).toBe('share_price');
    expect(price.text).toMatch(/149\s?€/);

    const bot = await sim.say('Una cosa, ¿eres un bot?');
    expect(bot.directive).toBe('post_booking');
    expect(bot.text).toMatch(/asistente automatizado/);

    const cancel = await sim.say('Quiero cancelar la llamada');
    expect(cancel.directive).toBe('cancel_booking');
    expect(cancel.text).toMatch(/he cancelado/);
    const appts = await getDb().select().from(appointments).where(eq(appointments.leadId, sim.leadId));
    expect(appts).toHaveLength(1);
    expect(appts[0].status).toBe('cancelled');

    // Canceló: KAI no le vuelve a ofrecer horarios por un simple “vale”.
    const after = await sim.say('Vale, gracias');
    expect(['offer_slots', 'propose_call', 'reassure_call']).not.toContain(after.directive);
  });
});

// ───────────── Reservas idempotentes ─────────────

describe('reservas desde la caja de herramientas', () => {
  it('book_call dos veces en el mismo turno no duplica la cita y el motor de reglas confirma la existente', async () => {
    const t = await newTrainer();
    const sim = await Sim.start(t, 'Carla');
    await sim.say('Hola');
    const free = (await t.client.get('/api/agenda/slots')).json().slots as { id: string; start: string; end: string }[];
    const offered: OfferedSlot[] = free.slice(0, 2).map((s) => ({ id: s.id, start: s.start, end: s.end, label: 'x' }));
    await updateConversationState(t.businessId, sim.id, { offeredSlots: offered, lastOfferIds: offered.map((o) => o.id), offeredAt: new Date().toISOString() });

    const biz = await loadBusinessContext(t.businessId);
    const convCtx = await loadConversationContext(t.businessId, sim.id);
    const leadCtx = await loadLeadContext(t.businessId, sim.leadId);
    const toolbox = new SetterToolbox(biz, leadCtx, convCtx.conversation);
    const first = await toolbox.run('book_call', { slot_id: offered[0].id });
    const second = await toolbox.run('book_call', { slot_id: offered[0].id });
    expect(first.isError).toBe(false);
    expect(second.isError).toBe(false);
    expect(JSON.parse(second.content)).toMatchObject({ confirmed: true, already_booked: true });

    // El motor de reglas toma el relevo (p. ej. tras borradores de la IA rechazados): confirma, no dice “se ocupó”.
    const out = await new RuleBasedSetterAgent().respond({
      biz,
      leadCtx,
      convCtx,
      state: convCtx.conversation.state,
      directive: { kind: 'book_slot', slotId: offered[0].id, instruction: '' },
      now: new Date(),
      feedback: [],
      toolbox,
      mode: 'reply',
    });
    expect(out.text).toMatch(/^¡Hecho! Te apunto/);
    const rows = await getDb().select().from(appointments).where(eq(appointments.leadId, sim.leadId));
    expect(rows.filter((a) => a.status === 'scheduled')).toHaveLength(1);

    // Con una cita ya agendada, book_call en otro horario la MUEVE (no crea una segunda).
    await updateConversationState(t.businessId, sim.id, { offeredSlots: offered, lastOfferIds: offered.map((o) => o.id), offeredAt: new Date().toISOString() });
    const later = new SetterToolbox(biz, await loadLeadContext(t.businessId, sim.leadId), (await loadConversationContext(t.businessId, sim.id)).conversation);
    const r = await later.run('book_call', { slot_id: offered[1].id });
    expect(r.isError, r.content).toBe(false);
    expect(JSON.parse(r.content)).toMatchObject({ rescheduled: true });
    const after = await getDb().select().from(appointments).where(eq(appointments.leadId, sim.leadId));
    const scheduled = after.filter((a) => a.status === 'scheduled');
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0].startsAt.toISOString()).toBe(new Date(offered[1].start).toISOString());
  });
});

// ───────────── Primer contacto ─────────────

describe('primer contacto', () => {
  it('si el primer mensaje no llega (o se envía una plantilla), no se apunta la pregunta como hecha', async () => {
    const t = await newTrainer();
    const res = await ingestExternalLead({ businessId: t.businessId, source: 'landing', name: 'Pablo', phone: '+34600999888', firstContactChannel: 'whatsapp' });
    const r = await runFirstContact(t.businessId, res.conversationId!);
    expect(r.status).toBe('blocked'); // sin WhatsApp conectado
    const [conv] = await getDb().select().from(conversations).where(eq(conversations.id, res.conversationId!));
    expect(conv.state.lastAskedKey).toBeUndefined();
  });
});

// ───────────── Avisos de calidad ─────────────

describe('avisos por control de calidad', () => {
  it('el resumen para el entrenador no muestra jerga técnica ni errores en inglés', () => {
    const summary = qualityIssueSummary([
      'Menciona el horario “a las 17”, que no ha salido de la agenda real. Usa get_available_slots y sus etiquetas exactas.',
      'Error al generar: 529 overloaded_error',
    ]);
    expect(summary).toMatch(/^KAI no ha encontrado una respuesta segura: /);
    expect(summary).toMatch(/horario que no está en tu agenda/);
    expect(summary).toMatch(/problema técnico temporal/);
    expect(summary).not.toMatch(/get_available_slots|overloaded|529/);
  });

  it('al pasar la conversación por calidad, el detalle es claro y los motivos técnicos van al registro de errores', async () => {
    const t = await newTrainer();
    expect((await t.client.put('/api/settings/ai', { wordsToAvoid: ['hola', 'ey'] })).statusCode).toBe(200);
    const sim = await Sim.start(t, 'Marta');
    const r = await sim.say('Buenas');
    expect(r).toMatchObject({ status: 'handoff', reason: 'quality_check_failed' });

    const [event] = await getDb().select().from(leadEvents).where(and(eq(leadEvents.leadId, sim.leadId), eq(leadEvents.type, 'handoff')));
    const detail = String(event.data.detail);
    expect(detail).toMatch(/KAI no ha encontrado una respuesta segura: la respuesta usaba una palabra que has prohibido/);
    expect(detail).not.toMatch(/get_available_slots|Usa la palabra/);
    const logs = await getDb().select().from(errorLogs).where(and(eq(errorLogs.businessId, t.businessId), eq(errorLogs.source, 'ai.setter.quality_check')));
    expect(logs.length).toBeGreaterThan(0);
    expect(logs[0].message).toMatch(/palabra prohibida/);
  });
});
