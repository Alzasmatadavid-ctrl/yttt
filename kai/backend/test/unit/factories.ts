/**
 * Fábricas para tests unitarios (sin base de datos).
 * Construyen filas y contextos con valores realistas por defecto; cada test sobrescribe solo lo que le importa.
 */
import { randomUUID } from 'node:crypto';
import { DateTime } from 'luxon';
import type {
  AiSettingsRow,
  AppointmentRow,
  BusinessContext,
  BusinessRow,
  ConversationRow,
  LeadContext,
  LeadRow,
  MessageRow,
  ObjectionRow,
  RuleRow,
  ServiceRow,
  TrainerRow,
} from '../../src/ai/context/context.js';
import type { AnalysisInput, LeadAnalysis } from '../../src/ai/analysis/analyzer.js';
import type { AvailabilityConfig, Interval, Slot } from '../../src/calendar/availability.js';
import { slotId } from '../../src/calendar/availability.js';
import type { ValidationContext } from '../../src/ai/validation/output-validator.js';
import type { ScoringRule } from '../../src/crm/scoring.js';
import { DEFAULT_HANDOFF_RULES, DEFAULT_OBJECTIONS, DEFAULT_QUALIFICATION_RULES } from '../../src/config/defaults.js';
import {
  DEFAULT_SCORE_BANDS,
  DEFAULT_TONE,
  type AiTone,
  type AvailabilityWeek,
  type ConversationState,
  type LeadQualification,
  type OfferedSlot,
  type QualificationItem,
} from '../../src/lib/domain.js';

/** Lunes 5 de octubre de 2026, 12:00 en Madrid (10:00 UTC). */
export const NOW = new Date('2026-10-05T10:00:00.000Z');
export const MADRID = 'Europe/Madrid';
export const MEXICO = 'America/Mexico_City';

const BUSINESS_ID = '00000000-0000-4000-8000-000000000001';
const CREATED = new Date('2026-09-01T10:00:00.000Z');

export const uuid = () => randomUUID();

/** Fecha UTC a partir de una hora local (“2026-10-06T18:00”) en una zona horaria. */
export function local(isoLocal: string, tz: string = MADRID): Date {
  const dt = DateTime.fromISO(isoLocal, { zone: tz });
  if (!dt.isValid) throw new Error(`Fecha local no válida: ${isoLocal}`);
  return dt.toJSDate();
}

/** Hora local “HH:mm” de una fecha en la zona indicada. */
export const hm = (d: Date, tz: string = MADRID) => DateTime.fromJSDate(d).setZone(tz).toFormat('HH:mm');
/** Fecha local “yyyy-MM-dd HH:mm” de una fecha en la zona indicada. */
export const localStamp = (d: Date, tz: string = MADRID) => DateTime.fromJSDate(d).setZone(tz).toFormat('yyyy-MM-dd HH:mm');

// ───────────── Negocio ─────────────

export function makeBusiness(overrides: Partial<BusinessRow> = {}): BusinessRow {
  return {
    id: BUSINESS_ID,
    name: 'Álex Fit',
    planId: null,
    status: 'active',
    subscriptionStatus: 'trialing',
    trialEndsAt: null,
    timezone: MADRID,
    locale: 'es',
    currency: 'EUR',
    publicKey: 'pk_test',
    webhookSecretEnc: 'v1.x.y.z',
    onboardingStep: 5,
    onboardingCompletedAt: CREATED,
    monthlyAdSpendCents: 0,
    accountBusinessId: null,
    createdAt: CREATED,
    updatedAt: CREATED,
    ...overrides,
  };
}

export function makeTrainer(overrides: Partial<TrainerRow> = {}): TrainerRow {
  return {
    id: uuid(),
    businessId: BUSINESS_ID,
    userId: null,
    displayName: 'Álex',
    specialty: 'Pérdida de grasa',
    idealClient: 'Personas con poco tiempo que quieren perder grasa',
    transformation: 'Perder grasa sin dietas extremas',
    methodName: 'Método Álex',
    methodDescription: 'Entrenamiento de fuerza 3 días por semana y hábitos sostenibles.',
    modality: 'online',
    credentials: 'Graduado en CAFYD. Más de 500 clientes. 10 años de experiencia.',
    createdAt: CREATED,
    updatedAt: CREATED,
    ...overrides,
  };
}

export function makeTone(overrides: Partial<AiTone> = {}): AiTone {
  return { ...DEFAULT_TONE, ...overrides };
}

export function makeSettings(overrides: Partial<AiSettingsRow> = {}): AiSettingsRow {
  return {
    id: uuid(),
    businessId: BUSINESS_ID,
    autopilotEnabled: true,
    assistantName: 'KAI',
    persona: 'team_member',
    tone: makeTone(),
    wordsToUse: [],
    wordsToAvoid: [],
    examplesWhatsapp: '',
    examplesInstagram: '',
    examplesOther: '',
    extraInstructions: '',
    pricePolicy: 'contextualize_first',
    disclosureMode: 'first_message',
    callLabel: 'llamada de valoración',
    callDurationMinutes: 30,
    callDescription: '',
    proposeCallMinScore: 60,
    scoreBands: DEFAULT_SCORE_BANDS,
    handoffRules: DEFAULT_HANDOFF_RULES,
    replyDelayMinSeconds: 20,
    replyDelayMaxSeconds: 70,
    createdAt: CREATED,
    updatedAt: CREATED,
    ...overrides,
  };
}

export function makeService(overrides: Partial<ServiceRow> = {}): ServiceRow {
  return {
    id: uuid(),
    businessId: BUSINESS_ID,
    name: 'Programa 12 semanas',
    description: 'Acompañamiento online con plan de entrenamiento y nutrición.',
    priceCents: 19700,
    currency: 'EUR',
    billingPeriod: 'monthly',
    durationWeeks: 12,
    includes: ['Plan de entrenamiento', 'Revisión semanal'],
    isPrimary: true,
    isActive: true,
    createdAt: CREATED,
    updatedAt: CREATED,
    ...overrides,
  };
}

/** Reglas de cualificación por defecto (las mismas que recibe un negocio nuevo). */
export function makeRules(overrides: Partial<Record<string, Partial<RuleRow>>> = {}): RuleRow[] {
  return DEFAULT_QUALIFICATION_RULES.map((t, i) => ({
    id: uuid(),
    businessId: BUSINESS_ID,
    key: t.key,
    label: t.label,
    description: t.description,
    question: t.question,
    weight: t.weight,
    required: t.required,
    enabled: true,
    sortOrder: i,
    disqualifyWhen: t.disqualifyWhen ?? '',
    createdAt: CREATED,
    updatedAt: CREATED,
    ...(overrides[t.key] ?? {}),
  }));
}

/** Biblioteca de objeciones por defecto. */
export function makeObjections(): ObjectionRow[] {
  return DEFAULT_OBJECTIONS.map((o, i) => ({
    id: uuid(),
    businessId: BUSINESS_ID,
    key: o.key,
    label: o.label,
    triggers: [...o.triggers],
    strategy: o.strategy,
    exampleResponse: o.exampleResponse,
    enabled: true,
    sortOrder: i,
    createdAt: CREATED,
    updatedAt: CREATED,
  }));
}

export function makeBusinessContext(overrides: Partial<BusinessContext> = {}): BusinessContext {
  return {
    business: makeBusiness(),
    trainer: makeTrainer(),
    settings: makeSettings(),
    services: [makeService()],
    rules: makeRules(),
    objections: makeObjections(),
    calendarProvider: 'internal',
    ...overrides,
  };
}

// ───────────── Lead, conversación, mensajes, citas ─────────────

export function qItem(value: string, extra: Partial<QualificationItem> = {}): QualificationItem {
  return { value, confidence: 0.8, updatedAt: CREATED.toISOString(), ...extra };
}

/** Cualificación a partir de pares clave → valor (confianza 0.8). */
export function qualificationOf(values: Record<string, string>): LeadQualification {
  return Object.fromEntries(Object.entries(values).map(([k, v]) => [k, qItem(v)]));
}

export function makeLead(overrides: Partial<LeadRow> = {}): LeadRow {
  return {
    id: uuid(),
    businessId: BUSINESS_ID,
    name: 'Laura Gómez',
    phone: '+34600111222',
    email: null,
    instagramUsername: null,
    instagramUserId: null,
    whatsappId: '34600111222',
    avatarUrl: null,
    source: 'whatsapp',
    sourceDetail: null,
    status: 'conversing',
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
    isTest: false,
    lastInboundAt: null,
    lastOutboundAt: null,
    lastInteractionAt: null,
    firstResponseSeconds: null,
    qualifiedAt: null,
    wonAt: null,
    lostAt: null,
    lostReason: null,
    dealValueCents: null,
    createdAt: CREATED,
    updatedAt: CREATED,
    ...overrides,
  };
}

export function makeConversation(overrides: Partial<ConversationRow> = {}): ConversationRow {
  return {
    id: uuid(),
    businessId: BUSINESS_ID,
    leadId: uuid(),
    channel: 'whatsapp',
    channelConnectionId: null,
    status: 'open',
    aiEnabled: true,
    handoffActive: false,
    handoffReason: null,
    handoffAt: null,
    unreadCount: 0,
    lastMessageAt: null,
    lastMessagePreview: null,
    lastInboundAt: null,
    summary: '',
    state: {},
    createdAt: CREATED,
    updatedAt: CREATED,
    ...overrides,
  };
}

export function makeMessage(overrides: Partial<MessageRow> = {}): MessageRow {
  const direction = overrides.direction ?? 'inbound';
  return {
    id: uuid(),
    businessId: BUSINESS_ID,
    conversationId: uuid(),
    leadId: uuid(),
    direction,
    senderType: direction === 'inbound' ? 'lead' : 'kai',
    senderUserId: null,
    content: '',
    contentType: 'text',
    externalId: null,
    status: direction === 'inbound' ? 'received' : 'sent',
    error: null,
    metadata: {},
    createdAt: NOW,
    ...overrides,
  };
}

export const inbound = (content: string) => makeMessage({ direction: 'inbound', content });
export const outbound = (content: string) => makeMessage({ direction: 'outbound', content });

export function makeAppointment(overrides: Partial<AppointmentRow> = {}): AppointmentRow {
  const startsAt = overrides.startsAt ?? local('2026-10-07T18:00');
  return {
    id: uuid(),
    businessId: BUSINESS_ID,
    leadId: uuid(),
    conversationId: null,
    title: 'Llamada de valoración',
    startsAt,
    endsAt: new Date(startsAt.getTime() + 30 * 60_000),
    status: 'scheduled',
    outcome: null,
    outcomeNotes: null,
    calendarProvider: 'internal',
    calendarConnectionId: null,
    externalEventId: null,
    meetingUrl: null,
    bookedBy: 'kai',
    confirmationSentAt: null,
    reminder24hSentAt: null,
    reminder1hSentAt: null,
    createdAt: CREATED,
    updatedAt: CREATED,
    ...overrides,
  };
}

export function makeLeadContext(overrides: Partial<LeadContext> = {}): LeadContext {
  return { lead: makeLead(), memories: [], upcomingAppointment: null, ...overrides };
}

// ───────────── Análisis ─────────────

type Flags = LeadAnalysis['flags'];

export function makeFlags(overrides: Partial<Flags> = {}): Flags {
  return {
    humanRequest: false,
    asksIfBot: false,
    medical: false,
    angry: false,
    optOut: false,
    asksPrice: false,
    wantsCall: false,
    declinesCall: false,
    complexNegotiation: false,
    outOfScope: false,
    technicalIssue: false,
    wantsReschedule: false,
    wantsCancel: false,
    asksQuestion: false,
    ...overrides,
  };
}

export function makeAnalysis(overrides: Omit<Partial<LeadAnalysis>, 'flags'> & { flags?: Partial<Flags> } = {}): LeadAnalysis {
  const { flags, ...rest } = overrides;
  return {
    qualification: {},
    signals: {},
    memories: [],
    objectionKey: null,
    leadName: null,
    goalSummary: null,
    preferredDate: null,
    preferredPartOfDay: null,
    selectedSlotId: null,
    summary: '',
    engine: 'heuristic',
    ...rest,
    flags: makeFlags(flags),
  };
}

export function makeAnalysisInput(
  pending: string | string[],
  overrides: Partial<Omit<AnalysisInput, 'pending'>> = {},
): AnalysisInput {
  const texts = Array.isArray(pending) ? pending : [pending];
  return {
    biz: makeBusinessContext(),
    lead: makeLead(),
    history: [],
    state: {},
    now: NOW,
    ...overrides,
    pending: texts.map(inbound),
  };
}

// ───────────── Agenda ─────────────

const WEEKDAYS_9_TO_12: AvailabilityWeek = {
  '1': [{ start: '09:00', end: '12:00' }],
  '2': [{ start: '09:00', end: '12:00' }],
  '3': [{ start: '09:00', end: '12:00' }],
  '4': [{ start: '09:00', end: '12:00' }],
  '5': [{ start: '09:00', end: '12:00' }],
  '6': [],
  '7': [],
};

export function makeWeek(overrides: Partial<AvailabilityWeek> = {}): AvailabilityWeek {
  return { ...WEEKDAYS_9_TO_12, ...overrides };
}

export function makeAvailabilityConfig(overrides: Partial<AvailabilityConfig> = {}): AvailabilityConfig {
  return {
    timezone: MADRID,
    weekly: makeWeek(),
    slotMinutes: 30,
    bufferMinutes: 0,
    minNoticeMinutes: 0,
    maxDaysAhead: 14,
    blackoutDates: [],
    ...overrides,
  };
}

export function interval(start: Date, minutes: number): Interval {
  return { start, end: new Date(start.getTime() + minutes * 60_000) };
}

/** Hueco de 30 minutos que empieza en la hora local indicada. */
export function slotAt(isoLocal: string, tz: string = MADRID, minutes = 30): Slot {
  const start = local(isoLocal, tz);
  return { id: slotId(start), start, end: new Date(start.getTime() + minutes * 60_000) };
}

/** Horario ofrecido (tal y como se guarda en el estado de la conversación). */
export function offeredAt(isoLocal: string, tz: string = MADRID, label?: string): OfferedSlot {
  const s = slotAt(isoLocal, tz);
  return { id: s.id, start: s.start.toISOString(), end: s.end.toISOString(), label: label ?? `el ${isoLocal}` };
}

// ───────────── Validación ─────────────

export function makeValidationContext(overrides: Partial<ValidationContext> = {}): ValidationContext {
  return {
    tone: makeTone(),
    wordsToAvoid: [],
    timezone: MADRID,
    allowedTimes: [],
    allowedPricesCents: [],
    allowedUrls: [],
    factsText: '',
    ...overrides,
  };
}

// ───────────── Scoring ─────────────

export function rule(key: string, weight: number, extra: Partial<ScoringRule> = {}): ScoringRule {
  return { key, weight, enabled: true, ...extra };
}

export function makeState(overrides: ConversationState = {}): ConversationState {
  return { ...overrides };
}
