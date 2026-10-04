/**
 * Herramientas que KAI puede usar durante una conversación.
 * Todas operan con datos REALES (agenda, citas) y quedan registradas para el control de calidad:
 * así el validador sabe exactamente qué horarios se ofrecieron y puede rechazar cualquier inventado.
 */
import type { HandoffReason, OfferedSlot } from '../../lib/domain.js';
import { HANDOFF_REASONS } from '../../lib/domain.js';
import { AppError, errorMessage } from '../../lib/errors.js';
import { humanSlotLabel } from '../../lib/time.js';
import { bookAppointment, cancelAppointment, getOfferableSlots, rescheduleAppointment, type Appointment } from '../../calendar/calendar.service.js';
import { slotStartFromId } from '../../calendar/availability.js';
import { updateConversationState } from '../../crm/conversations.service.js';
import { applyPipelineEvent } from '../../crm/leads.service.js';
import type { ToolDefinition } from '../providers/types.js';
import type { BusinessContext, ConversationRow, LeadContext } from '../context/context.js';

export interface ToolRunRecord {
  name: string;
  input: Record<string, unknown>;
  ok: boolean;
  result: unknown;
}

const HANDOFF_KEYS = Object.keys(HANDOFF_REASONS) as HandoffReason[];

export const SETTER_TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'get_available_slots',
    description:
      'Consulta la agenda REAL del entrenador y devuelve 2–3 horarios libres para la llamada, con su slot_id y una etiqueta lista para usar en el mensaje. Úsala siempre antes de mencionar cualquier horario.',
    inputSchema: {
      type: 'object',
      properties: {
        date: { anyOf: [{ type: 'string' }, { type: 'null' }], description: 'Día concreto en formato YYYY-MM-DD, o null para los próximos días.' },
        part_of_day: { type: 'string', enum: ['morning', 'afternoon', 'evening', 'any'], description: 'Franja preferida.' },
      },
      required: ['date', 'part_of_day'],
      additionalProperties: false,
    },
  },
  {
    name: 'book_call',
    description: 'Reserva la llamada en un horario que el lead ha elegido. Solo acepta slot_id devueltos por get_available_slots.',
    inputSchema: {
      type: 'object',
      properties: { slot_id: { type: 'string' } },
      required: ['slot_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'reschedule_call',
    description: 'Mueve la llamada ya agendada del lead a un nuevo horario (slot_id de get_available_slots).',
    inputSchema: {
      type: 'object',
      properties: { slot_id: { type: 'string' } },
      required: ['slot_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'cancel_call',
    description: 'Cancela la llamada agendada del lead. Úsala solo si el lead pide cancelar explícitamente y no quiere otro horario.',
    inputSchema: {
      type: 'object',
      properties: { reason: { type: 'string' } },
      required: ['reason'],
      additionalProperties: false,
    },
  },
  {
    name: 'request_human',
    description:
      'Pasa la conversación al entrenador/equipo y detiene a KAI en esta conversación. Úsala si el lead pide una persona, está enfadado, hay una cuestión médica relevante, una negociación compleja, un problema técnico o algo fuera de tu alcance.',
    inputSchema: {
      type: 'object',
      properties: {
        reason: { type: 'string', enum: HANDOFF_KEYS },
        detail: { type: 'string', description: 'Resumen breve para el entrenador.' },
      },
      required: ['reason', 'detail'],
      additionalProperties: false,
    },
  },
];

export class SetterToolbox {
  readonly records: ToolRunRecord[] = [];
  offeredThisTurn: OfferedSlot[] = [];
  booked: Appointment | null = null;
  /** La llamada agendada se canceló en este turno. */
  cancelled = false;
  bookingUrl: string | null = null;
  /** Etiqueta del horario cuyo enlace de reserva (Calendly) ya se dio en este turno. */
  private linkLabel: string | null = null;
  handoff: { reason: HandoffReason; detail: string } | null = null;
  private offeredAll: OfferedSlot[];

  constructor(
    private readonly biz: BusinessContext,
    private readonly leadCtx: LeadContext,
    private readonly conversation: ConversationRow,
  ) {
    this.offeredAll = [...(conversation.state.offeredSlots ?? [])];
  }

  definitions(): ToolDefinition[] {
    return SETTER_TOOL_DEFINITIONS;
  }

  /** Horarios válidos para mencionar en el mensaje (ofrecidos + cita reservada). */
  allowedTimes(): Date[] {
    const times = [...this.offeredAll, ...this.offeredThisTurn].map((s) => new Date(s.start));
    if (this.booked) times.push(this.booked.startsAt);
    if (this.leadCtx.upcomingAppointment) times.push(this.leadCtx.upcomingAppointment.startsAt);
    return times;
  }

  allowedUrls(): string[] {
    const urls = [...this.offeredAll, ...this.offeredThisTurn].map((s) => s.bookingUrl).filter((u): u is string => Boolean(u));
    if (this.bookingUrl) urls.push(this.bookingUrl);
    if (this.booked?.meetingUrl) urls.push(this.booked.meetingUrl);
    if (this.leadCtx.upcomingAppointment?.meetingUrl) urls.push(this.leadCtx.upcomingAppointment.meetingUrl);
    return urls;
  }

  async run(name: string, input: Record<string, unknown>): Promise<{ content: string; isError: boolean }> {
    try {
      const result = await this.dispatch(name, input);
      this.records.push({ name, input, ok: true, result });
      return { content: JSON.stringify(result), isError: false };
    } catch (err) {
      const message = err instanceof AppError ? err.message : errorMessage(err);
      this.records.push({ name, input, ok: false, result: { error: message } });
      return { content: JSON.stringify({ error: message }), isError: true };
    }
  }

  private async dispatch(name: string, input: Record<string, unknown>): Promise<unknown> {
    const { business } = this.biz;
    const lead = this.leadCtx.lead;
    switch (name) {
      case 'get_available_slots': {
        const date = typeof input.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(input.date) ? input.date : undefined;
        const pod = input.part_of_day;
        const partOfDay = pod === 'morning' || pod === 'afternoon' || pod === 'evening' ? pod : 'any';
        let { offered } = await getOfferableSlots(business.id, lead, { date, partOfDay, count: 2 });
        let note: string | undefined;
        if (offered.length === 0 && date) {
          ({ offered } = await getOfferableSlots(business.id, lead, { partOfDay, count: 2 }));
          note = 'No hay huecos ese día; estas son las alternativas más cercanas.';
        }
        if (offered.length === 0) return { slots: [], note: 'No hay huecos libres en los próximos días. Dile que lo revisas con el entrenador y que le escribís con opciones; no inventes horarios.' };
        this.offeredThisTurn.push(...offered);
        const merged = [...this.offeredAll.filter((s) => !offered.some((o) => o.id === s.id)), ...offered].slice(-8);
        this.offeredAll = merged;
        await updateConversationState(business.id, this.conversation.id, {
          offeredSlots: merged,
          lastOfferIds: offered.map((o) => o.id),
          offeredAt: new Date().toISOString(),
          callProposedAt: this.conversation.state.callProposedAt ?? new Date().toISOString(),
        });
        await applyPipelineEvent(business.id, lead.id, 'call_proposed');
        return {
          slots: offered.map((s) => ({ slot_id: s.id, label: s.label, ...(s.bookingUrl ? { booking_url: s.bookingUrl } : {}) })),
          ...(note ? { note } : {}),
          ...(this.biz.calendarProvider === 'calendly' ? { how_to_book: 'Cuando elija, llama a book_call y envíale el enlace de reserva que devuelva.' } : {}),
        };
      }
      case 'book_call': {
        // Idempotente: si ya se reservó en este turno (p. ej. la IA lo reintenta o el motor de reglas toma el relevo
        // tras un borrador fallido), se devuelve la misma reserva en vez de intentar ocupar otra vez el hueco.
        const already = this.existingBooking();
        if (already) return already;
        // Una cita por lead: si ya tiene una agendada, elegir otro horario es moverla.
        if (this.leadCtx.upcomingAppointment && !this.cancelled) {
          const moved = (await this.dispatch('reschedule_call', input)) as Record<string, unknown>;
          return { ...moved, rescheduled: true };
        }
        const slot = this.findOffered(String(input.slot_id ?? ''));
        if (!slot) throw new AppError(400, 'slot_not_offered', 'Ese slot_id no se ha ofrecido en esta conversación. Consulta get_available_slots primero.');
        if (this.biz.calendarProvider === 'calendly') {
          if (!slot.bookingUrl) throw new AppError(400, 'no_link', 'No hay enlace de reserva para ese horario.');
          this.bookingUrl = slot.bookingUrl;
          this.linkLabel = humanSlotLabel(slot.start, business.timezone);
          return { mode: 'link', label: this.linkLabel, booking_url: slot.bookingUrl, instructions: 'Envía este enlace al lead para que confirme la reserva en un clic. Aún NO está confirmada.' };
        }
        const appt = await bookAppointment({
          businessId: business.id,
          leadId: lead.id,
          conversationId: this.conversation.id,
          start: new Date(slot.start),
          bookedBy: 'kai',
          actor: { type: 'kai' },
          confirmationAlreadySent: true,
        });
        this.booked = appt;
        await updateConversationState(business.id, this.conversation.id, { offeredSlots: [], lastOfferIds: [], callAccepted: true });
        return { ok: true, confirmed: true, label: humanSlotLabel(appt.startsAt, business.timezone), meeting_url: appt.meetingUrl ?? null };
      }
      case 'reschedule_call': {
        const already = this.existingBooking();
        if (already) return already;
        const upcoming = this.leadCtx.upcomingAppointment;
        if (!upcoming) throw new AppError(400, 'no_appointment', 'El lead no tiene ninguna llamada agendada.');
        const slot = this.findOffered(String(input.slot_id ?? ''));
        if (!slot) throw new AppError(400, 'slot_not_offered', 'Ese slot_id no se ha ofrecido. Consulta get_available_slots primero.');
        if (this.biz.calendarProvider === 'calendly') {
          this.bookingUrl = slot.bookingUrl ?? null;
          this.linkLabel = humanSlotLabel(slot.start, business.timezone);
          return { mode: 'link', label: this.linkLabel, booking_url: slot.bookingUrl, instructions: 'Envíale el enlace para reservar el nuevo horario y dile que puede cancelar la anterior desde el email de Calendly.' };
        }
        const appt = await rescheduleAppointment(business.id, upcoming.id, new Date(slot.start), { type: 'kai' }, 'kai');
        this.booked = appt;
        await updateConversationState(business.id, this.conversation.id, { offeredSlots: [], lastOfferIds: [] });
        return { ok: true, confirmed: true, label: humanSlotLabel(appt.startsAt, business.timezone), meeting_url: appt.meetingUrl ?? null };
      }
      case 'cancel_call': {
        if (this.cancelled) return { ok: true, cancelled: true, already_cancelled: true };
        const upcoming = this.leadCtx.upcomingAppointment;
        if (!upcoming) throw new AppError(400, 'no_appointment', 'El lead no tiene ninguna llamada agendada.');
        if (upcoming.calendarProvider === 'calendly') return { ok: false, note: 'Las citas de Calendly se cancelan desde el enlace del email de confirmación de Calendly.' };
        await cancelAppointment(business.id, upcoming.id, { type: 'kai' }, String(input.reason ?? ''));
        this.cancelled = true;
        return { ok: true, cancelled: true };
      }
      case 'request_human': {
        const reason = HANDOFF_KEYS.includes(input.reason as HandoffReason) ? (input.reason as HandoffReason) : 'exceptional_request';
        this.handoff = { reason, detail: String(input.detail ?? '').slice(0, 300) };
        return { ok: true, note: 'La conversación pasará al entrenador después de este mensaje. Despídete brevemente.' };
      }
      default:
        throw new AppError(400, 'unknown_tool', `Herramienta desconocida: ${name}`);
    }
  }

  /** Reserva (o enlace de reserva) ya hecha en este turno, con el mismo formato que devuelve book_call. */
  private existingBooking(): Record<string, unknown> | null {
    const tz = this.biz.business.timezone;
    if (this.booked) {
      return { ok: true, confirmed: true, already_booked: true, label: humanSlotLabel(this.booked.startsAt, tz), meeting_url: this.booked.meetingUrl ?? null };
    }
    if (this.bookingUrl && this.linkLabel) {
      return { mode: 'link', already_sent: true, label: this.linkLabel, booking_url: this.bookingUrl, instructions: 'Ya tienes el enlace de reserva de este turno: envíaselo al lead. Aún NO está confirmada.' };
    }
    return null;
  }

  private findOffered(id: string): OfferedSlot | null {
    const found = [...this.offeredThisTurn, ...this.offeredAll].find((s) => s.id === id);
    if (found) return found;
    // Tolerancia: si el modelo cita un slot por su hora exacta y coincide con uno ofrecido.
    const start = slotStartFromId(id);
    if (!start) return null;
    return [...this.offeredThisTurn, ...this.offeredAll].find((s) => new Date(s.start).getTime() === start.getTime()) ?? null;
  }
}
