import { describe, expect, it } from 'vitest';
import { nextStatus, type PipelineContext } from '../../src/crm/pipeline.js';
import { LEAD_STATUS_KEYS, type LeadStatus } from '../../src/lib/domain.js';

const ctx = (overrides: Partial<PipelineContext> = {}): PipelineContext => ({
  score: 0,
  interestedMin: 51,
  qualifiedMin: 71,
  requiredCaptured: false,
  fitNo: false,
  ...overrides,
});

/** Tabla “estado actual → estado siguiente” para un evento (null = no cambia). */
function table(event: Parameters<typeof nextStatus>[1], c?: PipelineContext) {
  return Object.fromEntries(LEAD_STATUS_KEYS.map((s) => [s, nextStatus(s, event, c)])) as Record<LeadStatus, LeadStatus | null>;
}

describe('nextStatus', () => {
  it('outbound_sent: solo pasa de nuevo a contactado', () => {
    const t = table('outbound_sent');
    expect(t.new).toBe('contacted');
    for (const s of LEAD_STATUS_KEYS.filter((x) => x !== 'new')) expect(t[s]).toBeNull();
  });

  it('inbound_received: abre la conversación desde nuevo, contactado, seguimiento o perdido', () => {
    const t = table('inbound_received');
    expect(t.new).toBe('conversing');
    expect(t.contacted).toBe('conversing');
    expect(t.follow_up).toBe('conversing');
    expect(t.lost).toBe('conversing');
    // Nunca hace retroceder a un lead que ya avanzó.
    for (const s of ['conversing', 'interested', 'qualified', 'call_proposed', 'call_booked', 'reminder_sent', 'no_show', 'client'] as const) {
      expect(t[s]).toBeNull();
    }
  });

  describe('score_updated', () => {
    it('sin contexto o si no encaja no mueve nada', () => {
      expect(nextStatus('conversing', 'score_updated')).toBeNull();
      expect(nextStatus('conversing', 'score_updated', ctx({ score: 95, requiredCaptured: true, fitNo: true }))).toBeNull();
    });

    it('pasa a cualificado con puntuación suficiente y datos obligatorios', () => {
      const c = ctx({ score: 80, requiredCaptured: true });
      expect(nextStatus('contacted', 'score_updated', c)).toBe('qualified');
      expect(nextStatus('conversing', 'score_updated', c)).toBe('qualified');
      expect(nextStatus('interested', 'score_updated', c)).toBe('qualified');
    });

    it('el umbral de cualificado es inclusivo', () => {
      expect(nextStatus('conversing', 'score_updated', ctx({ score: 71, requiredCaptured: true }))).toBe('qualified');
      expect(nextStatus('conversing', 'score_updated', ctx({ score: 70, requiredCaptured: true }))).toBe('interested');
    });

    it('sin los datos obligatorios se queda en interesado aunque la puntuación sea alta', () => {
      expect(nextStatus('conversing', 'score_updated', ctx({ score: 95, requiredCaptured: false }))).toBe('interested');
      expect(nextStatus('interested', 'score_updated', ctx({ score: 95, requiredCaptured: false }))).toBeNull();
    });

    it('pasa a interesado al llegar al umbral de interés', () => {
      expect(nextStatus('conversing', 'score_updated', ctx({ score: 51 }))).toBe('interested');
      expect(nextStatus('conversing', 'score_updated', ctx({ score: 50 }))).toBeNull();
    });

    it('nunca degrada ni toca estados posteriores (aunque baje la puntuación)', () => {
      for (const s of ['new', 'qualified', 'call_proposed', 'call_booked', 'reminder_sent', 'no_show', 'follow_up', 'client', 'lost'] as const) {
        expect(nextStatus(s, 'score_updated', ctx({ score: 99, requiredCaptured: true }))).toBeNull();
        expect(nextStatus(s, 'score_updated', ctx({ score: 0 }))).toBeNull();
      }
      expect(nextStatus('interested', 'score_updated', ctx({ score: 10 }))).toBeNull();
    });
  });

  it('call_proposed: avanza desde estados previos y reabre no presentados/seguimiento', () => {
    const t = table('call_proposed');
    for (const s of ['new', 'contacted', 'conversing', 'interested', 'qualified'] as const) expect(t[s]).toBe('call_proposed');
    expect(t.no_show).toBe('call_proposed');
    expect(t.follow_up).toBe('call_proposed');
    // Sin retrocesos: con la llamada ya agendada no vuelve a “propuesta”.
    expect(t.call_proposed).toBeNull();
    expect(t.call_booked).toBeNull();
    expect(t.reminder_sent).toBeNull();
    expect(t.client).toBeNull();
    expect(t.lost).toBeNull();
  });

  it('call_booked: cualquier estado salvo cliente pasa a llamada agendada', () => {
    const t = table('call_booked');
    for (const s of LEAD_STATUS_KEYS.filter((x) => x !== 'client')) expect(t[s]).toBe('call_booked');
    expect(t.client).toBeNull();
  });

  it('reminder_sent: solo desde llamada agendada', () => {
    const t = table('reminder_sent');
    expect(t.call_booked).toBe('reminder_sent');
    for (const s of LEAD_STATUS_KEYS.filter((x) => x !== 'call_booked')) expect(t[s]).toBeNull();
  });

  it('no_show: cualquier estado salvo cliente', () => {
    const t = table('no_show');
    expect(t.call_booked).toBe('no_show');
    expect(t.reminder_sent).toBe('no_show');
    expect(t.client).toBeNull();
  });

  it('followup_sent: solo desde estados de conversación activa o no presentado', () => {
    const t = table('followup_sent');
    for (const s of ['contacted', 'conversing', 'interested', 'qualified', 'call_proposed', 'no_show'] as const) expect(t[s]).toBe('follow_up');
    for (const s of ['new', 'call_booked', 'reminder_sent', 'follow_up', 'client', 'lost'] as const) expect(t[s]).toBeNull();
  });

  it.each(['appointment_cancelled', 'call_follow_up'] as const)('%s: pasa a seguimiento salvo si ya es cliente', (event) => {
    const t = table(event);
    expect(t.call_booked).toBe('follow_up');
    expect(t.reminder_sent).toBe('follow_up');
    expect(t.no_show).toBe('follow_up');
    expect(t.client).toBeNull();
  });

  it('won: siempre pasa a cliente', () => {
    for (const s of LEAD_STATUS_KEYS) expect(nextStatus(s, 'won')).toBe('client');
  });

  it('lost: siempre pasa a perdido', () => {
    for (const s of LEAD_STATUS_KEYS) expect(nextStatus(s, 'lost')).toBe('lost');
  });

  it('un cliente nunca retrocede por eventos automáticos', () => {
    const automatic = ['outbound_sent', 'inbound_received', 'score_updated', 'call_proposed', 'call_booked', 'reminder_sent', 'no_show', 'followup_sent', 'appointment_cancelled', 'call_follow_up'] as const;
    for (const e of automatic) expect(nextStatus('client', e, ctx({ score: 100, requiredCaptured: true }))).toBeNull();
  });

  it('un evento desconocido no hace nada', () => {
    expect(nextStatus('conversing', 'desconocido' as never)).toBeNull();
  });

  // BUG: un lead marcado como perdido (estado cerrado) vuelve a “seguimiento” si se cancela una cita
  // de forma automática (p. ej. webhook de Calendly), y KAI podría volver a escribirle.
  it.fails('BUG: una cancelación automática no debería reabrir un lead perdido', () => {
    expect(nextStatus('lost', 'appointment_cancelled')).toBeNull();
  });
});
