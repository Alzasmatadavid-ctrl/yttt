/* Ficha de un negocio para el administrador: plan, suscripción, uso, equipo, integraciones, conversaciones y errores. */
import { Fragment, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  Ban,
  Building2,
  CalendarDays,
  CircleCheck,
  CreditCard,
  Eye,
  Gauge,
  MessagesSquare,
  Plug,
  Power,
  Save,
  ServerCrash,
  ShieldCheck,
  Sparkles,
  User,
  Users,
} from 'lucide-react';
import { CHANNEL_LABELS, HANDOFF_REASONS, ROLE_LABELS, type HandoffReason, type PlanLimits } from '@shared';
import { api, errorText } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { dateTime, dayLabel, isoDate, money, timeAgo, timeOnly } from '../../lib/format';
import { Button, Callout, Card, ConfirmDialog, EmptyState, Field, Input, Modal, PageHeader, PageLoading, Select, Spinner, useToast } from '../../components/ui';
import { Meter } from '../../components/charts';
import {
  ADMIN_KEYS,
  BusinessStatusBadge,
  CALENDAR_PROVIDER_LABELS,
  CONNECTION_CHANNEL_LABELS,
  ChannelIcon,
  ConnectionBadge,
  ErrorTable,
  QueryError,
  SUBSCRIPTION_STATUS,
  SubscriptionBadge,
  currentPeriod,
  limitsSummary,
  num,
  periodLabel,
  shortDate,
  type AdminBusiness,
  type AdminBusinessDetailData,
  type AdminCalendar,
  type AdminChannel,
  type AdminConversationData,
  type AdminConversationRow,
  type AdminMember,
  type AdminPlan,
  type SubscriptionStatus,
  type UsageCounter,
} from './admin-shared';
import type { Message } from '../../lib/types';
import '../../styles/admin.css';

type BusinessPatch = {
  status?: 'active' | 'suspended';
  planId?: string | null;
  subscriptionStatus?: SubscriptionStatus;
  trialEndsAt?: string | null;
};

/** Invalida todo lo que depende del negocio tras un cambio. */
function useBusinessMutation(businessId: string) {
  const qc = useQueryClient();
  const { me } = useAuth();
  const isOwn = me?.businesses.some((b) => b.businessId === businessId) ?? false;
  return useMutation({
    mutationFn: (body: BusinessPatch) => api.patch<{ ok: true }>(`/admin/businesses/${businessId}`, body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ADMIN_KEYS.business(businessId) });
      void qc.invalidateQueries({ queryKey: ADMIN_KEYS.businesses });
      void qc.invalidateQueries({ queryKey: ADMIN_KEYS.overview });
      void qc.invalidateQueries({ queryKey: ADMIN_KEYS.audit });
      if (isOwn) {
        // Si el administrador también es miembro de este negocio, su plan y límites cambian en la app.
        void qc.invalidateQueries({ queryKey: ['me'] });
        void qc.invalidateQueries({ queryKey: ['settings'] });
      }
    },
  });
}

// ───────────── Plan y suscripción ─────────────

const SUBSCRIPTION_OPTIONS = (Object.keys(SUBSCRIPTION_STATUS) as SubscriptionStatus[]).map((k) => ({ value: k, label: SUBSCRIPTION_STATUS[k].label }));

function SubscriptionCard({ business, plans, plansLoading }: { business: AdminBusiness; plans: AdminPlan[]; plansLoading: boolean }) {
  const toast = useToast();
  const save = useBusinessMutation(business.id);
  const initialTrial = business.trialEndsAt ? isoDate(new Date(business.trialEndsAt)) : '';
  const [planId, setPlanId] = useState(business.planId ?? '');
  const [subscription, setSubscription] = useState<SubscriptionStatus>(business.subscriptionStatus);
  const [trialEnd, setTrialEnd] = useState(initialTrial);

  const planChanged = planId !== (business.planId ?? '');
  const dirty = planChanged || subscription !== business.subscriptionStatus || trialEnd !== initialTrial;
  const selected = plans.find((p) => p.id === planId);
  const planMissing = !!business.planId && !plansLoading && !plans.some((p) => p.id === business.planId);

  const options = [
    { value: '', label: 'Sin plan (límites básicos)' },
    ...plans.map((p) => ({ value: p.id, label: `${p.name} · ${p.priceMonthlyCents > 0 ? `${money(p.priceMonthlyCents, p.currency)}/mes` : 'gratis'}${p.isActive ? '' : ' (inactivo)'}` })),
    ...(planMissing ? [{ value: business.planId!, label: 'Plan actual (no encontrado)' }] : []),
  ];

  const submit = () => {
    const body: BusinessPatch = {};
    if (planChanged) body.planId = planId || null;
    if (subscription !== business.subscriptionStatus) body.subscriptionStatus = subscription;
    // La prueba termina al final del día elegido (hora local del administrador).
    if (trialEnd !== initialTrial) body.trialEndsAt = trialEnd ? new Date(`${trialEnd}T23:59:59`).toISOString() : null;
    save.mutate(body, {
      onSuccess: () => toast('Cambios guardados'),
      onError: (e) => toast(errorText(e), 'error'),
    });
  };

  const reset = () => {
    setPlanId(business.planId ?? '');
    setSubscription(business.subscriptionStatus);
    setTrialEnd(initialTrial);
  };

  return (
    <Card title="Plan y suscripción" icon={CreditCard}>
      <div className="col gap-16">
        <Field
          label="Plan"
          htmlFor="biz-plan"
          hint={selected ? limitsSummary(selected.limits) : planId ? undefined : 'Sin plan se aplican unos límites básicos y conservadores.'}
        >
          <Select id="biz-plan" value={planId} onChange={(e) => setPlanId(e.target.value)} options={options} disabled={plansLoading} />
        </Field>
        {planChanged && <Callout tone="info">El nuevo plan se aplica en cuanto guardes: sus límites cuentan desde ese momento para este negocio.</Callout>}
        <div className="grid-2">
          <Field label="Estado de la suscripción" htmlFor="biz-subscription" hint={SUBSCRIPTION_STATUS[subscription]?.hint}>
            <Select id="biz-subscription" value={subscription} onChange={(e) => setSubscription(e.target.value as SubscriptionStatus)} options={SUBSCRIPTION_OPTIONS} />
          </Field>
          <Field label="Fin del periodo de prueba" htmlFor="biz-trial" hint={trialEnd ? 'La prueba termina al final de ese día.' : 'Sin fecha de fin.'}>
            <div className="row">
              <Input id="biz-trial" type="date" value={trialEnd} onChange={(e) => setTrialEnd(e.target.value)} />
              {trialEnd && (
                <Button size="sm" variant="ghost" onClick={() => setTrialEnd('')}>
                  Quitar
                </Button>
              )}
            </div>
          </Field>
        </div>
        <p className="subtle xs">
          El estado de la suscripción y la fecha de fin de prueba son informativos: KAI todavía no cobra online y no bloquea nada automáticamente cuando termina una prueba. Si necesitas cortar el acceso, suspende el negocio.
        </p>
        <div className="row wrap" style={{ justifyContent: 'flex-end' }}>
          {dirty && (
            <Button variant="ghost" onClick={reset} disabled={save.isPending}>
              Descartar cambios
            </Button>
          )}
          <Button variant="primary" icon={Save} loading={save.isPending} disabled={!dirty} onClick={submit}>
            Guardar cambios
          </Button>
        </div>
      </div>
    </Card>
  );
}

// ───────────── Ficha ─────────────

function InfoCard({ business, owner }: { business: AdminBusiness; owner: AdminMember | undefined }) {
  return (
    <Card title="Ficha del negocio" icon={Building2}>
      <dl className="kv adm-kv">
        <dt>Propietario</dt>
        <dd>
          {owner ? (
            <>
              {owner.name}
              <div className="subtle xs">{owner.email}</div>
            </>
          ) : (
            <span className="subtle">Sin propietario</span>
          )}
        </dd>
        <dt>Alta en KAI</dt>
        <dd>{shortDate(business.createdAt)}</dd>
        <dt>Configuración inicial</dt>
        <dd>{business.onboardingCompletedAt ? `Completada el ${shortDate(business.onboardingCompletedAt)}` : `En curso (paso ${business.onboardingStep})`}</dd>
        <dt>Zona horaria</dt>
        <dd>{business.timezone}</dd>
        <dt>Moneda</dt>
        <dd>{business.currency}</dd>
        <dt>Inversión en anuncios</dt>
        <dd>{business.monthlyAdSpendCents > 0 ? `${money(business.monthlyAdSpendCents, business.currency)} al mes` : <span className="subtle">No indicada</span>}</dd>
        <dt>Última modificación</dt>
        <dd>{dateTime(business.updatedAt)}</dd>
        <dt>Identificador</dt>
        <dd>
          <span className="code-inline">{business.id}</span>
        </dd>
      </dl>
    </Card>
  );
}

// ───────────── Uso ─────────────

function UsageCard({ usage, limits, planState }: { usage: UsageCounter[]; limits: PlanLimits | undefined; planState: 'ok' | 'none' | 'loading' | 'missing' }) {
  const period = currentPeriod();
  const byPeriod = useMemo(() => {
    const map = new Map<string, Record<string, number>>();
    for (const u of usage) {
      const row = map.get(u.period) ?? {};
      row[u.metric] = u.count;
      map.set(u.period, row);
    }
    return [...map.entries()].sort((a, b) => b[0].localeCompare(a[0]));
  }, [usage]);
  const now = byPeriod.find(([p]) => p === period)?.[1] ?? {};
  const leads = now.leads ?? 0;
  const ai = now.ai_messages ?? 0;
  const copilot = now.copilot_queries ?? 0;

  return (
    <Card title={`Uso de ${periodLabel(period).toLowerCase()}`} icon={Gauge}>
      {limits ? (
        <div className="col gap-16">
          <Meter label="Leads nuevos" value={leads} max={limits.maxLeadsPerMonth} />
          <Meter label="Mensajes de KAI" value={ai} max={limits.maxAiMessagesPerMonth} />
          <p className="subtle xs">
            Consultas a KAI Copilot este mes: {num(copilot)}. Copilot comparte el límite de mensajes: deja de responder cuando la suma de mensajes de KAI y consultas lo alcanza. Los contadores se reinician el día 1 de cada mes. ∞ = sin límite.
          </p>
        </div>
      ) : (
        <div className="col gap-12">
          <dl className="kv adm-kv">
            <dt>Leads nuevos</dt>
            <dd className="tnum">{num(leads)}</dd>
            <dt>Mensajes de KAI</dt>
            <dd className="tnum">{num(ai)}</dd>
            <dt>Consultas a Copilot</dt>
            <dd className="tnum">{num(copilot)}</dd>
          </dl>
          <p className="subtle xs">
            {planState === 'loading'
              ? 'Cargando los límites del plan…'
              : planState === 'missing'
                ? 'No se encuentra el plan asignado a este negocio. Revisa la sección Planes.'
                : 'Este negocio no tiene plan asignado, así que se le aplican unos límites básicos.'}
          </p>
        </div>
      )}

      {byPeriod.length > 0 && (
        <>
          <div className="divider" />
          <h3 className="section-title" style={{ marginBottom: 6 }}>
            Histórico mensual
          </h3>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Mes</th>
                  <th className="num">Leads</th>
                  <th className="num">Mensajes de KAI</th>
                  <th className="num">Copilot</th>
                </tr>
              </thead>
              <tbody>
                {byPeriod.slice(0, 12).map(([p, m]) => (
                  <tr key={p}>
                    <td>{periodLabel(p)}</td>
                    <td className="num">{num(m.leads)}</td>
                    <td className="num">{num(m.ai_messages)}</td>
                    <td className="num">{num(m.copilot_queries)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Card>
  );
}

// ───────────── Equipo ─────────────

function TeamCard({ members }: { members: AdminMember[] }) {
  return (
    <Card title={`Equipo (${members.length})`} icon={Users}>
      {members.length === 0 ? (
        <p className="muted small">Este negocio no tiene miembros.</p>
      ) : (
        <ul className="adm-list">
          {members.map((m) => (
            <li key={m.userId}>
              <span className="adm-list-icon">
                <User aria-hidden />
              </span>
              <div className="grow">
                <div className="row wrap" style={{ gap: 6 }}>
                  <strong>{m.name}</strong>
                  <span className="badge">{ROLE_LABELS[m.role] ?? m.role}</span>
                  {!m.isActive && <span className="badge badge-danger">Desactivado</span>}
                </div>
                <div className="subtle xs ellipsis">{m.email}</div>
              </div>
              <Link to={`/admin/usuarios?q=${encodeURIComponent(m.email)}`} className="small" aria-label={`Ver a ${m.name} en Usuarios`}>
                Ver usuario
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

// ───────────── Integraciones ─────────────

function ConnectionsCard({ channels, calendars }: { channels: AdminChannel[]; calendars: AdminCalendar[] }) {
  const empty = channels.length === 0 && calendars.length === 0;
  return (
    <Card title="Canales y calendarios" icon={Plug}>
      {empty ? (
        <p className="muted small">Este negocio todavía no ha conectado WhatsApp, Instagram, anuncios ni calendarios.</p>
      ) : (
        <ul className="adm-list">
          {channels.map((c) => (
            <li key={c.id}>
              <span className="adm-list-icon">
                <ChannelIcon channel={c.channel} />
              </span>
              <div className="grow">
                <div className="row wrap" style={{ gap: 6 }}>
                  <strong>{CONNECTION_CHANNEL_LABELS[c.channel] ?? c.channel}</strong>
                  <ConnectionBadge status={c.status} />
                </div>
                <div className="subtle xs">
                  {c.displayName || 'Sin nombre'} · Último evento: {c.lastEventAt ? timeAgo(c.lastEventAt) : 'ninguno'}
                </div>
                {c.lastError && <div className="xs adm-error-text mt-4">{c.lastError}</div>}
              </div>
            </li>
          ))}
          {calendars.map((c) => (
            <li key={c.id}>
              <span className="adm-list-icon">
                <CalendarDays aria-hidden />
              </span>
              <div className="grow">
                <div className="row wrap" style={{ gap: 6 }}>
                  <strong>{CALENDAR_PROVIDER_LABELS[c.provider] ?? c.provider}</strong>
                  <ConnectionBadge status={c.status} />
                </div>
                <div className="subtle xs">{c.accountEmail ?? 'Sin cuenta asociada'}</div>
                {c.lastError && <div className="xs adm-error-text mt-4">{c.lastError}</div>}
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

// ───────────── Conversaciones ─────────────

const SENDER_LABELS: Record<Message['senderType'], string> = { lead: '', kai: 'KAI', human: 'Equipo del negocio', system: 'Sistema' };

function ReadOnlyThread({ messages, leadName }: { messages: Message[]; leadName: string }) {
  let lastDay = '';
  return (
    <div className="thread-messages adm-thread" role="region" tabIndex={0} aria-label={`Mensajes con ${leadName}`}>
      {messages.map((m) => {
        const day = new Date(m.createdAt).toDateString();
        const showDay = day !== lastDay;
        lastDay = day;
        const failed = m.status === 'failed' || m.status === 'skipped';
        const who = m.senderType === 'lead' ? leadName : SENDER_LABELS[m.senderType];
        return (
          <Fragment key={m.id}>
            {showDay && <div className="day-sep">{dayLabel(m.createdAt)}</div>}
            <div className={`msg-row ${m.direction === 'inbound' ? 'in' : 'out'} ${m.senderType === 'kai' ? 'kai' : ''} ${failed ? 'failed' : ''}`}>
              <div className="bubble">{m.content}</div>
              <div className="msg-meta">
                {m.senderType === 'kai' ? <Sparkles aria-hidden /> : m.direction === 'outbound' ? <User aria-hidden /> : null}
                {who && <span>{who}</span>}
                <span>{timeOnly(m.createdAt)}</span>
                {failed && (
                  <span style={{ color: 'var(--danger)' }}>
                    · {m.status === 'skipped' ? 'no enviado' : 'error al enviar'}
                    {m.error ? `: ${m.error}` : ''}
                  </span>
                )}
              </div>
            </div>
          </Fragment>
        );
      })}
    </div>
  );
}

function ConversationModal({ row, onClose }: { row: AdminConversationRow | null; onClose: () => void }) {
  const qc = useQueryClient();
  const id = row?.id ?? '';
  const q = useQuery({
    queryKey: ADMIN_KEYS.conversation(id),
    queryFn: async () => {
      const data = await api.get<AdminConversationData>(`/admin/conversations/${id}`);
      // Cada consulta queda registrada en la auditoría: refrescamos ese listado.
      void qc.invalidateQueries({ queryKey: ADMIN_KEYS.audit });
      return data;
    },
    enabled: !!row,
    // Evita volver a pedirla (y a registrar otro acceso) cada vez que la ventana recupera el foco.
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });
  const conv = q.data?.conversation;
  const reason = conv?.handoffReason as HandoffReason | null | undefined;

  return (
    <Modal open={!!row} onClose={onClose} wide title={row ? `Conversación con ${row.leadName}` : 'Conversación'}>
      <Callout tone="info" icon={ShieldCheck}>
        Estás viendo datos privados de un cliente de KAI. Este acceso queda registrado en la auditoría con tu usuario, la fecha y la hora. Consulta conversaciones solo cuando sea necesario para dar soporte.
      </Callout>
      {q.isPending ? (
        <div className="page-loading" style={{ minHeight: 200 }}>
          <Spinner />
        </div>
      ) : q.isError ? (
        <QueryError error={q.error} onRetry={() => void q.refetch()} retrying={q.isFetching} title="No se ha podido abrir la conversación" />
      ) : (
        <>
          <div className="row wrap mt-12" style={{ gap: 6 }}>
            <span className="badge">
              <ChannelIcon channel={q.data.conversation.channel} size={12} />
              {CHANNEL_LABELS[q.data.conversation.channel] ?? q.data.conversation.channel}
            </span>
            <span className="badge">{q.data.conversation.status === 'open' ? 'Abierta' : 'Cerrada'}</span>
            <span className={`badge ${q.data.conversation.aiEnabled ? 'badge-accent' : ''}`}>{q.data.conversation.aiEnabled ? 'KAI activo en esta conversación' : 'KAI desactivado en esta conversación'}</span>
            <span className="subtle xs">{num(q.data.messages.length)} mensajes</span>
          </div>
          {conv?.handoffActive && (
            <div className="mt-12">
              <Callout tone="warning">KAI pasó esta conversación a una persona{reason && HANDOFF_REASONS[reason] ? `: ${HANDOFF_REASONS[reason].toLowerCase()}` : ''}.</Callout>
            </div>
          )}
          {conv?.summary && (
            <div className="mt-12">
              <div className="section-title">Resumen de KAI</div>
              <p className="muted small mt-4">{conv.summary}</p>
            </div>
          )}
          {q.data.messages.length === 0 ? (
            <p className="muted small mt-12">Esta conversación todavía no tiene mensajes.</p>
          ) : (
            <ReadOnlyThread messages={q.data.messages} leadName={row?.leadName ?? 'Lead'} />
          )}
          {q.data.messages.length >= 500 && <p className="subtle xs mt-8">Se muestran los primeros 500 mensajes.</p>}
        </>
      )}
    </Modal>
  );
}

function ConversationsCard({ conversations, onOpen }: { conversations: AdminConversationRow[]; onOpen: (c: AdminConversationRow) => void }) {
  return (
    <Card title="Conversaciones recientes" icon={MessagesSquare} flush>
      <div style={{ padding: '0 18px 14px' }}>
        <p className="subtle xs">Solo para dar soporte. Abrir una conversación queda registrado en la auditoría (quién la abrió y cuándo).</p>
      </div>
      {conversations.length === 0 ? (
        <EmptyState icon={MessagesSquare} title="Sin conversaciones" description="Este negocio todavía no ha tenido conversaciones con leads." />
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Lead</th>
                <th>Canal</th>
                <th>Último mensaje</th>
                <th>Fecha</th>
                <th>Estado</th>
                <th>
                  <span className="sr-only">Acciones</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {conversations.map((c) => (
                <tr key={c.id}>
                  <td className="adm-cell-main">{c.leadName || 'Sin nombre'}</td>
                  <td>
                    <span className="row" style={{ gap: 6 }}>
                      <ChannelIcon channel={c.channel} size={14} />
                      {CHANNEL_LABELS[c.channel] ?? c.channel}
                    </span>
                  </td>
                  <td className="muted ellipsis adm-cell-preview">{c.preview ?? '—'}</td>
                  <td className="subtle" style={{ whiteSpace: 'nowrap' }}>
                    {timeAgo(c.lastMessageAt)}
                  </td>
                  <td>{c.handoff ? <span className="badge badge-warning">Con una persona</span> : <span className="badge badge-accent">Con KAI</span>}</td>
                  <td>
                    <div className="adm-actions">
                      <Button size="sm" icon={Eye} onClick={() => onOpen(c)} aria-label={`Ver la conversación con ${c.leadName || 'este lead'}`}>
                        Ver
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
  );
}

// ───────────── Página ─────────────

export default function AdminBusinessDetail() {
  const { id = '' } = useParams<{ id: string }>();
  const toast = useToast();
  const { me } = useAuth();
  const [confirmStatus, setConfirmStatus] = useState(false);
  const [openConv, setOpenConv] = useState<AdminConversationRow | null>(null);

  const q = useQuery({ queryKey: ADMIN_KEYS.business(id), queryFn: () => api.get<AdminBusinessDetailData>(`/admin/businesses/${id}`), enabled: !!id });
  const plans = useQuery({ queryKey: ADMIN_KEYS.plans, queryFn: () => api.get<{ plans: AdminPlan[] }>('/admin/plans') });
  const setStatus = useBusinessMutation(id);

  if (q.isPending) return <PageLoading />;
  if (q.isError) {
    return (
      <div className="page">
        <PageHeader
          title="Negocio"
          actions={
            <Link to="/admin/negocios" className="btn">
              <ArrowLeft aria-hidden />
              Volver a negocios
            </Link>
          }
        />
        <div className="card">
          <QueryError error={q.error} onRetry={() => void q.refetch()} retrying={q.isFetching} title="No se ha podido cargar este negocio" />
        </div>
      </div>
    );
  }

  const { business, members, channels, calendars, usage, errors, conversations } = q.data;
  const owner = members.find((m) => m.role === 'trainer');
  const planList = plans.data?.plans ?? [];
  const plan = business.planId ? planList.find((p) => p.id === business.planId) : undefined;
  const suspended = business.status === 'suspended';
  const isOwn = me?.businesses.some((b) => b.businessId === business.id) ?? false;

  const toggleStatus = () =>
    setStatus.mutate(
      { status: suspended ? 'active' : 'suspended' },
      {
        onSuccess: () => {
          toast(suspended ? 'Negocio reactivado' : 'Negocio suspendido');
          setConfirmStatus(false);
        },
        onError: (e) => toast(errorText(e), 'error'),
      },
    );

  return (
    <div className="page">
      <Link to="/admin/negocios" className="small adm-back">
        <ArrowLeft size={14} aria-hidden />
        Volver a negocios
      </Link>
      <PageHeader
        title={business.name}
        description={
          <span className="row wrap" style={{ gap: 6 }}>
            <BusinessStatusBadge status={business.status} />
            <SubscriptionBadge status={business.subscriptionStatus} />
            <span className="badge">{plan?.name ?? (business.planId ? 'Plan' : 'Sin plan')}</span>
            {!business.onboardingCompletedAt && <span className="badge badge-warning">Configuración inicial pendiente</span>}
          </span>
        }
        actions={
          suspended ? (
            <Button variant="primary" icon={Power} onClick={() => setConfirmStatus(true)}>
              Reactivar negocio
            </Button>
          ) : (
            <Button variant="danger" icon={Ban} onClick={() => setConfirmStatus(true)}>
              Suspender negocio
            </Button>
          )
        }
      />

      <div className="adm-stack">
        {suspended && (
          <Callout tone="danger">
            <strong>Negocio suspendido.</strong> Su equipo no puede entrar en la aplicación y KAI no responde a sus leads. Sus datos se conservan intactos.
          </Callout>
        )}
        <div className="grid-2" style={{ alignItems: 'start' }}>
          <SubscriptionCard key={`${business.id}-${business.updatedAt}`} business={business} plans={planList} plansLoading={plans.isPending} />
          <InfoCard business={business} owner={owner} />
        </div>

        <div className="grid-2" style={{ alignItems: 'start' }}>
          <UsageCard usage={usage} limits={plan?.limits} planState={plan ? 'ok' : !business.planId ? 'none' : plans.isPending ? 'loading' : 'missing'} />
          <div className="adm-stack">
            <TeamCard members={members} />
            <ConnectionsCard channels={channels} calendars={calendars} />
          </div>
        </div>

        <ConversationsCard conversations={conversations} onOpen={setOpenConv} />

        <Card title="Errores recientes" icon={ServerCrash} flush>
          {errors.length === 0 ? (
            <EmptyState icon={CircleCheck} title="Sin errores" description="No hay errores registrados para este negocio." />
          ) : (
            <ErrorTable rows={errors.map((e) => ({ error: e }))} />
          )}
        </Card>
      </div>

      <ConversationModal row={openConv} onClose={() => setOpenConv(null)} />

      <ConfirmDialog
        open={confirmStatus}
        title={suspended ? `¿Reactivar «${business.name}»?` : `¿Suspender «${business.name}»?`}
        message={
          suspended
            ? 'Su equipo podrá volver a entrar en la aplicación y KAI volverá a responder a sus leads según su configuración.'
            : `Su equipo no podrá entrar en la aplicación y KAI dejará de responder a sus leads hasta que lo reactives. No se borra ningún dato y puedes reactivarlo cuando quieras.${
                isOwn ? ' Ojo: tú también eres miembro de este negocio, así que tampoco podrás usarlo desde la app (este panel seguirá disponible).' : ''
              }`
        }
        confirmLabel={suspended ? 'Reactivar' : 'Suspender'}
        danger={!suspended}
        loading={setStatus.isPending}
        onConfirm={toggleStatus}
        onClose={() => setConfirmStatus(false)}
      />
    </div>
  );
}
