/* Tipos de las respuestas de la API (reflejan los modelos del backend). */
import type {
  AiTone,
  AppointmentOutcome,
  AppointmentStatus,
  AutomationConfig,
  AutomationType,
  AvailabilityWeek,
  BusinessRole,
  ChannelConfig,
  ChannelKey,
  ConversationState,
  HandoffRules,
  LeadQualification,
  LeadSignals,
  LeadSource,
  LeadStatus,
  LeadTemperature,
  PlanLimits,
  ScoreBand,
} from '@shared';

export interface Me {
  user: { id: string; email: string; name: string; platformRole: 'admin' | 'user' } | null;
  businesses: { businessId: string; name: string; role: BusinessRole; status: string; onboardingCompletedAt: string | null; planName: string | null }[];
  activeBusinessId: string | null;
}

export interface Lead {
  id: string;
  businessId: string;
  name: string;
  phone: string | null;
  email: string | null;
  instagramUsername: string | null;
  instagramUserId: string | null;
  whatsappId: string | null;
  avatarUrl: string | null;
  source: LeadSource;
  sourceDetail: string | null;
  status: LeadStatus;
  score: number;
  temperature: LeadTemperature;
  qualification: LeadQualification;
  signals: LeadSignals;
  goalSummary: string | null;
  nextAction: string | null;
  nextActionAt: string | null;
  tags: string[];
  notes: string;
  optedOut: boolean;
  isTest: boolean;
  lastInboundAt: string | null;
  lastOutboundAt: string | null;
  lastInteractionAt: string | null;
  firstResponseSeconds: number | null;
  qualifiedAt: string | null;
  wonAt: string | null;
  lostAt: string | null;
  lostReason: string | null;
  dealValueCents: number | null;
  createdAt: string;
}

export interface Conversation {
  id: string;
  leadId: string;
  channel: ChannelKey;
  status: 'open' | 'closed';
  aiEnabled: boolean;
  handoffActive: boolean;
  handoffReason: string | null;
  handoffAt: string | null;
  unreadCount: number;
  lastMessageAt: string | null;
  lastMessagePreview: string | null;
  lastInboundAt: string | null;
  state: ConversationState;
}

export interface Message {
  id: string;
  direction: 'inbound' | 'outbound';
  senderType: 'lead' | 'kai' | 'human' | 'system';
  content: string;
  contentType: string;
  status: string;
  error: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface Appointment {
  id: string;
  leadId: string;
  conversationId: string | null;
  title: string;
  startsAt: string;
  endsAt: string;
  status: AppointmentStatus;
  outcome: AppointmentOutcome | null;
  outcomeNotes: string | null;
  calendarProvider: 'internal' | 'google' | 'calendly';
  meetingUrl: string | null;
  bookedBy: 'kai' | 'human' | 'lead';
}

export interface Memory {
  id: string;
  kind: string;
  content: string;
  createdAt: string;
}

export interface Alert {
  id: string;
  type: string;
  severity: 'info' | 'warning' | 'critical';
  title: string;
  body: string;
  leadId: string | null;
  conversationId: string | null;
  appointmentId: string | null;
  createdAt: string;
}

export interface QualificationRule {
  id: string;
  key: string;
  label: string;
  description: string;
  question: string;
  weight: number;
  required: boolean;
  enabled: boolean;
  sortOrder: number;
  disqualifyWhen: string;
}

export interface Objection {
  id: string;
  key: string;
  label: string;
  triggers: string[];
  strategy: string;
  exampleResponse: string;
  enabled: boolean;
}

export interface Service {
  id: string;
  name: string;
  description: string;
  priceCents: number;
  currency: string;
  billingPeriod: 'one_time' | 'monthly' | 'quarterly' | 'semiannual' | 'annual';
  durationWeeks: number | null;
  includes: string[];
  isPrimary: boolean;
  isActive: boolean;
}

export interface AiSettings {
  autopilotEnabled: boolean;
  assistantName: string;
  persona: 'team_member' | 'trainer';
  disclosureMode: 'first_message' | 'on_request';
  tone: AiTone;
  wordsToUse: string[];
  wordsToAvoid: string[];
  examplesWhatsapp: string;
  examplesInstagram: string;
  examplesOther: string;
  extraInstructions: string;
  pricePolicy: 'contextualize_first' | 'share_directly';
  callLabel: string;
  callDurationMinutes: number;
  callDescription: string;
  proposeCallMinScore: number;
  scoreBands: ScoreBand[];
  handoffRules: HandoffRules;
  replyDelayMinSeconds: number;
  replyDelayMaxSeconds: number;
}

export interface Trainer {
  displayName: string;
  specialty: string;
  idealClient: string;
  transformation: string;
  methodName: string;
  methodDescription: string;
  modality: 'online' | 'presencial' | 'hibrido';
  credentials: string;
}

export interface Automation {
  id: string;
  type: AutomationType;
  name: string;
  enabled: boolean;
  config: AutomationConfig;
}

export interface AvailabilityConfig {
  timezone: string;
  weekly: AvailabilityWeek;
  slotMinutes: number;
  bufferMinutes: number;
  minNoticeMinutes: number;
  maxDaysAhead: number;
  blackoutDates: string[];
  callDurationMinutes: number;
}

export interface Business {
  id: string;
  name: string;
  timezone: string;
  currency: string;
  publicKey: string;
  onboardingStep: number;
  onboardingCompletedAt: string | null;
  monthlyAdSpendCents: number;
  subscriptionStatus: string;
  trialEndsAt: string | null;
  status: string;
}

export interface SettingsResponse {
  business: Business;
  trainer: Trainer;
  aiSettings: AiSettings;
  services: Service[];
  qualificationRules: QualificationRule[];
  objections: Objection[];
  automations: Automation[];
  availability: AvailabilityConfig;
  limits: PlanLimits;
  usage: Record<string, number>;
  ai: { mode: 'llm' | 'simulated'; provider: string; mainModel: string; fastModel: string };
}

export interface ChannelConnection {
  id: string;
  channel: 'whatsapp' | 'instagram' | 'meta_lead_ads';
  status: 'connected' | 'error' | 'disconnected';
  displayName: string;
  externalAccountId: string;
  config: ChannelConfig;
  lastEventAt: string | null;
  lastError: string | null;
}

export interface CalendarConnection {
  id: string;
  provider: 'google' | 'calendly';
  status: 'connected' | 'error' | 'disconnected';
  accountEmail: string | null;
  calendarId: string | null;
  schedulingUrl: string | null;
  config: Record<string, unknown>;
  lastError: string | null;
}

export interface Plan {
  id: string;
  key: string;
  name: string;
  description: string;
  priceMonthlyCents: number;
  currency: string;
  limits: PlanLimits;
  isActive: boolean;
  isPublic: boolean;
  sortOrder: number;
}
