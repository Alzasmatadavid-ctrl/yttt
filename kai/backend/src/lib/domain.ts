/**
 * Vocabulario de dominio de KAI, compartido por backend y frontend.
 * Este archivo NO debe importar nada de Node: el frontend lo reutiliza tal cual.
 */

// ───────────── Pipeline ─────────────

export const LEAD_STATUSES = [
  { key: 'new', label: 'Nuevo', rank: 0 },
  { key: 'contacted', label: 'Contactado', rank: 1 },
  { key: 'conversing', label: 'Conversando', rank: 2 },
  { key: 'interested', label: 'Interesado', rank: 3 },
  { key: 'qualified', label: 'Cualificado', rank: 4 },
  { key: 'call_proposed', label: 'Llamada propuesta', rank: 5 },
  { key: 'call_booked', label: 'Llamada agendada', rank: 6 },
  { key: 'reminder_sent', label: 'Recordatorio enviado', rank: 7 },
  { key: 'no_show', label: 'No presentado', rank: 8 },
  { key: 'follow_up', label: 'Seguimiento', rank: 9 },
  { key: 'client', label: 'Cliente', rank: 10 },
  { key: 'lost', label: 'Perdido', rank: 11 },
] as const;

export type LeadStatus = (typeof LEAD_STATUSES)[number]['key'];
export const LEAD_STATUS_KEYS = LEAD_STATUSES.map((s) => s.key) as LeadStatus[];
export const leadStatusLabel = (s: LeadStatus) => LEAD_STATUSES.find((x) => x.key === s)?.label ?? s;
export const isLeadStatus = (v: unknown): v is LeadStatus => typeof v === 'string' && (LEAD_STATUS_KEYS as string[]).includes(v);

/** Etiqueta para leads que entraron con el límite de leads del plan superado (KAI no les responde solo). */
export const OVER_LIMIT_TAG = 'fuera_de_limite';

/** Estados “cerrados”: KAI no debe intentar avanzar automáticamente a estos leads. */
export const CLOSED_STATUSES: LeadStatus[] = ['client', 'lost'];
/** Estados en los que existe (o existió) una llamada. */
export const CALL_STATUSES: LeadStatus[] = ['call_booked', 'reminder_sent'];

// ───────────── Temperatura / puntuación ─────────────

export const LEAD_TEMPERATURES = [
  { key: 'frio', label: 'Frío' },
  { key: 'curioso', label: 'Curioso' },
  { key: 'interesado', label: 'Interesado' },
  { key: 'caliente', label: 'Caliente' },
  { key: 'muy_cualificado', label: 'Muy cualificado' },
] as const;
export type LeadTemperature = (typeof LEAD_TEMPERATURES)[number]['key'];
export const temperatureLabel = (t: LeadTemperature) => LEAD_TEMPERATURES.find((x) => x.key === t)?.label ?? t;

export interface ScoreBand {
  key: LeadTemperature;
  label: string;
  min: number;
  max: number;
}

export const DEFAULT_SCORE_BANDS: ScoreBand[] = [
  { key: 'frio', label: 'Frío', min: 0, max: 30 },
  { key: 'curioso', label: 'Curioso', min: 31, max: 50 },
  { key: 'interesado', label: 'Interesado', min: 51, max: 70 },
  { key: 'caliente', label: 'Caliente', min: 71, max: 85 },
  { key: 'muy_cualificado', label: 'Muy cualificado', min: 86, max: 100 },
];

// ───────────── Cualificación ─────────────

export const STANDARD_QUALIFICATION_KEYS = [
  'goal',
  'current_situation',
  'problem',
  'motivation',
  'previous_attempts',
  'frustration',
  'urgency',
  'commitment',
  'budget',
  'fit',
] as const;
export type StandardQualificationKey = (typeof STANDARD_QUALIFICATION_KEYS)[number];

/** KAI hace UNA sola pregunta por mensaje: cada pregunta de cualificación debe serlo. */
export const ONE_QUESTION_MESSAGE = 'Escribe una sola pregunta: KAI hace solo una pregunta por mensaje.';

/** ¿El texto contiene más de una pregunta? (más de un «?»). */
export const hasSeveralQuestions = (text: string) => (text.match(/\?/g) ?? []).length > 1;

export type SignalLevel = 'high' | 'medium' | 'low';
export type BudgetLevel = 'yes' | 'maybe' | 'no';
export type FitLevel = 'yes' | 'unknown' | 'no';

export interface QualificationItem {
  value: string;
  confidence: number; // 0..1
  level?: SignalLevel | BudgetLevel | FitLevel;
  updatedAt: string;
}
export type LeadQualification = Record<string, QualificationItem>;

export interface LeadSignals {
  urgency?: SignalLevel;
  commitment?: SignalLevel;
  budget?: BudgetLevel;
  fit?: FitLevel;
  sentiment?: 'positive' | 'neutral' | 'negative' | 'angry';
  intent?: SignalLevel;
}

// ───────────── Canales y fuentes ─────────────

export const LEAD_SOURCES = [
  { key: 'instagram', label: 'Instagram' },
  { key: 'whatsapp', label: 'WhatsApp' },
  { key: 'meta_ads', label: 'Meta Ads' },
  { key: 'landing', label: 'Landing' },
  { key: 'webhook', label: 'Webhook' },
  { key: 'manual', label: 'Manual' },
  { key: 'simulator', label: 'Simulador' },
] as const;
export type LeadSource = (typeof LEAD_SOURCES)[number]['key'];
export const leadSourceLabel = (s: LeadSource) => LEAD_SOURCES.find((x) => x.key === s)?.label ?? s;

/** Canales conversacionales. `web` = simulador interno / chat de pruebas. */
export type ChannelKey = 'whatsapp' | 'instagram' | 'web';
export const CHANNEL_LABELS: Record<ChannelKey, string> = { whatsapp: 'WhatsApp', instagram: 'Instagram', web: 'Simulador' };

export interface TemplateRef {
  name: string;
  language: string;
}

export interface ChannelConfig {
  /** Plantillas aprobadas de WhatsApp para escribir fuera de la ventana de 24 h. */
  templates?: {
    firstContact?: TemplateRef;
    followUp?: TemplateRef;
    reminder?: TemplateRef;
    noShow?: TemplateRef;
  };
  /** Instagram: host de la API (Instagram Login → graph.instagram.com, Facebook Login → graph.facebook.com). */
  apiHost?: 'graph.instagram.com' | 'graph.facebook.com';
  phoneNumber?: string;
  wabaId?: string;
  pageId?: string;
  /** Lead Ads: limitar a ciertos formularios (vacío = todos). */
  formIds?: string[];
  /** Lead Ads: canal por el que KAI inicia la conversación con el lead. */
  firstContactChannel?: 'whatsapp' | 'none';
}

// ───────────── Roles ─────────────

export type BusinessRole = 'trainer' | 'team_member';
export const ROLE_LABELS: Record<BusinessRole | 'admin', string> = {
  admin: 'Admin',
  trainer: 'Entrenador',
  team_member: 'Miembro del equipo',
};

export const PERMISSIONS = [
  'leads:read',
  'leads:write',
  'leads:delete',
  'conversations:reply',
  'settings:read',
  'settings:write',
  'integrations:manage',
  'team:manage',
  'billing:manage',
  'analytics:read',
  'copilot:use',
  'automations:manage',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export const ROLE_PERMISSIONS: Record<BusinessRole, Permission[]> = {
  trainer: [...PERMISSIONS],
  team_member: ['leads:read', 'leads:write', 'conversations:reply', 'settings:read', 'analytics:read', 'copilot:use'],
};

// ───────────── Planes ─────────────

export interface PlanLimits {
  /** null = ilimitado */
  maxLeadsPerMonth: number | null;
  maxAiMessagesPerMonth: number | null;
  maxTeamMembers: number | null;
  maxChannels: number | null;
  maxBusinesses: number | null;
  copilot: boolean;
  advancedAnalytics: boolean;
}

export const USAGE_METRICS = ['leads', 'ai_messages', 'copilot_queries'] as const;
export type UsageMetric = (typeof USAGE_METRICS)[number];

// ───────────── Setter: tono y reglas ─────────────

export interface AiTone {
  formality: number; // 1 (muy informal) – 5 (muy formal)
  energy: number; // 1 (calmado) – 5 (muy enérgico)
  directness: number; // 1 (suave) – 5 (muy directo)
  emojiUsage: 'none' | 'low' | 'medium' | 'high';
  messageLength: 'short' | 'medium' | 'long';
  addressing: 'tu' | 'usted';
}

export const DEFAULT_TONE: AiTone = {
  formality: 2,
  energy: 3,
  directness: 3,
  emojiUsage: 'low',
  messageLength: 'short',
  addressing: 'tu',
};

export interface HandoffRules {
  angry: boolean;
  medical: boolean;
  humanRequest: boolean;
  complexNegotiation: boolean;
  outOfScope: boolean;
  technicalIssue: boolean;
  /** Mensaje que KAI envía al lead al pasar la conversación a una persona (vacío = no enviar nada). */
  handoffMessage: string;
}

export const HANDOFF_REASONS = {
  angry: 'Lead molesto o enfadado',
  medical: 'Cuestión médica relevante',
  human_request: 'Pide hablar con una persona',
  complex_negotiation: 'Negociación compleja',
  out_of_scope: 'Conversación fuera del alcance',
  technical_issue: 'Problema técnico',
  quality_check_failed: 'KAI no pudo generar una respuesta segura',
  exceptional_request: 'Petición excepcional',
  limit_reached: 'Límite del plan alcanzado',
} as const;
export type HandoffReason = keyof typeof HANDOFF_REASONS;

// ───────────── Conversación ─────────────

export interface OfferedSlot {
  id: string;
  start: string; // ISO UTC
  end: string;
  label: string; // “mañana a las 18:00”
  bookingUrl?: string; // Calendly
}

export interface ConversationState {
  lastAskedKey?: string;
  offeredSlots?: OfferedSlot[];
  /** Ids de la ÚLTIMA oferta de horarios, en orden (para entender “la primera”, “la segunda”…). */
  lastOfferIds?: string[];
  offeredAt?: string;
  priceAskedCount?: number;
  priceShared?: boolean;
  callProposedAt?: string;
  callAccepted?: boolean;
  objectionsHandled?: string[];
  lastAnalysisAt?: string;
  medicalFlag?: boolean;
  /** El lead rechazó (o canceló) la llamada: KAI no se la vuelve a proponer salvo que la pida él. */
  callDeclinedAt?: string;
  /** Ya se resolvieron una vez sus dudas sobre la llamada (no se repite la misma explicación). */
  callReassuredAt?: string;
}

// ───────────── Agenda ─────────────

export type CalendarProviderKey = 'internal' | 'google' | 'calendly';
export type AppointmentStatus = 'scheduled' | 'completed' | 'no_show' | 'cancelled' | 'rescheduled';
export type AppointmentOutcome = 'won' | 'lost' | 'follow_up';

export interface TimeRange {
  start: string; // "09:00"
  end: string; // "14:00"
}
/** Disponibilidad semanal. Claves ISO: 1 = lunes … 7 = domingo. */
export type AvailabilityWeek = Record<'1' | '2' | '3' | '4' | '5' | '6' | '7', TimeRange[]>;

export const WEEKDAY_LABELS: Record<string, string> = {
  '1': 'Lunes',
  '2': 'Martes',
  '3': 'Miércoles',
  '4': 'Jueves',
  '5': 'Viernes',
  '6': 'Sábado',
  '7': 'Domingo',
};

// ───────────── Automatizaciones ─────────────

export type AutomationType = 'followup_no_reply' | 'appointment_reminders' | 'no_show_recovery' | 'post_call';

export interface FollowUpStep {
  delayHours: number;
  angle: string;
}

export interface AutomationConfig {
  steps?: FollowUpStep[];
  quietHours?: { start: string; end: string };
  confirmation?: boolean;
  reminder24h?: boolean;
  reminder1h?: boolean;
  delayMinutes?: number;
  /**
   * Textos editables (vacíos o ausentes = texto por defecto de KAI, adaptado al tono).
   * Variables: {nombre}, {fecha}, {hora}, {llamada}, {entrenador}, {enlace}.
   * Los tres primeros son de “appointment_reminders”; `noShowMessage`, de “no_show_recovery”.
   */
  confirmationMessage?: string;
  reminder24hMessage?: string;
  reminder1hMessage?: string;
  noShowMessage?: string;
}

export const AUTOMATION_LABELS: Record<AutomationType, string> = {
  followup_no_reply: 'Seguimiento si el lead deja de responder',
  appointment_reminders: 'Confirmación y recordatorios de llamada',
  no_show_recovery: 'Recuperación de no presentados',
  post_call: 'Registro del resultado tras la llamada',
};

// ───────────── Utilidades compartidas ─────────────

export function formatMoney(cents: number, currency = 'EUR', locale = 'es-ES'): string {
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    maximumFractionDigits: cents % 100 === 0 ? 0 : 2,
  }).format(cents / 100);
}

export const BILLING_PERIOD_LABELS: Record<string, string> = {
  one_time: 'pago único',
  monthly: 'al mes',
  quarterly: 'al trimestre',
  semiannual: 'al semestre',
  annual: 'al año',
};
