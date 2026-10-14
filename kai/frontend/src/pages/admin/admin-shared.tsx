/*
 * Panel de administración: tipos de las respuestas de /api/admin, etiquetas en español
 * y piezas visuales compartidas por las páginas de /admin.
 */
import { Fragment, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronUp, CircleAlert, RefreshCw, X } from 'lucide-react';
import type { BusinessRole, ChannelKey, PlanLimits } from '@shared';
import { api, errorText } from '../../lib/api';
import { dateTime } from '../../lib/format';
import { Button, EmptyState } from '../../components/ui';
import { InstagramIcon, SourceIcon, WhatsAppIcon } from '../../components/lead-bits';
import type { Message, Plan } from '../../lib/types';

// ───────────── Tipos de la API ─────────────

export type BusinessStatus = 'active' | 'suspended';
export type SubscriptionStatus = 'trialing' | 'active' | 'past_due' | 'canceled';
export type ConnectionStatus = 'connected' | 'error' | 'disconnected';
export type ConnectionChannel = 'whatsapp' | 'instagram' | 'meta_lead_ads';
export type CalendarProvider = 'google' | 'calendly';
export type ActorType = 'user' | 'kai' | 'system' | 'integration' | 'admin';
export type JobStatus = 'pending' | 'running' | 'done' | 'failed' | 'cancelled';

/** GET /admin/overview */
export interface AdminOverviewData {
  businesses: { total: number; active: number; trialing: number; paying: number; onboarded: number };
  users: { total: number; active30: number };
  leads: { total: number; last30: number; clients: number };
  messages: { last30: number; kai: number };
  mrrCents: number;
  jobs: { pending: number; failed: number };
  errorsLast24h: number;
}

/** Fila de la tabla `businesses` (sin el secreto del webhook). */
export interface AdminBusiness {
  id: string;
  name: string;
  planId: string | null;
  status: BusinessStatus;
  subscriptionStatus: SubscriptionStatus;
  trialEndsAt: string | null;
  timezone: string;
  locale: string;
  currency: string;
  publicKey: string;
  onboardingStep: number;
  onboardingCompletedAt: string | null;
  monthlyAdSpendCents: number;
  createdAt: string;
  updatedAt: string;
}

/** GET /admin/businesses → businesses[] */
export interface AdminBusinessRow extends AdminBusiness {
  plan: { id: string; key: string; name: string } | null;
  owner: { businessId: string; name: string; email: string } | null;
  /** Uso del mes en curso por métrica (leads, ai_messages, copilot_queries). */
  usage: Record<string, number>;
  leads: number;
  lastActivityAt: string | null;
}

export interface UsageCounter {
  businessId: string;
  period: string; // "2026-10"
  metric: string;
  count: number;
}

export interface ErrorLog {
  id: string;
  businessId: string | null;
  level: 'error' | 'warn';
  source: string;
  message: string;
  stack: string | null;
  context: Record<string, unknown>;
  createdAt: string;
}

export interface AdminMember {
  userId: string;
  name: string;
  email: string;
  role: BusinessRole;
  isActive: boolean;
}

export interface AdminChannel {
  id: string;
  channel: ConnectionChannel;
  status: ConnectionStatus;
  displayName: string;
  lastError: string | null;
  lastEventAt: string | null;
}

export interface AdminCalendar {
  id: string;
  provider: CalendarProvider;
  status: ConnectionStatus;
  accountEmail: string | null;
  lastError: string | null;
}

export interface AdminConversationRow {
  id: string;
  channel: ChannelKey;
  preview: string | null;
  lastMessageAt: string | null;
  leadName: string;
  handoff: boolean;
}

/** GET /admin/businesses/:id */
export interface AdminBusinessDetailData {
  business: AdminBusiness;
  members: AdminMember[];
  channels: AdminChannel[];
  calendars: AdminCalendar[];
  usage: UsageCounter[];
  errors: ErrorLog[];
  conversations: AdminConversationRow[];
}

/** GET /admin/conversations/:id */
export interface AdminConversationData {
  conversation: {
    id: string;
    businessId: string;
    leadId: string;
    channel: ChannelKey;
    status: 'open' | 'closed';
    aiEnabled: boolean;
    handoffActive: boolean;
    handoffReason: string | null;
    summary: string;
    lastMessageAt: string | null;
    createdAt: string;
  };
  messages: Message[];
}

/** GET /admin/users → users[] */
export interface AdminUser {
  id: string;
  name: string;
  email: string;
  platformRole: 'admin' | 'user';
  isActive: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  businesses: { userId: string; businessId: string; businessName: string; role: BusinessRole }[];
}

/** GET /admin/plans → plans[] */
export interface AdminPlan extends Plan {
  createdAt: string;
  updatedAt: string;
}

/** GET /admin/errors → errors[] */
export interface AdminErrorRow {
  error: ErrorLog;
  businessName: string | null;
}

export interface AuditLog {
  id: string;
  businessId: string | null;
  actorType: ActorType;
  actorUserId: string | null;
  action: string;
  entityType: string | null;
  entityId: string | null;
  metadata: Record<string, unknown>;
  ip: string | null;
  createdAt: string;
}

/** GET /admin/audit → logs[] */
export interface AdminAuditRow {
  log: AuditLog;
  businessName: string | null;
  userEmail: string | null;
}

/** GET /admin/integrations */
export interface AdminIntegrationsData {
  channels: (AdminChannel & { businessName: string })[];
  calendars: (AdminCalendar & { businessName: string })[];
}

export interface AdminJob {
  id: string;
  businessId: string | null;
  type: string;
  runAt: string;
  payload: Record<string, unknown>;
  status: JobStatus;
  attempts: number;
  maxAttempts: number;
  dedupeKey: string | null;
  lastError: string | null;
  lockedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
}

/** GET /admin/jobs */
export interface AdminJobsData {
  stats: { type: string; status: JobStatus; n: number }[];
  failed: AdminJob[];
}

// ───────────── Claves de React Query ─────────────

export const ADMIN_KEYS = {
  overview: ['admin', 'overview'] as const,
  businesses: ['admin', 'businesses'] as const,
  business: (id: string) => ['admin', 'business', id] as const,
  businessAll: ['admin', 'business'] as const,
  conversation: (id: string) => ['admin', 'conversation', id] as const,
  users: ['admin', 'users'] as const,
  plans: ['admin', 'plans'] as const,
  errors: ['admin', 'errors'] as const,
  audit: ['admin', 'audit'] as const,
  integrations: ['admin', 'integrations'] as const,
  jobs: ['admin', 'jobs'] as const,
};

/** Máximo de negocios que pide el listado (el servidor admite hasta 200). */
export const BUSINESS_LIST_LIMIT = 200;

/** Consulta del listado de negocios; misma clave que la página Negocios para compartir caché. */
export const businessListQuery = (search: string) => ({
  queryKey: [...ADMIN_KEYS.businesses, search] as const,
  queryFn: () => api.get<{ businesses: AdminBusinessRow[] }>('/admin/businesses', { search, limit: BUSINESS_LIST_LIMIT }),
});

/** Nombre de cada negocio por id (para tablas cuya respuesta solo trae el id). */
export function useBusinessNames(): Map<string, string> {
  const q = useQuery({ ...businessListQuery(''), staleTime: 60_000 });
  return useMemo(() => new Map((q.data?.businesses ?? []).map((b) => [b.id, b.name])), [q.data]);
}

// ───────────── Etiquetas ─────────────

export const BUSINESS_STATUS: Record<BusinessStatus, { label: string; tone: string }> = {
  active: { label: 'Activo', tone: 'badge-success' },
  suspended: { label: 'Suspendido', tone: 'badge-danger' },
};

export const SUBSCRIPTION_STATUS: Record<SubscriptionStatus, { label: string; tone: string; hint: string }> = {
  trialing: { label: 'En prueba', tone: 'badge-info', hint: 'Está probando KAI y todavía no paga.' },
  active: { label: 'De pago', tone: 'badge-success', hint: 'Suscripción activa: cuenta para los ingresos mensuales (MRR).' },
  past_due: { label: 'Pago pendiente', tone: 'badge-warning', hint: 'Tiene un pago sin completar.' },
  canceled: { label: 'Cancelada', tone: 'badge-danger', hint: 'Ha cancelado su suscripción.' },
};

export const CONNECTION_STATUS: Record<ConnectionStatus, { label: string; tone: string }> = {
  connected: { label: 'Conectado', tone: 'badge-success' },
  error: { label: 'Con error', tone: 'badge-danger' },
  disconnected: { label: 'Desconectado', tone: '' },
};

export const CONNECTION_CHANNEL_LABELS: Record<ConnectionChannel, string> = {
  whatsapp: 'WhatsApp',
  instagram: 'Instagram',
  meta_lead_ads: 'Anuncios de Meta (Lead Ads)',
};

export const CALENDAR_PROVIDER_LABELS: Record<CalendarProvider, string> = {
  google: 'Google Calendar',
  calendly: 'Calendly',
};

export const ACTOR_LABELS: Record<ActorType, string> = {
  user: 'Usuario',
  kai: 'KAI',
  system: 'Sistema',
  integration: 'Integración',
  admin: 'Administrador',
};

export const JOB_STATUS_LABELS: Record<JobStatus, string> = {
  pending: 'Pendientes',
  running: 'En curso',
  done: 'Completados',
  failed: 'Fallidos',
  cancelled: 'Cancelados',
};

export const JOB_TYPE_LABELS: Record<string, string> = {
  kai_reply: 'Respuesta de KAI',
  followup: 'Seguimiento automático',
  appointment_confirmation: 'Confirmación de llamada',
  appointment_reminder: 'Recordatorio de llamada',
  post_call: 'Registro tras la llamada',
  no_show_message: 'Mensaje a no presentados',
  first_contact: 'Primer contacto',
  analytics_rollup: 'Cálculo de analítica',
  maintenance: 'Mantenimiento',
};
export const jobTypeLabel = (t: string) => JOB_TYPE_LABELS[t] ?? t;

/** Acciones del registro de auditoría con su descripción legible. */
export const AUDIT_ACTION_LABELS: Record<string, string> = {
  'admin.business_updated': 'Negocio modificado por el administrador',
  'admin.conversation_viewed': 'Conversación consultada por el administrador',
  'admin.user_updated': 'Usuario modificado por el administrador',
  'admin.plan_created': 'Plan creado',
  'admin.plan_updated': 'Plan modificado',
  'admin.job_retried': 'Trabajo reintentado',
  'auth.registered': 'Registro de cuenta',
  'auth.login': 'Inicio de sesión',
  'auth.password_changed': 'Contraseña cambiada',
  'auth.password_reset_requested': 'Solicitud de recuperación de contraseña',
  'auth.password_reset': 'Contraseña restablecida',
  'business.created': 'Negocio creado',
  'onboarding.completed': 'Configuración inicial completada',
  'lead.ingested': 'Lead recibido',
  'lead.updated': 'Lead modificado',
  'lead.status_changed': 'Cambio de etapa del lead',
  'lead.opted_out': 'El lead pidió no recibir más mensajes',
  'lead.deleted': 'Lead eliminado',
  'kai.reply_sent': 'Respuesta enviada por KAI',
  'conversation.handoff': 'Conversación pasada a una persona',
  'conversation.taken_over': 'Conversación tomada por el equipo',
  'conversation.released_to_kai': 'Conversación devuelta a KAI',
  'conversation.release': 'Conversación devuelta a KAI',
  'appointment.booked': 'Llamada agendada',
  'appointment.cancelled': 'Llamada cancelada',
  'appointment.outcome': 'Resultado de llamada registrado',
  'availability.updated': 'Disponibilidad modificada',
  'automation.updated': 'Automatización modificada',
  'integration.connected': 'Integración conectada',
  'integration.updated': 'Integración modificada',
  'integration.disconnected': 'Integración desconectada',
  'integration.webhook_secret_viewed': 'Secreto del webhook consultado',
  'integration.webhook_secret_rotated': 'Secreto del webhook regenerado',
  'calendar.connected': 'Calendario conectado',
  'calendar.disconnected': 'Calendario desconectado',
  'settings.business_updated': 'Datos del negocio modificados',
  'settings.trainer_updated': 'Perfil del entrenador modificado',
  'settings.ai_updated': 'Ajustes de KAI modificados',
  'settings.qualification_updated': 'Preguntas de cualificación modificadas',
  'settings.objections_updated': 'Objeciones modificadas',
  'settings.score_bands_updated': 'Rangos de puntuación modificados',
  'settings.service_created': 'Servicio creado',
  'settings.service_updated': 'Servicio modificado',
  'settings.service_deleted': 'Servicio eliminado',
  'settings.primary_service_updated': 'Servicio principal cambiado',
  'team.invited': 'Invitación al equipo enviada',
  'team.invitation_accepted': 'Invitación al equipo aceptada',
  'team.role_changed': 'Rol de un miembro cambiado',
  'team.member_removed': 'Miembro del equipo eliminado',
  'copilot.query': 'Consulta a KAI Copilot',
  // Acciones que el entrenador confirma desde KAI Copilot (copilot.<tipo>).
  'copilot.send_message': 'Mensaje enviado desde KAI Copilot',
  'copilot.change_lead_status': 'Etapa de un lead cambiada desde KAI Copilot',
  'copilot.delete_lead': 'Lead eliminado desde KAI Copilot',
  'copilot.update_tone': 'Tono de KAI cambiado desde KAI Copilot',
  'copilot.toggle_automation': 'Automatización activada o desactivada desde KAI Copilot',
  'copilot.toggle_kai_conversation': 'KAI activado o pausado en una conversación desde KAI Copilot',
  'copilot.toggle_autopilot': 'Respuestas automáticas de KAI activadas o pausadas desde KAI Copilot',
};
export const auditActionLabel = (a: string) => AUDIT_ACTION_LABELS[a] ?? a;

/** Tipo de elemento afectado en la auditoría. */
export const ENTITY_LABELS: Record<string, string> = {
  appointment: 'Llamada',
  business: 'Negocio',
  calendar_connection: 'Conexión de calendario',
  channel_connection: 'Conexión de canal',
  conversation: 'Conversación',
  invitation: 'Invitación al equipo',
  job: 'Trabajo programado',
  lead: 'Lead',
  pending_action: 'Acción de KAI Copilot',
  plan: 'Plan',
  service: 'Servicio',
  user: 'Usuario',
};
export const entityLabel = (t: string) => ENTITY_LABELS[t] ?? t;

/** Familias de acciones para filtrar la auditoría (el servidor filtra por prefijo). */
export const AUDIT_ACTION_GROUPS: { value: string; label: string }[] = [
  { value: '', label: 'Todas las acciones' },
  { value: 'admin.', label: 'Administración' },
  { value: 'auth.', label: 'Accesos y contraseñas' },
  { value: 'business.', label: 'Negocios' },
  { value: 'onboarding.', label: 'Configuración inicial' },
  { value: 'lead.', label: 'Leads' },
  { value: 'kai.', label: 'Respuestas de KAI' },
  { value: 'conversation.', label: 'Conversaciones' },
  { value: 'appointment.', label: 'Llamadas' },
  { value: 'availability.', label: 'Disponibilidad' },
  { value: 'automation.', label: 'Automatizaciones' },
  { value: 'integration.', label: 'Integraciones' },
  { value: 'calendar.', label: 'Calendarios' },
  { value: 'settings.', label: 'Ajustes' },
  { value: 'team.', label: 'Equipo' },
  { value: 'copilot.', label: 'KAI Copilot' },
];

/** Orígenes de error para filtrar (el servidor filtra por prefijo). */
export const ERROR_SOURCE_GROUPS: { value: string; label: string }[] = [
  { value: '', label: 'Todos los orígenes' },
  { value: 'ai', label: 'Inteligencia artificial (KAI y Copilot)' },
  { value: 'channel', label: 'Envío de mensajes (WhatsApp, Instagram)' },
  { value: 'webhook', label: 'Avisos entrantes (webhooks)' },
  { value: 'calendar', label: 'Calendarios (Google, Calendly)' },
  { value: 'email', label: 'Envío de emails' },
  { value: 'worker', label: 'Tareas programadas (cola de trabajos)' },
  { value: 'http', label: 'Servidor (peticiones a la API)' },
];

// ───────────── Utilidades ─────────────

export const num = (n: number | null | undefined) => (n ?? 0).toLocaleString('es-ES');

export function shortDate(value: string | Date | null | undefined): string {
  if (!value) return '—';
  return new Date(value).toLocaleDateString('es-ES', { day: 'numeric', month: 'short', year: 'numeric' });
}

/** “octubre de 2026” a partir de un periodo “2026-10”. */
export function periodLabel(period: string): string {
  const d = new Date(`${period}-01T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return period;
  const s = d.toLocaleDateString('es-ES', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Periodo de uso actual, igual que el servidor (mes en UTC, “AAAA-MM”). */
export const currentPeriod = () => new Date().toISOString().slice(0, 7);

/** “12 / 100”, “12 / ∞” o solo “12” si no se conoce el límite. */
export function usageText(used: number, limit: number | null | undefined) {
  if (limit === undefined) return num(used);
  return `${num(used)} / ${limit === null ? '∞' : num(limit)}`;
}

/** Resumen corto de los límites de un plan. */
export function limitsSummary(l: PlanLimits): string {
  const n = (v: number | null, unit: string) => (v === null ? `${unit} ilimitados` : `${num(v)} ${unit}`);
  return [n(l.maxLeadsPerMonth, 'leads/mes'), n(l.maxAiMessagesPerMonth, 'mensajes de KAI/mes'), n(l.maxTeamMembers, 'usuarios'), n(l.maxChannels, 'canales'), `Copilot ${l.copilot ? 'sí' : 'no'}`].join(' · ');
}

// ───────────── Piezas visuales ─────────────

export function BusinessStatusBadge({ status }: { status: BusinessStatus }) {
  const s = BUSINESS_STATUS[status] ?? { label: status, tone: '' };
  return <span className={`badge badge-dot ${s.tone}`}>{s.label}</span>;
}

export function SubscriptionBadge({ status }: { status: SubscriptionStatus }) {
  const s = SUBSCRIPTION_STATUS[status] ?? { label: status, tone: '', hint: '' };
  return (
    <span className={`badge ${s.tone}`} title={s.hint}>
      {s.label}
    </span>
  );
}

export function ConnectionBadge({ status }: { status: ConnectionStatus }) {
  const s = CONNECTION_STATUS[status] ?? { label: status, tone: '' };
  return <span className={`badge badge-dot ${s.tone}`}>{s.label}</span>;
}

export function ChannelIcon({ channel, size = 15 }: { channel: ConnectionChannel | ChannelKey; size?: number }) {
  if (channel === 'whatsapp') return <WhatsAppIcon size={size} />;
  if (channel === 'instagram') return <InstagramIcon size={size} />;
  if (channel === 'meta_lead_ads') return <SourceIcon source="meta_ads" size={size} />;
  return <SourceIcon source={channel} size={size} />;
}

/** Bloque de error de carga con botón de reintento. */
export function QueryError({ error, onRetry, retrying, title = 'No se han podido cargar los datos' }: { error: unknown; onRetry: () => void; retrying?: boolean; title?: string }) {
  return (
    <EmptyState
      icon={CircleAlert}
      title={title}
      description={errorText(error)}
      action={
        <Button icon={RefreshCw} loading={retrying} onClick={onRetry}>
          Reintentar
        </Button>
      }
    />
  );
}

/** Enlace a la ficha de un negocio (o “—” si no hay negocio asociado). */
export function BusinessLink({ id, name }: { id: string | null; name: string | null }) {
  if (!id) return <span className="subtle">—</span>;
  return (
    <Link to={`/admin/negocios/${id}`} className="adm-cell-link" onClick={(e) => e.stopPropagation()}>
      {name ?? 'Ver negocio'}
    </Link>
  );
}

/** Aviso de filtro activo por negocio, con botón para quitarlo. */
export function BusinessFilterChip({ id, name, onClear }: { id: string; name: string | undefined; onClear: () => void }) {
  return (
    <span className="badge badge-violet adm-filter-chip">
      <span className="ellipsis">
        Solo: <Link to={`/admin/negocios/${id}`}>{name ?? 'un negocio'}</Link>
      </span>
      <button type="button" onClick={onClear} aria-label="Quitar el filtro por negocio" title="Quitar el filtro por negocio">
        <X size={12} aria-hidden />
      </button>
    </span>
  );
}

/** Tabla de errores con detalle desplegable (pila y contexto técnico). */
export function ErrorTable({ rows, showBusiness }: { rows: { error: ErrorLog; businessName?: string | null }[]; showBusiness?: boolean }) {
  const [open, setOpen] = useState<string | null>(null);
  const cols = showBusiness ? 6 : 5;
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>Fecha</th>
            <th>Nivel</th>
            <th>Origen</th>
            {showBusiness && <th>Negocio</th>}
            <th>Mensaje</th>
            <th>
              <span className="sr-only">Detalle</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ error: e, businessName }) => {
            const isOpen = open === e.id;
            const hasContext = e.context && Object.keys(e.context).length > 0;
            return (
              <Fragment key={e.id}>
                <tr>
                  <td className="subtle" style={{ whiteSpace: 'nowrap' }}>
                    {dateTime(e.createdAt)}
                  </td>
                  <td>
                    <span className={`badge ${e.level === 'warn' ? 'badge-warning' : 'badge-danger'}`}>{e.level === 'warn' ? 'Aviso' : 'Error'}</span>
                  </td>
                  <td>
                    <span className="code-inline">{e.source}</span>
                  </td>
                  {showBusiness && (
                    <td>
                      <BusinessLink id={e.businessId} name={businessName ?? null} />
                    </td>
                  )}
                  <td className="adm-cell-message">{e.message}</td>
                  <td>
                    {(e.stack || hasContext) && (
                      <Button variant="ghost" size="sm" icon={isOpen ? ChevronUp : ChevronDown} aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : e.id)}>
                        {isOpen ? 'Ocultar' : 'Detalle'}
                      </Button>
                    )}
                  </td>
                </tr>
                {isOpen && (
                  <tr className="adm-detail-row">
                    <td colSpan={cols}>
                      <div className="col gap-12">
                        {hasContext && (
                          <div className="col gap-4">
                            <span className="section-title">Contexto</span>
                            <pre className="code adm-pre">{JSON.stringify(e.context, null, 2)}</pre>
                          </div>
                        )}
                        {e.stack && (
                          <div className="col gap-4">
                            <span className="section-title">Traza técnica (para el equipo de desarrollo)</span>
                            <pre className="code adm-pre">{e.stack}</pre>
                          </div>
                        )}
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
