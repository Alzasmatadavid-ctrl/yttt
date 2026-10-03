/* Registros técnicos de la plataforma: errores, auditoría, estado de integraciones y cola de trabajos. */
import { Fragment, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarDays, ChevronDown, ChevronUp, CircleCheck, History, ListTodo, Plug, RefreshCw, RotateCcw, ServerCrash } from 'lucide-react';
import { api, errorText } from '../../lib/api';
import { dateTime, timeAgo } from '../../lib/format';
import { Button, Callout, Card, ConfirmDialog, EmptyState, PageHeader, Select, Spinner, Stat, Tabs, useToast } from '../../components/ui';
import {
  ACTOR_LABELS,
  ADMIN_KEYS,
  AUDIT_ACTION_GROUPS,
  BusinessFilterChip,
  BusinessLink,
  CALENDAR_PROVIDER_LABELS,
  CONNECTION_CHANNEL_LABELS,
  ChannelIcon,
  ConnectionBadge,
  ERROR_SOURCE_GROUPS,
  ErrorTable,
  JOB_STATUS_LABELS,
  QueryError,
  auditActionLabel,
  entityLabel,
  jobTypeLabel,
  num,
  useBusinessNames,
  type ActorType,
  type AdminAuditRow,
  type AdminErrorRow,
  type AdminIntegrationsData,
  type AdminJob,
  type AdminJobsData,
  type JobStatus,
} from './admin-shared';
import '../../styles/admin.css';

type Tab = 'errores' | 'auditoria' | 'integraciones' | 'trabajos';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TABS: { value: Tab; label: string }[] = [
  { value: 'errores', label: 'Errores' },
  { value: 'auditoria', label: 'Auditoría' },
  { value: 'integraciones', label: 'Integraciones' },
  { value: 'trabajos', label: 'Cola de trabajos' },
];

function Loading() {
  return (
    <div className="page-loading" style={{ minHeight: 200 }}>
      <Spinner />
    </div>
  );
}

function RefreshButton({ onClick, loading }: { onClick: () => void; loading: boolean }) {
  return (
    <Button size="sm" variant="ghost" icon={RefreshCw} loading={loading} onClick={onClick}>
      Actualizar
    </Button>
  );
}

// ───────────── Errores ─────────────

/** Filtro opcional por negocio (parámetro «negocio» de la URL, p. ej. desde la ficha del negocio). */
interface BusinessScope {
  businessId: string;
  businessName: string | undefined;
  clear: () => void;
}

function ErrorsTab({ scope }: { scope: BusinessScope | null }) {
  const [source, setSource] = useState('');
  const businessId = scope?.businessId ?? '';
  const q = useQuery({
    queryKey: [...ADMIN_KEYS.errors, source, businessId],
    queryFn: () => api.get<{ errors: AdminErrorRow[] }>('/admin/errors', { source, businessId }),
    placeholderData: (prev) => prev,
    refetchInterval: 60_000,
  });
  const rows = q.data?.errors ?? [];
  return (
    <Card flush>
      <div className="adm-toolbar">
        <Select aria-label="Filtrar por origen del error" value={source} onChange={(e) => setSource(e.target.value)} options={ERROR_SOURCE_GROUPS} />
        {scope && <BusinessFilterChip id={scope.businessId} name={scope.businessName} onClear={scope.clear} />}
        <RefreshButton onClick={() => void q.refetch()} loading={q.isFetching && !q.isPending} />
        {!q.isPending && !q.isError && <span className="subtle small adm-toolbar-count">{rows.length >= 200 ? 'Últimos 200 registros' : `${num(rows.length)} registro${rows.length === 1 ? '' : 's'}`}</span>}
      </div>
      {q.isPending ? (
        <Loading />
      ) : q.isError ? (
        <QueryError error={q.error} onRetry={() => void q.refetch()} retrying={q.isFetching} />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={CircleCheck}
          title="Sin errores"
          description={source || scope ? 'No hay errores que coincidan con los filtros.' : 'No hay errores registrados. Todo funciona con normalidad.'}
        />
      ) : (
        <ErrorTable rows={rows} showBusiness={!scope} />
      )}
      <p className="subtle xs adm-note">
        Aquí se guardan los fallos técnicos de la plataforma, del más reciente al más antiguo. «Error» indica que una operación no se pudo completar; «Aviso», una incidencia menor. Pulsa «Detalle» para ver la información técnica.
      </p>
    </Card>
  );
}

// ───────────── Auditoría ─────────────

const ACTOR_OPTIONS = [{ value: '', label: 'Cualquier autor' }, ...(Object.keys(ACTOR_LABELS) as ActorType[]).map((k) => ({ value: k, label: ACTOR_LABELS[k] }))];
const ACTOR_TONE: Record<ActorType, string> = { user: 'badge-info', kai: 'badge-accent', system: '', integration: 'badge-warning', admin: 'badge-violet' };

function AuditTab({ scope }: { scope: BusinessScope | null }) {
  const [action, setAction] = useState('');
  const [actorType, setActorType] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const businessId = scope?.businessId ?? '';
  const q = useQuery({
    queryKey: [...ADMIN_KEYS.audit, action, actorType, businessId],
    queryFn: () => api.get<{ logs: AdminAuditRow[] }>('/admin/audit', { action, actorType, businessId }),
    placeholderData: (prev) => prev,
  });
  const rows = q.data?.logs ?? [];
  return (
    <Card flush>
      <div className="adm-toolbar">
        <Select aria-label="Filtrar por tipo de acción" value={action} onChange={(e) => setAction(e.target.value)} options={AUDIT_ACTION_GROUPS} />
        <Select aria-label="Filtrar por autor" value={actorType} onChange={(e) => setActorType(e.target.value)} options={ACTOR_OPTIONS} />
        {scope && <BusinessFilterChip id={scope.businessId} name={scope.businessName} onClear={scope.clear} />}
        <RefreshButton onClick={() => void q.refetch()} loading={q.isFetching && !q.isPending} />
        {!q.isPending && !q.isError && <span className="subtle small adm-toolbar-count">{rows.length >= 300 ? 'Últimos 300 registros' : `${num(rows.length)} registro${rows.length === 1 ? '' : 's'}`}</span>}
      </div>
      {q.isPending ? (
        <Loading />
      ) : q.isError ? (
        <QueryError error={q.error} onRetry={() => void q.refetch()} retrying={q.isFetching} />
      ) : rows.length === 0 ? (
        <EmptyState icon={History} title="Sin registros" description="No hay acciones que coincidan con los filtros." />
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Fecha</th>
                <th>Autor</th>
                <th>Acción</th>
                <th>Negocio</th>
                <th>
                  <span className="sr-only">Detalle</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ log, businessName, userEmail }) => {
                const isOpen = open === log.id;
                const hasMeta = log.metadata && Object.keys(log.metadata).length > 0;
                const hasDetail = hasMeta || !!log.entityType || !!log.ip;
                return (
                  <Fragment key={log.id}>
                    <tr>
                      <td className="subtle" style={{ whiteSpace: 'nowrap' }}>
                        {dateTime(log.createdAt)}
                      </td>
                      <td>
                        <span className={`badge ${ACTOR_TONE[log.actorType] ?? ''}`}>{ACTOR_LABELS[log.actorType] ?? log.actorType}</span>
                        {userEmail && <div className="subtle xs mt-4">{userEmail}</div>}
                      </td>
                      <td>
                        <div>{auditActionLabel(log.action)}</div>
                        <div className="subtle xs">{log.action}</div>
                      </td>
                      <td>
                        <BusinessLink id={log.businessId} name={businessName} />
                      </td>
                      <td>
                        {hasDetail && (
                          <Button variant="ghost" size="sm" icon={isOpen ? ChevronUp : ChevronDown} aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : log.id)}>
                            {isOpen ? 'Ocultar' : 'Detalle'}
                          </Button>
                        )}
                      </td>
                    </tr>
                    {isOpen && (
                      <tr className="adm-detail-row">
                        <td colSpan={5}>
                          <div className="col gap-12">
                            <dl className="kv adm-kv">
                              {log.entityType && (
                                <>
                                  <dt>Elemento afectado</dt>
                                  <dd>
                                    {entityLabel(log.entityType)}
                                    {log.entityType === 'business' && log.entityId ? (
                                      <Link to={`/admin/negocios/${log.entityId}`} className="small" style={{ marginLeft: 8 }}>
                                        Ver negocio
                                      </Link>
                                    ) : (
                                      log.entityId && <span className="code-inline adm-entity-id">{log.entityId}</span>
                                    )}
                                  </dd>
                                </>
                              )}
                              {log.ip && (
                                <>
                                  <dt>Dirección IP</dt>
                                  <dd>{log.ip}</dd>
                                </>
                              )}
                            </dl>
                            {hasMeta && (
                              <div className="col gap-4">
                                <span className="section-title">Datos del cambio</span>
                                <pre className="code adm-pre">{JSON.stringify(log.metadata, null, 2)}</pre>
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
      )}
      <p className="subtle xs adm-note">
        La auditoría registra quién hizo qué y cuándo: cambios de configuración, accesos, acciones de KAI y del administrador (incluidas las conversaciones que consultas desde este panel). No se puede modificar ni borrar desde aquí.
      </p>
    </Card>
  );
}

// ───────────── Integraciones ─────────────

function IntegrationsTab() {
  const q = useQuery({ queryKey: ADMIN_KEYS.integrations, queryFn: () => api.get<AdminIntegrationsData>('/admin/integrations') });
  if (q.isPending) return <Loading />;
  if (q.isError) {
    return (
      <div className="card">
        <QueryError error={q.error} onRetry={() => void q.refetch()} retrying={q.isFetching} />
      </div>
    );
  }
  const { channels, calendars } = q.data;
  const all = [...channels, ...calendars];
  const count = (s: string) => all.filter((c) => c.status === s).length;
  const withError = count('error');

  return (
    <div className="adm-stack">
      <div className="grid-3">
        <Stat label="Conectadas" icon={CircleCheck} value={num(count('connected'))} sub="Funcionando con normalidad" />
        <Stat label="Con error" icon={ServerCrash} value={num(withError)} sub="Necesitan revisión" />
        <Stat label="Desconectadas" icon={Plug} value={num(count('disconnected'))} sub="Desconectadas desde el propio negocio" />
      </div>
      {withError > 0 && (
        <Callout tone="warning">
          Hay {num(withError)} integración{withError === 1 ? '' : 'es'} con error. Suele resolverse cuando el entrenador vuelve a conectar la cuenta desde la sección Integraciones de su negocio; el mensaje de error te da la pista.
        </Callout>
      )}

      <Card
        title="Canales de mensajería y anuncios"
        icon={Plug}
        flush
        actions={<RefreshButton onClick={() => void q.refetch()} loading={q.isFetching} />}
      >
        {channels.length === 0 ? (
          <EmptyState icon={Plug} title="Sin canales conectados" description="Ningún negocio ha conectado todavía WhatsApp, Instagram o anuncios de Meta." />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Negocio</th>
                  <th>Canal</th>
                  <th>Cuenta</th>
                  <th>Estado</th>
                  <th>Último evento</th>
                  <th>Último error</th>
                </tr>
              </thead>
              <tbody>
                {channels.map((c) => (
                  <tr key={c.id}>
                    <td className="adm-cell-main">{c.businessName}</td>
                    <td>
                      <span className="row" style={{ gap: 6, whiteSpace: 'nowrap' }}>
                        <ChannelIcon channel={c.channel} size={14} />
                        {CONNECTION_CHANNEL_LABELS[c.channel] ?? c.channel}
                      </span>
                    </td>
                    <td className="muted">{c.displayName || '—'}</td>
                    <td>
                      <ConnectionBadge status={c.status} />
                    </td>
                    <td className="subtle" style={{ whiteSpace: 'nowrap' }}>
                      {c.lastEventAt ? timeAgo(c.lastEventAt) : 'Ninguno'}
                    </td>
                    <td className="xs adm-cell-message">{c.lastError ? <span className="adm-error-text">{c.lastError}</span> : <span className="subtle">—</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="subtle xs adm-note">«Último evento» es la última vez que llegó algo desde ese canal (un mensaje, un lead…).</p>
      </Card>

      <Card title="Calendarios" icon={CalendarDays} flush>
        {calendars.length === 0 ? (
          <EmptyState icon={CalendarDays} title="Sin calendarios conectados" description="Ningún negocio ha conectado todavía Google Calendar o Calendly." />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Negocio</th>
                  <th>Servicio</th>
                  <th>Cuenta</th>
                  <th>Estado</th>
                  <th>Último error</th>
                </tr>
              </thead>
              <tbody>
                {calendars.map((c) => (
                  <tr key={c.id}>
                    <td className="adm-cell-main">{c.businessName}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>{CALENDAR_PROVIDER_LABELS[c.provider] ?? c.provider}</td>
                    <td className="muted">{c.accountEmail ?? '—'}</td>
                    <td>
                      <ConnectionBadge status={c.status} />
                    </td>
                    <td className="xs adm-cell-message">{c.lastError ? <span className="adm-error-text">{c.lastError}</span> : <span className="subtle">—</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

// ───────────── Cola de trabajos ─────────────

const STATUS_ORDER: JobStatus[] = ['pending', 'running', 'done', 'failed', 'cancelled'];

function JobsTab() {
  const qc = useQueryClient();
  const toast = useToast();
  const businessNames = useBusinessNames();
  const [confirm, setConfirm] = useState<AdminJob | null>(null);
  const q = useQuery({ queryKey: ADMIN_KEYS.jobs, queryFn: () => api.get<AdminJobsData>('/admin/jobs'), refetchInterval: 30_000 });
  const retry = useMutation({
    mutationFn: (job: AdminJob) => api.post<{ ok: true }>(`/admin/jobs/${job.id}/retry`),
    onSuccess: () => {
      toast('Trabajo enviado de nuevo a la cola');
      setConfirm(null);
      void qc.invalidateQueries({ queryKey: ADMIN_KEYS.jobs });
      void qc.invalidateQueries({ queryKey: ADMIN_KEYS.overview });
      void qc.invalidateQueries({ queryKey: ADMIN_KEYS.audit });
    },
    onError: (e) => toast(errorText(e), 'error'),
  });

  if (q.isPending) return <Loading />;
  if (q.isError) {
    return (
      <div className="card">
        <QueryError error={q.error} onRetry={() => void q.refetch()} retrying={q.isFetching} />
      </div>
    );
  }

  const { stats, failed } = q.data;
  const totals = Object.fromEntries(STATUS_ORDER.map((s) => [s, stats.filter((r) => r.status === s).reduce((a, r) => a + r.n, 0)])) as Record<JobStatus, number>;
  const types = [...new Set(stats.map((r) => r.type))].sort((a, b) => jobTypeLabel(a).localeCompare(jobTypeLabel(b), 'es'));
  const cell = (type: string, status: JobStatus) => stats.find((r) => r.type === type && r.status === status)?.n ?? 0;

  return (
    <div className="adm-stack">
      <Callout tone="info" icon={ListTodo}>
        La <strong>cola de trabajos</strong> reúne las tareas que KAI deja programadas para hacer más tarde: responder a un lead, enviar recordatorios y seguimientos, calcular la analítica… Cada trabajo se intenta varias veces; si sigue fallando, se marca como fallido y aparece abajo para que puedas reintentarlo.
      </Callout>

      <div className="grid-5">
        {STATUS_ORDER.map((s) => (
          <Stat key={s} label={JOB_STATUS_LABELS[s]} value={num(totals[s])} />
        ))}
      </div>

      <Card title="Trabajos por tipo" icon={ListTodo} flush actions={<RefreshButton onClick={() => void q.refetch()} loading={q.isFetching} />}>
        {types.length === 0 ? (
          <EmptyState icon={ListTodo} title="La cola está vacía" description="Todavía no se ha programado ningún trabajo." />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Tipo</th>
                  {STATUS_ORDER.map((s) => (
                    <th key={s} className="num">
                      {JOB_STATUS_LABELS[s]}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {types.map((t) => (
                  <tr key={t}>
                    <td>
                      <div className="adm-cell-main">{jobTypeLabel(t)}</div>
                      <div className="subtle xs">{t}</div>
                    </td>
                    {STATUS_ORDER.map((s) => {
                      const n = cell(t, s);
                      return (
                        <td key={s} className="num" style={s === 'failed' && n > 0 ? { color: 'var(--danger)', fontWeight: 600 } : n === 0 ? { color: 'var(--text-3)' } : undefined}>
                          {num(n)}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title={`Trabajos fallidos${failed.length ? ` (${failed.length >= 50 ? 'últimos 50' : failed.length})` : ''}`} icon={ServerCrash} flush>
        {failed.length === 0 ? (
          <EmptyState icon={CircleCheck} title="Ningún trabajo fallido" description="Todas las tareas programadas se han ejecutado correctamente o siguen pendientes." />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Tipo</th>
                  <th>Negocio</th>
                  <th className="num">Intentos</th>
                  <th>Programado para</th>
                  <th>Falló</th>
                  <th>Error</th>
                  <th>
                    <span className="sr-only">Acciones</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {failed.map((j) => (
                  <tr key={j.id}>
                    <td>
                      <div className="adm-cell-main">{jobTypeLabel(j.type)}</div>
                      <div className="subtle xs">{j.type}</div>
                    </td>
                    <td>{j.businessId ? <BusinessLink id={j.businessId} name={businessNames.get(j.businessId) ?? 'Ver negocio'} /> : <span className="subtle">Toda la plataforma</span>}</td>
                    <td className="num">
                      {num(j.attempts)} / {num(j.maxAttempts)}
                    </td>
                    <td className="subtle" style={{ whiteSpace: 'nowrap' }}>
                      {dateTime(j.runAt)}
                    </td>
                    <td className="subtle" style={{ whiteSpace: 'nowrap' }}>
                      {j.finishedAt ? timeAgo(j.finishedAt) : '—'}
                    </td>
                    <td className="xs adm-cell-message">{j.lastError ? <span className="adm-error-text">{j.lastError}</span> : <span className="subtle">Sin detalle</span>}</td>
                    <td>
                      <div className="adm-actions">
                        <Button size="sm" icon={RotateCcw} onClick={() => setConfirm(j)} aria-label={`Reintentar el trabajo «${jobTypeLabel(j.type)}»`}>
                          Reintentar
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <ConfirmDialog
        open={!!confirm}
        title="¿Reintentar este trabajo?"
        message={
          confirm
            ? `«${jobTypeLabel(confirm.type)}» volverá a la cola con los mismos datos y se ejecutará en cuanto se procese la cola. Si era un mensaje para un lead, asegúrate de que todavía tiene sentido enviarlo (programado originalmente para ${dateTime(confirm.runAt)}).`
            : ''
        }
        confirmLabel="Reintentar"
        loading={retry.isPending}
        onConfirm={() => confirm && retry.mutate(confirm)}
        onClose={() => setConfirm(null)}
      />
    </div>
  );
}

// ───────────── Página ─────────────

export default function AdminLogs() {
  const [params, setParams] = useSearchParams();
  const businessNames = useBusinessNames();
  const raw = params.get('tab');
  const tab: Tab = TABS.some((t) => t.value === raw) ? (raw as Tab) : 'errores';
  const scopedId = params.get('negocio');
  const scope: BusinessScope | null =
    scopedId && UUID_RE.test(scopedId)
      ? {
          businessId: scopedId,
          businessName: businessNames.get(scopedId),
          clear: () => setParams({ tab }, { replace: true }),
        }
      : null;

  // Cambiar de pestaña conserva el filtro por negocio (solo lo usan Errores y Auditoría).
  const changeTab = (t: Tab) => setParams(scope ? { tab: t, negocio: scope.businessId } : { tab: t }, { replace: true });

  return (
    <div className="page">
      <PageHeader title="Registros" description="Lo que pasa por dentro de KAI: errores técnicos, historial de acciones, estado de las conexiones y tareas programadas." />
      <Tabs tabs={TABS} value={tab} onChange={changeTab} />
      <div className="mt-16">
        {tab === 'errores' && <ErrorsTab scope={scope} />}
        {tab === 'auditoria' && <AuditTab scope={scope} />}
        {tab === 'integraciones' && <IntegrationsTab />}
        {tab === 'trabajos' && <JobsTab />}
      </div>
    </div>
  );
}
