/**
 * Esquema de base de datos de KAI (PostgreSQL, vía Drizzle ORM).
 *
 * Regla multi-tenant: toda tabla con datos de un entrenador lleva `business_id`.
 * Ningún servicio consulta estas tablas sin filtrar por el negocio activo de la sesión.
 */
import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import type {
  AiTone,
  AppointmentOutcome,
  AppointmentStatus,
  AutomationConfig,
  AutomationType,
  AvailabilityWeek,
  BusinessRole,
  CalendarProviderKey,
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
} from '../lib/domain.js';

const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();
const ts = (name: string) => timestamp(name, { withTimezone: true });
const businessRef = () =>
  uuid('business_id')
    .notNull()
    .references(() => businesses.id, { onDelete: 'cascade' });

// ───────────────────────────── Usuarios y acceso ─────────────────────────────

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull(),
    name: text('name').notNull(),
    passwordHash: text('password_hash').notNull(),
    /** Rol de plataforma: `admin` = propietario del SaaS. */
    platformRole: text('platform_role').$type<'admin' | 'user'>().notNull().default('user'),
    isActive: boolean('is_active').notNull().default(true),
    lastLoginAt: ts('last_login_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('users_email_uq').on(t.email)],
);

export const sessions = pgTable(
  'sessions',
  {
    /** SHA-256 del token de sesión (el token en claro solo vive en la cookie). */
    id: text('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    activeBusinessId: uuid('active_business_id'),
    userAgent: text('user_agent'),
    ip: text('ip'),
    expiresAt: ts('expires_at').notNull(),
    lastSeenAt: ts('last_seen_at').notNull().defaultNow(),
    createdAt: createdAt(),
  },
  (t) => [index('sessions_user_idx').on(t.userId)],
);

export const passwordResetTokens = pgTable('password_reset_tokens', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull().unique(),
  expiresAt: ts('expires_at').notNull(),
  usedAt: ts('used_at'),
  createdAt: createdAt(),
});

// ───────────────────────────── Planes SaaS ─────────────────────────────

export const plans = pgTable('plans', {
  id: uuid('id').primaryKey().defaultRandom(),
  key: text('key').notNull().unique(),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  priceMonthlyCents: integer('price_monthly_cents').notNull().default(0),
  currency: text('currency').notNull().default('EUR'),
  /** Límites editables desde el panel de administración (nunca hardcodeados en la lógica). */
  limits: jsonb('limits').$type<PlanLimits>().notNull(),
  isActive: boolean('is_active').notNull().default(true),
  isPublic: boolean('is_public').notNull().default(true),
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

// ───────────────────────────── Negocios (tenants) ─────────────────────────────

export const businesses = pgTable('businesses', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  planId: uuid('plan_id').references(() => plans.id),
  status: text('status').$type<'active' | 'suspended'>().notNull().default('active'),
  subscriptionStatus: text('subscription_status')
    .$type<'trialing' | 'active' | 'past_due' | 'canceled'>()
    .notNull()
    .default('trialing'),
  trialEndsAt: ts('trial_ends_at'),
  timezone: text('timezone').notNull().default('Europe/Madrid'),
  locale: text('locale').notNull().default('es'),
  currency: text('currency').notNull().default('EUR'),
  /** Clave pública para formularios / webhooks de leads externos. */
  publicKey: text('public_key').notNull().unique(),
  /** Secreto (cifrado) para firmar o autenticar webhooks de leads externos. */
  webhookSecretEnc: text('webhook_secret_enc').notNull(),
  onboardingStep: integer('onboarding_step').notNull().default(1),
  onboardingCompletedAt: ts('onboarding_completed_at'),
  /** Inversión mensual en anuncios (para ROI estimado). Opcional. */
  monthlyAdSpendCents: integer('monthly_ad_spend_cents').notNull().default(0),
  /**
   * Negocio principal de la cuenta (desde el que se crean los negocios adicionales); null = este es el principal.
   * El límite de negocios del plan se cuenta por cuenta, no por persona del equipo.
   */
  accountBusinessId: uuid('account_business_id').references((): AnyPgColumn => businesses.id, { onDelete: 'set null' }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const memberships = pgTable(
  'memberships',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: businessRef(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role').$type<BusinessRole>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('memberships_business_user_uq').on(t.businessId, t.userId), index('memberships_user_idx').on(t.userId)],
);

export const invitations = pgTable('invitations', {
  id: uuid('id').primaryKey().defaultRandom(),
  businessId: businessRef(),
  email: text('email').notNull(),
  role: text('role').$type<BusinessRole>().notNull(),
  tokenHash: text('token_hash').notNull().unique(),
  invitedByUserId: uuid('invited_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  expiresAt: ts('expires_at').notNull(),
  acceptedAt: ts('accepted_at'),
  createdAt: createdAt(),
});

/** Perfil del entrenador: lo que KAI necesita saber para hablar en su nombre. */
export const trainers = pgTable('trainers', {
  id: uuid('id').primaryKey().defaultRandom(),
  businessId: businessRef().unique(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
  displayName: text('display_name').notNull().default(''),
  specialty: text('specialty').notNull().default(''),
  idealClient: text('ideal_client').notNull().default(''),
  transformation: text('transformation').notNull().default(''),
  methodName: text('method_name').notNull().default(''),
  methodDescription: text('method_description').notNull().default(''),
  modality: text('modality').$type<'online' | 'presencial' | 'hibrido'>().notNull().default('online'),
  /** Datos de autoridad reales (formación, años de experiencia…). KAI solo usa lo que está aquí. */
  credentials: text('credentials').notNull().default(''),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const services = pgTable(
  'services',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: businessRef(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    priceCents: integer('price_cents').notNull().default(0),
    currency: text('currency').notNull().default('EUR'),
    billingPeriod: text('billing_period')
      .$type<'one_time' | 'monthly' | 'quarterly' | 'semiannual' | 'annual'>()
      .notNull()
      .default('monthly'),
    durationWeeks: integer('duration_weeks'),
    includes: jsonb('includes').$type<string[]>().notNull().default([]),
    isPrimary: boolean('is_primary').notNull().default(false),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('services_business_idx').on(t.businessId)],
);

/** Configuración del setter: personalidad, tono, reglas de precio, CTA y escalado. */
export const aiSettings = pgTable('ai_settings', {
  id: uuid('id').primaryKey().defaultRandom(),
  businessId: businessRef().unique(),
  /** Interruptor global: si está apagado KAI no responde automáticamente a nadie. */
  autopilotEnabled: boolean('autopilot_enabled').notNull().default(true),
  assistantName: text('assistant_name').notNull().default('KAI'),
  /** Cómo se presenta: como el propio entrenador o como alguien de su equipo. */
  persona: text('persona').$type<'team_member' | 'trainer'>().notNull().default('team_member'),
  tone: jsonb('tone').$type<AiTone>().notNull(),
  wordsToUse: jsonb('words_to_use').$type<string[]>().notNull().default([]),
  wordsToAvoid: jsonb('words_to_avoid').$type<string[]>().notNull().default([]),
  examplesWhatsapp: text('examples_whatsapp').notNull().default(''),
  examplesInstagram: text('examples_instagram').notNull().default(''),
  examplesOther: text('examples_other').notNull().default(''),
  /** Instrucciones adicionales en lenguaje natural (opcional, nunca obligatorio). */
  extraInstructions: text('extra_instructions').notNull().default(''),
  pricePolicy: text('price_policy').$type<'contextualize_first' | 'share_directly'>().notNull().default('contextualize_first'),
  /**
   * Transparencia: cómo indica KAI que es un asistente automatizado.
   * `first_message` (recomendado; Reglamento europeo de IA, art. 50) o `on_request` (solo si se lo preguntan).
   * En cualquier caso, si el lead pregunta si habla con un bot, KAI nunca lo niega.
   */
  disclosureMode: text('disclosure_mode').$type<'first_message' | 'on_request'>().notNull().default('first_message'),
  callLabel: text('call_label').notNull().default('llamada de valoración'),
  callDurationMinutes: integer('call_duration_minutes').notNull().default(30),
  callDescription: text('call_description').notNull().default(''),
  /** Puntuación mínima para proponer la llamada. */
  proposeCallMinScore: integer('propose_call_min_score').notNull().default(60),
  scoreBands: jsonb('score_bands').$type<ScoreBand[]>().notNull(),
  handoffRules: jsonb('handoff_rules').$type<HandoffRules>().notNull(),
  /** Retardo “humano” antes de responder, en segundos. */
  replyDelayMinSeconds: integer('reply_delay_min_seconds').notNull().default(20),
  replyDelayMaxSeconds: integer('reply_delay_max_seconds').notNull().default(70),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/** Variables de cualificación configurables (objetivo, problema, motivación…). */
export const qualificationRules = pgTable(
  'qualification_rules',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: businessRef(),
    key: text('key').notNull(),
    label: text('label').notNull(),
    description: text('description').notNull().default(''),
    question: text('question').notNull().default(''),
    weight: integer('weight').notNull().default(10),
    required: boolean('required').notNull().default(false),
    enabled: boolean('enabled').notNull().default(true),
    sortOrder: integer('sort_order').notNull().default(0),
    /** Criterio de “no encaja” en lenguaje natural (ej. “menor de 18 años”). */
    disqualifyWhen: text('disqualify_when').notNull().default(''),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('qualification_rules_business_key_uq').on(t.businessId, t.key)],
);

/** Biblioteca editable de objeciones. */
export const objections = pgTable(
  'objections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: businessRef(),
    key: text('key').notNull(),
    label: text('label').notNull(),
    triggers: jsonb('triggers').$type<string[]>().notNull().default([]),
    strategy: text('strategy').notNull().default(''),
    exampleResponse: text('example_response').notNull().default(''),
    enabled: boolean('enabled').notNull().default(true),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('objections_business_key_uq').on(t.businessId, t.key)],
);

// ───────────────────────────── CRM ─────────────────────────────

export const leads = pgTable(
  'leads',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: businessRef(),
    name: text('name').notNull().default(''),
    phone: text('phone'),
    email: text('email'),
    instagramUsername: text('instagram_username'),
    instagramUserId: text('instagram_user_id'),
    whatsappId: text('whatsapp_id'),
    avatarUrl: text('avatar_url'),
    source: text('source').$type<LeadSource>().notNull(),
    sourceDetail: text('source_detail'),
    status: text('status').$type<LeadStatus>().notNull().default('new'),
    score: integer('score').notNull().default(0),
    temperature: text('temperature').$type<LeadTemperature>().notNull().default('frio'),
    qualification: jsonb('qualification').$type<LeadQualification>().notNull().default({}),
    signals: jsonb('signals').$type<LeadSignals>().notNull().default({}),
    goalSummary: text('goal_summary'),
    nextAction: text('next_action'),
    nextActionAt: ts('next_action_at'),
    assignedUserId: uuid('assigned_user_id').references(() => users.id, { onDelete: 'set null' }),
    tags: jsonb('tags').$type<string[]>().notNull().default([]),
    notes: text('notes').notNull().default(''),
    /** El lead pidió no recibir más mensajes: KAI nunca vuelve a escribirle. */
    optedOut: boolean('opted_out').notNull().default(false),
    isTest: boolean('is_test').notNull().default(false),
    lastInboundAt: ts('last_inbound_at'),
    lastOutboundAt: ts('last_outbound_at'),
    lastInteractionAt: ts('last_interaction_at'),
    firstResponseSeconds: integer('first_response_seconds'),
    qualifiedAt: ts('qualified_at'),
    wonAt: ts('won_at'),
    lostAt: ts('lost_at'),
    lostReason: text('lost_reason'),
    dealValueCents: integer('deal_value_cents'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('leads_business_status_idx').on(t.businessId, t.status),
    index('leads_business_score_idx').on(t.businessId, t.score),
    index('leads_business_interaction_idx').on(t.businessId, t.lastInteractionAt),
    index('leads_business_created_idx').on(t.businessId, t.createdAt),
    uniqueIndex('leads_business_whatsapp_uq').on(t.businessId, t.whatsappId).where(sql`${t.whatsappId} is not null`),
    uniqueIndex('leads_business_instagram_uq')
      .on(t.businessId, t.instagramUserId)
      .where(sql`${t.instagramUserId} is not null`),
  ],
);

/** Memoria a largo plazo de cada lead (“tiene una boda en septiembre”). */
export const leadMemories = pgTable(
  'lead_memories',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: businessRef(),
    leadId: uuid('lead_id')
      .notNull()
      .references(() => leads.id, { onDelete: 'cascade' }),
    kind: text('kind').$type<'fact' | 'event' | 'preference' | 'constraint' | 'personal'>().notNull().default('fact'),
    content: text('content').notNull(),
    importance: integer('importance').notNull().default(2),
    sourceMessageId: uuid('source_message_id'),
    createdAt: createdAt(),
  },
  (t) => [index('lead_memories_lead_idx').on(t.leadId)],
);

export const leadEvents = pgTable(
  'lead_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: businessRef(),
    leadId: uuid('lead_id')
      .notNull()
      .references(() => leads.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    actorType: text('actor_type').$type<'kai' | 'human' | 'system' | 'lead' | 'integration'>().notNull(),
    actorUserId: uuid('actor_user_id'),
    data: jsonb('data').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [
    index('lead_events_business_type_idx').on(t.businessId, t.type, t.createdAt),
    index('lead_events_lead_idx').on(t.leadId, t.createdAt),
  ],
);

export const conversations = pgTable(
  'conversations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: businessRef(),
    leadId: uuid('lead_id')
      .notNull()
      .references(() => leads.id, { onDelete: 'cascade' }),
    channel: text('channel').$type<ChannelKey>().notNull(),
    channelConnectionId: uuid('channel_connection_id'),
    status: text('status').$type<'open' | 'closed'>().notNull().default('open'),
    /** KAI activo en esta conversación concreta. */
    aiEnabled: boolean('ai_enabled').notNull().default(true),
    handoffActive: boolean('handoff_active').notNull().default(false),
    handoffReason: text('handoff_reason'),
    handoffAt: ts('handoff_at'),
    unreadCount: integer('unread_count').notNull().default(0),
    lastMessageAt: ts('last_message_at'),
    lastMessagePreview: text('last_message_preview'),
    lastInboundAt: ts('last_inbound_at'),
    summary: text('summary').notNull().default(''),
    state: jsonb('state').$type<ConversationState>().notNull().default({}),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('conversations_lead_channel_uq').on(t.businessId, t.leadId, t.channel),
    index('conversations_business_last_idx').on(t.businessId, t.lastMessageAt),
  ],
);

export const messages = pgTable(
  'messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: businessRef(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    leadId: uuid('lead_id')
      .notNull()
      .references(() => leads.id, { onDelete: 'cascade' }),
    direction: text('direction').$type<'inbound' | 'outbound'>().notNull(),
    senderType: text('sender_type').$type<'lead' | 'kai' | 'human' | 'system'>().notNull(),
    senderUserId: uuid('sender_user_id'),
    content: text('content').notNull(),
    contentType: text('content_type').$type<'text' | 'template' | 'media' | 'unsupported'>().notNull().default('text'),
    externalId: text('external_id'),
    status: text('status')
      .$type<'received' | 'queued' | 'sent' | 'delivered' | 'read' | 'failed' | 'skipped'>()
      .notNull()
      .default('sent'),
    error: text('error'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [
    index('messages_conversation_idx').on(t.conversationId, t.createdAt),
    index('messages_business_created_idx').on(t.businessId, t.createdAt),
    uniqueIndex('messages_business_external_uq').on(t.businessId, t.externalId).where(sql`${t.externalId} is not null`),
  ],
);

// ───────────────────────────── Agenda ─────────────────────────────

export const availabilitySettings = pgTable('availability_settings', {
  id: uuid('id').primaryKey().defaultRandom(),
  businessId: businessRef().unique(),
  weekly: jsonb('weekly').$type<AvailabilityWeek>().notNull(),
  slotMinutes: integer('slot_minutes').notNull().default(30),
  bufferMinutes: integer('buffer_minutes').notNull().default(10),
  minNoticeMinutes: integer('min_notice_minutes').notNull().default(120),
  maxDaysAhead: integer('max_days_ahead').notNull().default(14),
  blackoutDates: jsonb('blackout_dates').$type<string[]>().notNull().default([]),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const appointments = pgTable(
  'appointments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: businessRef(),
    leadId: uuid('lead_id')
      .notNull()
      .references(() => leads.id, { onDelete: 'cascade' }),
    conversationId: uuid('conversation_id'),
    title: text('title').notNull(),
    startsAt: ts('starts_at').notNull(),
    endsAt: ts('ends_at').notNull(),
    status: text('status').$type<AppointmentStatus>().notNull().default('scheduled'),
    outcome: text('outcome').$type<AppointmentOutcome>(),
    outcomeNotes: text('outcome_notes'),
    calendarProvider: text('calendar_provider').$type<CalendarProviderKey>().notNull().default('internal'),
    calendarConnectionId: uuid('calendar_connection_id'),
    externalEventId: text('external_event_id'),
    meetingUrl: text('meeting_url'),
    bookedBy: text('booked_by').$type<'kai' | 'human' | 'lead'>().notNull().default('kai'),
    confirmationSentAt: ts('confirmation_sent_at'),
    reminder24hSentAt: ts('reminder_24h_sent_at'),
    reminder1hSentAt: ts('reminder_1h_sent_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('appointments_business_starts_idx').on(t.businessId, t.startsAt),
    index('appointments_lead_idx').on(t.leadId),
    uniqueIndex('appointments_external_uq')
      .on(t.businessId, t.calendarProvider, t.externalEventId)
      .where(sql`${t.externalEventId} is not null`),
  ],
);

export const calendarConnections = pgTable(
  'calendar_connections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: businessRef(),
    provider: text('provider').$type<Exclude<CalendarProviderKey, 'internal'>>().notNull(),
    status: text('status').$type<'connected' | 'error' | 'disconnected'>().notNull().default('connected'),
    accountEmail: text('account_email'),
    /** Google: id del calendario. Calendly: URI del tipo de evento. */
    calendarId: text('calendar_id'),
    schedulingUrl: text('scheduling_url'),
    /** Credenciales cifradas (JSON con tokens). */
    credentialsEnc: text('credentials_enc').notNull(),
    tokenExpiresAt: ts('token_expires_at'),
    config: jsonb('config').$type<Record<string, unknown>>().notNull().default({}),
    lastSyncAt: ts('last_sync_at'),
    lastError: text('last_error'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('calendar_connections_business_provider_uq').on(t.businessId, t.provider)],
);

export const channelConnections = pgTable(
  'channel_connections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: businessRef(),
    channel: text('channel').$type<Exclude<ChannelKey, 'web'> | 'meta_lead_ads'>().notNull(),
    status: text('status').$type<'connected' | 'error' | 'disconnected'>().notNull().default('connected'),
    displayName: text('display_name').notNull().default(''),
    /** WhatsApp: phone_number_id · Instagram: IG user id · Lead Ads: page id. */
    externalAccountId: text('external_account_id').notNull(),
    credentialsEnc: text('credentials_enc').notNull(),
    config: jsonb('config').$type<ChannelConfig>().notNull().default({}),
    lastEventAt: ts('last_event_at'),
    lastError: text('last_error'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('channel_connections_external_uq').on(t.channel, t.externalAccountId)],
);

// ───────────────────────────── Automatizaciones ─────────────────────────────

export const automations = pgTable(
  'automations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: businessRef(),
    type: text('type').$type<AutomationType>().notNull(),
    name: text('name').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    config: jsonb('config').$type<AutomationConfig>().notNull().default({}),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('automations_business_type_uq').on(t.businessId, t.type)],
);

export const followUps = pgTable(
  'follow_ups',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: businessRef(),
    leadId: uuid('lead_id')
      .notNull()
      .references(() => leads.id, { onDelete: 'cascade' }),
    conversationId: uuid('conversation_id').notNull(),
    reason: text('reason').$type<'no_reply' | 'no_show' | 'reactivation' | 'manual'>().notNull(),
    step: integer('step').notNull(),
    scheduledFor: ts('scheduled_for').notNull(),
    status: text('status').$type<'scheduled' | 'sent' | 'cancelled' | 'skipped' | 'failed'>().notNull().default('scheduled'),
    jobId: uuid('job_id'),
    messageId: uuid('message_id'),
    note: text('note'),
    sentAt: ts('sent_at'),
    createdAt: createdAt(),
  },
  (t) => [index('follow_ups_lead_idx').on(t.leadId, t.status), index('follow_ups_business_idx').on(t.businessId, t.scheduledFor)],
);

/** Cola de trabajos programados (recordatorios, seguimientos, respuestas de KAI…). */
export const scheduledJobs = pgTable(
  'scheduled_jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id').references(() => businesses.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    runAt: ts('run_at').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
    status: text('status').$type<'pending' | 'running' | 'done' | 'failed' | 'cancelled'>().notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(3),
    dedupeKey: text('dedupe_key'),
    lastError: text('last_error'),
    lockedAt: ts('locked_at'),
    finishedAt: ts('finished_at'),
    createdAt: createdAt(),
  },
  (t) => [
    index('scheduled_jobs_due_idx').on(t.status, t.runAt),
    uniqueIndex('scheduled_jobs_dedupe_uq').on(t.dedupeKey).where(sql`${t.dedupeKey} is not null and ${t.status} = 'pending'`),
  ],
);

// ───────────────────────────── KAI Copilot ─────────────────────────────

export const copilotMessages = pgTable(
  'copilot_messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: businessRef(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role').$type<'user' | 'assistant'>().notNull(),
    content: text('content').notNull(),
    data: jsonb('data').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [index('copilot_messages_user_idx').on(t.businessId, t.userId, t.createdAt)],
);

/** Acciones sensibles propuestas por Copilot que esperan confirmación humana. */
export const pendingActions = pgTable(
  'pending_actions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: businessRef(),
    userId: uuid('user_id').notNull(),
    type: text('type').notNull(),
    summary: text('summary').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    status: text('status').$type<'pending' | 'confirmed' | 'cancelled' | 'expired' | 'failed'>().notNull().default('pending'),
    result: jsonb('result').$type<Record<string, unknown>>(),
    expiresAt: ts('expires_at').notNull(),
    resolvedAt: ts('resolved_at'),
    createdAt: createdAt(),
  },
  (t) => [index('pending_actions_business_idx').on(t.businessId, t.status)],
);

/** Avisos al entrenador: “KAI necesita tu intervención”, “registra el resultado”… */
export const alerts = pgTable(
  'alerts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: businessRef(),
    // contact_unverified: un formulario trae datos de contacto distintos de los de un lead que ya existe.
    type: text('type')
      .$type<
        | 'handoff'
        | 'call_outcome'
        | 'integration_error'
        | 'limit_reached'
        | 'delivery_blocked'
        | 'new_lead_manual'
        | 'no_availability'
        | 'client_message'
        | 'contact_unverified'
      >()
      .notNull(),
    severity: text('severity').$type<'info' | 'warning' | 'critical'>().notNull().default('warning'),
    title: text('title').notNull(),
    body: text('body').notNull().default(''),
    leadId: uuid('lead_id').references(() => leads.id, { onDelete: 'cascade' }),
    conversationId: uuid('conversation_id'),
    appointmentId: uuid('appointment_id'),
    status: text('status').$type<'open' | 'resolved' | 'dismissed'>().notNull().default('open'),
    resolvedAt: ts('resolved_at'),
    createdAt: createdAt(),
  },
  (t) => [index('alerts_business_status_idx').on(t.businessId, t.status)],
);

// ───────────────────────────── Métricas, uso y auditoría ─────────────────────────────

export const analyticsDaily = pgTable(
  'analytics_daily',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: businessRef(),
    day: date('day').notNull(),
    metrics: jsonb('metrics').$type<Record<string, number>>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('analytics_daily_business_day_uq').on(t.businessId, t.day)],
);

export const usageCounters = pgTable(
  'usage_counters',
  {
    businessId: businessRef(),
    period: text('period').notNull(),
    metric: text('metric').notNull(),
    count: integer('count').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.businessId, t.period, t.metric] })],
);

export const auditLogs = pgTable(
  'audit_logs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id'),
    actorType: text('actor_type').$type<'user' | 'kai' | 'system' | 'integration' | 'admin'>().notNull(),
    actorUserId: uuid('actor_user_id'),
    action: text('action').notNull(),
    entityType: text('entity_type'),
    entityId: text('entity_id'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    ip: text('ip'),
    createdAt: createdAt(),
  },
  (t) => [index('audit_logs_business_idx').on(t.businessId, t.createdAt), index('audit_logs_action_idx').on(t.action)],
);

export const errorLogs = pgTable(
  'error_logs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id'),
    level: text('level').$type<'error' | 'warn'>().notNull().default('error'),
    source: text('source').notNull(),
    message: text('message').notNull(),
    stack: text('stack'),
    context: jsonb('context').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [index('error_logs_created_idx').on(t.createdAt)],
);

/** Registro bruto de webhooks entrantes (idempotencia y depuración). */
export const webhookEvents = pgTable(
  'webhook_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    provider: text('provider').notNull(),
    externalId: text('external_id').notNull(),
    businessId: uuid('business_id'),
    payload: jsonb('payload').$type<unknown>().notNull(),
    status: text('status').$type<'received' | 'processed' | 'ignored' | 'failed'>().notNull().default('received'),
    error: text('error'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('webhook_events_provider_external_uq').on(t.provider, t.externalId)],
);
