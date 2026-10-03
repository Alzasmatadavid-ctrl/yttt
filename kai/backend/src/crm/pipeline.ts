/**
 * Máquina de estados del pipeline. KAI mueve los leads automáticamente según eventos reales;
 * el entrenador puede moverlos a mano en cualquier momento (eso no pasa por aquí).
 */
import { LEAD_STATUSES, type LeadStatus } from '../lib/domain.js';

export type PipelineEvent =
  | 'outbound_sent'
  | 'inbound_received'
  | 'score_updated'
  | 'call_proposed'
  | 'call_booked'
  | 'reminder_sent'
  | 'no_show'
  | 'followup_sent'
  | 'appointment_cancelled'
  | 'call_follow_up'
  | 'won'
  | 'lost';

export interface PipelineContext {
  score: number;
  interestedMin: number;
  qualifiedMin: number;
  requiredCaptured: boolean;
  fitNo: boolean;
}

const rank = (s: LeadStatus) => LEAD_STATUSES.find((x) => x.key === s)?.rank ?? 0;

export function nextStatus(current: LeadStatus, event: PipelineEvent, ctx?: PipelineContext): LeadStatus | null {
  switch (event) {
    case 'outbound_sent':
      return current === 'new' ? 'contacted' : null;
    case 'inbound_received':
      if (current === 'new' || current === 'contacted' || current === 'follow_up' || current === 'lost') return 'conversing';
      return null;
    case 'score_updated': {
      if (!ctx || ctx.fitNo) return null;
      const early: LeadStatus[] = ['contacted', 'conversing', 'interested'];
      if (!early.includes(current)) return null;
      if (ctx.score >= ctx.qualifiedMin && ctx.requiredCaptured) return 'qualified';
      if (ctx.score >= ctx.interestedMin && current !== 'interested') return 'interested';
      return null;
    }
    case 'call_proposed':
      if (current === 'client' || current === 'lost') return null;
      if (current === 'no_show' || current === 'follow_up') return 'call_proposed';
      return rank(current) < rank('call_proposed') ? 'call_proposed' : null;
    case 'call_booked':
      return current === 'client' ? null : 'call_booked';
    case 'reminder_sent':
      return current === 'call_booked' ? 'reminder_sent' : null;
    case 'no_show':
      return current === 'client' ? null : 'no_show';
    case 'followup_sent':
      return ['contacted', 'conversing', 'interested', 'qualified', 'call_proposed', 'no_show'].includes(current) ? 'follow_up' : null;
    case 'appointment_cancelled':
      // Una cancelación (p. ej. desde Calendly) no reabre un lead cerrado: KAI no debe volver a escribirle.
      return current === 'client' || current === 'lost' ? null : 'follow_up';
    case 'call_follow_up':
      // Decisión explícita del entrenador tras la llamada: sí puede reabrir un lead perdido.
      return current === 'client' ? null : 'follow_up';
    case 'won':
      return 'client';
    case 'lost':
      return 'lost';
    default:
      return null;
  }
}
