/**
 * Revisión nº5 — grupo «plataforma», piezas de la web (frontend/src) que se pueden probar con datos sueltos.
 *  - Agendar a mano: el aviso de «Llamada agendada» no promete confirmación ni recordatorios que KAI no va a enviar
 *    (lead sin conversación con KAI, dado de baja o con la confirmación y los recordatorios desactivados).
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

type Automation = { type: string; enabled: boolean; config: { confirmation?: boolean; reminder24h?: boolean; reminder1h?: boolean } };
type Notice = {
  bookedCallNotice: (opts: {
    start: Date | string;
    now?: Date;
    hasConversation: boolean;
    optedOut: boolean;
    automations?: Automation[] | null;
    willNotify?: boolean | null;
  }) => { text: string; tone: 'success' | 'info' };
  cannotNotifyReason: (opts: { hasConversation: boolean; optedOut: boolean }) => string | null;
};

// Se carga por ruta: así la web no entra en la compilación del servidor (tsc) y vitest la transforma igual.
const here = path.dirname(fileURLToPath(import.meta.url));
const web = (file: string) => path.join(here, '../../../frontend/src', file);
let n: Notice;
beforeAll(async () => {
  n = (await import(web('components/book-call-notice.ts'))) as Notice;
});

const now = new Date('2026-10-14T10:00:00Z');
const inDays = (d: number) => new Date(now.getTime() + d * 86_400_000);
const reminders = (enabled: boolean, config: Automation['config'] = {}): Automation[] => [
  { type: 'followup_no_reply', enabled: true, config: {} },
  { type: 'appointment_reminders', enabled, config },
];

describe('Agendar una llamada a mano: el aviso dice lo que KAI enviará de verdad', () => {
  it('con conversación y recordatorios activos, promete la confirmación y los recordatorios', () => {
    const r = n.bookedCallNotice({ start: inDays(3), now, hasConversation: true, optedOut: false, automations: reminders(true) });
    expect(r).toEqual({ text: 'Llamada agendada. KAI le enviará la confirmación y los recordatorios.', tone: 'success' });
  });

  it('lead creado a mano, sin conversación con KAI: no promete nada y pide avisarle', () => {
    const r = n.bookedCallNotice({ start: inDays(3), now, hasConversation: false, optedOut: false, automations: reminders(true) });
    expect(r.tone).toBe('info');
    expect(r.text).toMatch(/no tiene ninguna conversación/);
    expect(r.text).toMatch(/Avísale tú/);
    expect(r.text).not.toMatch(/KAI le enviará/);
    expect(n.cannotNotifyReason({ hasConversation: false, optedOut: false })).toMatch(/no puede enviarle/);
  });

  it('lead dado de baja: no le escribe aunque tenga conversación', () => {
    const r = n.bookedCallNotice({ start: inDays(3), now, hasConversation: true, optedOut: true, automations: reminders(true) });
    expect(r.tone).toBe('info');
    expect(r.text).toMatch(/dado de baja/);
    expect(n.cannotNotifyReason({ hasConversation: true, optedOut: false })).toBeNull();
  });

  it('confirmación y recordatorios desactivados (automatización apagada o los tres mensajes apagados)', () => {
    for (const automations of [reminders(false), reminders(true, { confirmation: false, reminder24h: false, reminder1h: false }), []]) {
      const r = n.bookedCallNotice({ start: inDays(3), now, hasConversation: true, optedOut: false, automations });
      expect(r.tone).toBe('info');
      expect(r.text).toMatch(/desactivados la confirmación y los recordatorios/);
    }
  });

  it('solo promete lo que está activo y lo que da tiempo a enviar', () => {
    const base = { now, hasConversation: true, optedOut: false };
    expect(n.bookedCallNotice({ ...base, start: inDays(3), automations: reminders(true, { confirmation: false }) }).text).toBe(
      'Llamada agendada. KAI le enviará los recordatorios.',
    );
    expect(n.bookedCallNotice({ ...base, start: inDays(3), automations: reminders(true, { reminder24h: false, reminder1h: false }) }).text).toBe(
      'Llamada agendada. KAI le enviará la confirmación.',
    );
    // Dentro de 3 horas: ya no hay recordatorio del día antes, sí el de una hora antes.
    expect(n.bookedCallNotice({ ...base, start: new Date(now.getTime() + 3 * 3600_000), automations: reminders(true) }).text).toBe(
      'Llamada agendada. KAI le enviará la confirmación y un recordatorio una hora antes.',
    );
    // Dentro de 30 minutos y sin confirmación: no sale ningún mensaje.
    const soon = n.bookedCallNotice({ ...base, start: new Date(now.getTime() + 30 * 60_000), automations: reminders(true, { confirmation: false }) });
    expect(soon.tone).toBe('info');
    expect(soon.text).toMatch(/avísale tú/);
  });

  it('si el servidor dice que no podrá avisar, manda eso; sin ajustes cargados no promete mensajes concretos', () => {
    expect(n.bookedCallNotice({ start: inDays(3), now, hasConversation: true, optedOut: false, automations: reminders(true), willNotify: false }).tone).toBe('info');
    const unknown = n.bookedCallNotice({ start: inDays(3), now, hasConversation: true, optedOut: false });
    expect(unknown.text).toMatch(/que tengas activados/);
  });
});

describe('Arranque: META_APP_ID', () => {
  it('avisa si hay secreto de la app de Meta pero no su identificador (no se podría comprobar la app de los tokens)', async () => {
    const { env, startupWarnings } = await import('../../src/config/env.js');
    const saved = { id: env.META_APP_ID, secret: env.META_APP_SECRET };
    try {
      env.META_APP_SECRET = 'secreto';
      env.META_APP_ID = undefined;
      expect(startupWarnings().join('\n')).toMatch(/Falta META_APP_ID/);
      env.META_APP_ID = '123';
      expect(startupWarnings().join('\n')).not.toMatch(/META_APP_ID/);
    } finally {
      env.META_APP_ID = saved.id;
      env.META_APP_SECRET = saved.secret;
    }
  });
});
