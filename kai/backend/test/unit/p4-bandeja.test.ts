/*
 * Bandeja y piezas comunes de la web (revisión p4, grupo r2-bandeja). La lógica vive en frontend/src/lib; aquí se
 * prueba con datos sueltos y, cuando importa lo que manda el servidor, con la API real.
 *  - nextActionFor: con KAI en pausa, «responde tú» solo si hay un mensaje del lead esperando.
 *  - unsentReply: la respuesta al lead no se pudo enviar → se explica el motivo (no «llegó con KAI en pausa»).
 *  - attentionItems: «Mensaje no enviado» y «X espera tu respuesta» de la misma conversación son un solo asunto.
 *  - sessionState / sessionRetry: un fallo de /auth/me no es «sin sesión» (no se manda al login).
 *  - focusTrapTarget: Tab no sale de un modal abierto.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createLead } from '../../src/crm/leads.service.js';
import { getOrCreateConversation } from '../../src/crm/conversations.service.js';
import { runSetterReply } from '../../src/ai/setter/setter-engine.js';
import { receiveInboundForConversation } from '../../src/webhooks/inbound.service.js';
import { getDashboard } from '../../src/analytics/analytics.service.js';
import { registerTrainer, setupTestApp, teardownTestApp } from '../integration/helpers.js';

// La web importa '@shared' (alias de Vite a src/lib/domain.ts); aquí se resuelve igual.
vi.mock('@shared', async () => await import('../../src/lib/domain.js'));

type Conv = { handoffActive?: boolean; aiEnabled?: boolean; needsHumanReply?: boolean; replyUnsent?: boolean } | null;
type NextActionFor = (lead: { status: string; nextAction?: string | null; optedOut?: boolean }, conv?: Conv, upcoming?: { startsAt: string } | null, timeZone?: string, autopilotOn?: boolean) => string;
type Msg = { direction: 'inbound' | 'outbound'; senderType: 'lead' | 'kai' | 'human' | 'system'; status: string; error: string | null; metadata: Record<string, unknown> };
type UnsentReply = (messages: Msg[]) => { reason: string | null } | null;
type AlertRow = { alert: { type: string; leadId: string | null; conversationId: string | null } };
type AttentionItems = (attention: { alerts: AlertRow[]; waiting: { conversationId: string; leadId: string }[]; atRisk: { id: string }[] }) => {
  handoffs: AlertRow[];
  waiting: { conversationId: string; leadId: string }[];
  atRisk: { id: string }[];
  otherAlerts: AlertRow[];
  count: number;
};
type SessionLib = {
  sessionState: (me: { user: unknown } | null | undefined, loading: boolean) => string;
  sessionRetry: (failureCount: number, err: unknown) => boolean;
  sessionRetryDelay: (failureCount: number, err: unknown) => number;
};
type ApiErrorCtor = new (status: number, code: string, message: string) => Error;
type FocusTrapTarget = <T>(focusables: readonly T[], active: T | null, inside: boolean, shift: boolean) => T | null;

// Se cargan por ruta: así la web no entra en la compilación del servidor (tsc) y vitest la transforma igual.
const here = path.dirname(fileURLToPath(import.meta.url));
const web = (file: string) => path.join(here, '../../../frontend/src/lib', file);
let nextActionFor: NextActionFor;
let unsentReply: UnsentReply;
let attentionItems: AttentionItems;
let session: SessionLib;
let ApiError: ApiErrorCtor;
let focusTrapTarget: FocusTrapTarget;

let app: FastifyInstance;
beforeAll(async () => {
  ({ nextActionFor } = (await import(web('leads.ts'))) as { nextActionFor: NextActionFor });
  ({ unsentReply } = (await import(web('messages.ts'))) as { unsentReply: UnsentReply });
  ({ attentionItems } = (await import(web('attention.ts'))) as { attentionItems: AttentionItems });
  session = (await import(web('session.ts'))) as SessionLib;
  ({ ApiError } = (await import(web('api.ts'))) as { ApiError: ApiErrorCtor });
  ({ focusTrapTarget } = (await import(web('focus.ts'))) as { focusTrapTarget: FocusTrapTarget });
  app = await setupTestApp();
});
afterAll(async () => {
  await teardownTestApp(app);
});

describe('nextActionFor con el piloto automático en pausa', () => {
  const paused = (lead: { status: string; nextAction?: string | null }, conv: Conv) => nextActionFor(lead, conv, null, 'Europe/Madrid', false);
  const kaiConv = { handoffActive: false, aiEnabled: true, needsHumanReply: false };

  it('«KAI en pausa: responde tú» solo cuando el último mensaje del lead está sin contestar (como en «Pendientes»)', () => {
    expect(paused({ status: 'conversing' }, { ...kaiConv, needsHumanReply: true })).toBe('KAI en pausa: responde tú');
    // Antes de los textos de la etapa o de la próxima acción: es lo más urgente (igual que con KAI activo).
    expect(paused({ status: 'call_booked', nextAction: 'Mandar el plan' }, { ...kaiConv, needsHumanReply: true })).toBe('KAI en pausa: responde tú');
  });

  it('sin nada que contestar se mantiene la etapa: llamada agendada, horario propuesto…', () => {
    expect(paused({ status: 'call_booked' }, kaiConv)).toBe('Prepara la llamada');
    expect(paused({ status: 'reminder_sent' }, kaiConv)).toBe('Prepara la llamada');
    expect(paused({ status: 'call_proposed' }, kaiConv)).toBe('Esperando que elija horario');
    expect(paused({ status: 'no_show' }, kaiConv)).toBe('Reagendar la llamada');
    expect(paused({ status: 'client' }, kaiConv)).toBe('Cliente');
    expect(paused({ status: 'lost' }, kaiConv)).toBe('Perdido');
  });

  it('el último mensaje es de KAI (esperando al lead): no dice «responde tú» ni que KAI vaya a escribir', () => {
    for (const status of ['contacted', 'conversing', 'interested', 'qualified', 'follow_up']) {
      const text = paused({ status }, kaiConv);
      expect(text).toBe('Esperando respuesta del lead (KAI en pausa)');
    }
    // Un lead nuevo al que nadie ha escrito: con KAI en pausa le tiene que escribir el entrenador.
    expect(paused({ status: 'new' }, kaiConv)).toBe('KAI en pausa: escríbele tú');
  });

  it('con KAI activo no cambia nada', () => {
    const on = (lead: { status: string }, conv: Conv) => nextActionFor(lead, conv, null, 'Europe/Madrid', true);
    expect(on({ status: 'conversing' }, kaiConv)).toBe('KAI está cualificando');
    expect(on({ status: 'new' }, kaiConv)).toBe('KAI responderá en breve');
    expect(on({ status: 'follow_up' }, kaiConv)).toBe('Seguimiento automático en curso');
    expect(on({ status: 'conversing' }, { ...kaiConv, needsHumanReply: true })).toBe('Mensaje sin contestar: respóndele tú o deja que lo haga KAI');
    expect(on({ status: 'conversing' }, { ...kaiConv, aiEnabled: false })).toBe('Conversación en tus manos');
  });
});

describe('nextActionFor con la respuesta no enviada', () => {
  it('dice que la respuesta no llegó (con KAI activo, en pausa o con la conversación en tus manos)', () => {
    const conv = { handoffActive: false, aiEnabled: true, needsHumanReply: true, replyUnsent: true };
    const text = 'Respuesta no enviada: revisa el motivo en la conversación';
    expect(nextActionFor({ status: 'qualified' }, conv, null, 'Europe/Madrid', true)).toBe(text);
    expect(nextActionFor({ status: 'qualified' }, conv, null, 'Europe/Madrid', false)).toBe(text);
    expect(nextActionFor({ status: 'conversing' }, { ...conv, aiEnabled: false }, null, 'Europe/Madrid', true)).toBe(text);
    // Si ya no espera respuesta (alguien le contestó después), no se dice.
    expect(nextActionFor({ status: 'qualified' }, { ...conv, needsHumanReply: false }, null, 'Europe/Madrid', true)).toBe('KAI propondrá la llamada');
  });
});

describe('unsentReply (datos sueltos)', () => {
  const inbound: Msg = { direction: 'inbound', senderType: 'lead', status: 'received', error: null, metadata: {} };
  const out = (status: string, extra: Partial<Msg> = {}): Msg => ({ direction: 'outbound', senderType: 'kai', status, error: status === 'sent' ? null : 'No hay ninguna cuenta de Instagram conectada.', metadata: { purpose: 'reply' }, ...extra });

  it('la respuesta de KAI quedó «no enviada» → devuelve el motivo', () => {
    expect(unsentReply([out('sent'), inbound, out('skipped')])).toEqual({ reason: 'No hay ninguna cuenta de Instagram conectada.' });
    // También un mensaje del entrenador que no salió.
    expect(unsentReply([inbound, out('failed', { senderType: 'human', error: 'Instagram ha rechazado el mensaje.' })])).toEqual({ reason: 'Instagram ha rechazado el mensaje.' });
  });

  it('nadie ha intentado contestar, o alguna respuesta sí salió → null', () => {
    expect(unsentReply([out('sent'), inbound])).toBeNull();
    expect(unsentReply([inbound, out('skipped'), out('sent', { senderType: 'human' })])).toBeNull();
    expect(unsentReply([out('skipped')])).toBeNull();
    expect(unsentReply([])).toBeNull();
  });

  it('un recordatorio o un seguimiento que no salió no es la respuesta al lead', () => {
    expect(unsentReply([inbound, out('skipped', { metadata: { purpose: 'reminder' } })])).toBeNull();
    expect(unsentReply([inbound, out('skipped', { senderType: 'system', metadata: { purpose: 'follow_up' } })])).toBeNull();
  });

  it('solo cuenta lo posterior al ÚLTIMO mensaje del lead', () => {
    expect(unsentReply([inbound, out('skipped'), inbound])).toBeNull();
  });
});

describe('attentionItems: «Mensaje no enviado» y «espera tu respuesta» de la misma conversación', () => {
  const alert = (type: string, leadId: string | null, conversationId: string | null): AlertRow => ({ alert: { type, leadId, conversationId } });

  it('se pintan una sola vez (el aviso, que dice por qué no le llegó)', () => {
    const r = attentionItems({
      alerts: [alert('delivery_blocked', 'L1', 'C1'), alert('integration_error', 'L2', 'C2')],
      waiting: [
        { conversationId: 'C1', leadId: 'L1' },
        { conversationId: 'C2', leadId: 'L2' },
        { conversationId: 'C3', leadId: 'L3' },
      ],
      atRisk: [{ id: 'L1' }, { id: 'L4' }],
    });
    expect(r.waiting.map((w) => w.conversationId)).toEqual(['C3']);
    expect(r.otherAlerts).toHaveLength(2);
    // El lead del aviso tampoco se repite como «a punto de perderse».
    expect(r.atRisk.map((l) => l.id)).toEqual(['L4']);
    expect(r.count).toBe(4);
  });

  it('un error de integración sin conversación no quita nada', () => {
    const r = attentionItems({ alerts: [alert('integration_error', null, null)], waiting: [{ conversationId: 'C1', leadId: 'L1' }], atRisk: [] });
    expect(r.waiting).toHaveLength(1);
    expect(r.count).toBe(2);
  });
});

describe('Respuesta de KAI que no se puede entregar (API real)', () => {
  it('la conversación sigue en «Pendientes», la web sabe el motivo y «Hoy» la cuenta una vez', async () => {
    const T = await registerTrainer(app);
    const { lead } = await createLead(T.businessId, { name: 'Sergio Navarro', source: 'manual', phone: '+34600111222' }, { type: 'user', userId: T.userId });
    const conv = await getOrCreateConversation(T.businessId, lead.id, 'whatsapp');
    await receiveInboundForConversation(T.businessId, conv.id, 'Hola, quiero perder 8 kilos antes del verano. ¿Cómo funciona?');
    await runSetterReply(T.businessId, conv.id);

    const res = await T.client.get(`/api/conversations/${conv.id}`);
    expect(res.statusCode).toBe(200);
    const detail = res.json() as { needsHumanReply: boolean; messages: Msg[] };
    // KAI contestó, pero no hay WhatsApp conectado: el lead sigue esperando…
    expect(detail.messages.some((m) => m.direction === 'outbound' && m.senderType === 'kai' && m.status === 'skipped')).toBe(true);
    expect(detail.needsHumanReply).toBe(true);
    // …y la web lo explica con el motivo real en vez de «llegó mientras KAI estaba en pausa».
    expect(unsentReply(detail.messages)?.reason).toMatch(/WhatsApp/);

    const d = await getDashboard(T.businessId);
    expect(d.attention.alerts.map((a) => a.alert.type)).toContain('delivery_blocked');
    expect(d.attention.waiting.map((w) => w.conversationId)).toEqual([conv.id]);
    const r = attentionItems(d.attention);
    expect(r.waiting).toHaveLength(0);
    expect(r.otherAlerts.filter((a) => a.alert.conversationId === conv.id)).toHaveLength(1);
    expect(r.count).toBe(1);
  });
});

describe('Sesión: un fallo de /auth/me no es «sin sesión»', () => {
  it('sessionState distingue error/sin conexión de «el servidor dice que no hay sesión»', () => {
    expect(session.sessionState(undefined, true)).toBe('loading');
    // 429, 502 o sin red: no hay datos y ya no está cargando → no se manda al login.
    expect(session.sessionState(undefined, false)).toBe('unreachable');
    expect(session.sessionState(null, false)).toBe('unreachable');
    expect(session.sessionState({ user: null }, false)).toBe('guest');
    expect(session.sessionState({ user: { id: 'u1' } }, false)).toBe('user');
  });

  it('el 429 se reintenta (con más espera); los demás 4xx no; los 5xx dos veces', () => {
    const tooMany = new ApiError(429, 'rate_limited', 'Demasiadas solicitudes.');
    expect([0, 1, 2, 3].map((n) => session.sessionRetry(n, tooMany))).toEqual([true, true, true, false]);
    expect(session.sessionRetryDelay(0, tooMany)).toBeGreaterThanOrEqual(2000);
    expect(session.sessionRetry(0, new ApiError(403, 'forbidden', 'No.'))).toBe(false);
    const badGateway = new ApiError(502, 'error', 'Algo ha fallado.');
    expect([0, 1, 2].map((n) => session.sessionRetry(n, badGateway))).toEqual([true, true, false]);
    expect(session.sessionRetry(0, new ApiError(0, 'network', 'Sin conexión.'))).toBe(true);
  });
});

describe('focusTrapTarget: Tab no sale del modal', () => {
  const [a, b, c] = ['campo', 'Cancelar', 'Guardar'];
  const list = [a, b, c];

  it('del último control se vuelve al primero, y con Mayús+Tab del primero al último', () => {
    expect(focusTrapTarget(list, c, true, false)).toBe(a);
    expect(focusTrapTarget(list, a, true, true)).toBe(c);
  });

  it('en medio del diálogo el navegador mueve el foco solo', () => {
    expect(focusTrapTarget(list, a, true, false)).toBeNull();
    expect(focusTrapTarget(list, c, true, true)).toBeNull();
  });

  it('si el foco se ha escapado fuera del diálogo, vuelve dentro', () => {
    expect(focusTrapTarget(list, 'enlace del menú', false, false)).toBe(a);
    expect(focusTrapTarget(list, null, false, true)).toBe(c);
  });
});
