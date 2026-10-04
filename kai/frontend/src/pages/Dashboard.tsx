import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import {
  AlertTriangle,
  CalendarCheck,
  CalendarClock,
  CircleDollarSign,
  Clock,
  Flame,
  FlaskConical,
  Hand,
  MessagesSquare,
  Plug,
  Repeat,
  RotateCw,
  Send,
  Target,
  TrendingUp,
  UserPlus,
  Users,
  Wallet,
} from 'lucide-react';
import { api, errorText } from '../lib/api';
import { useAuth } from '../lib/auth';
import { duration, money, pct, timeAgo, timeOnly, dayLabel, dateTime } from '../lib/format';
import { Button, Callout, Card, EmptyState, PageHeader, PageLoading, Stat } from '../components/ui';
import { ScoreBadge } from '../components/lead-bits';
import { Funnel } from '../components/charts';
import { InsightsCard, type Insight } from '../components/Insights';
import type { Alert, Appointment } from '../lib/types';
import type { LeadStatus, LeadTemperature } from '@shared';
import { leadStatusLabel } from '@shared';

interface DashboardData {
  timezone: string;
  leads: { newToday: number; contacted: number; active: number; hot: number; qualified: number };
  conversion: { response: number; qualification: number; booking: number; attendance: number; conversion: number };
  funnel30d: { leads: number; contacted: number; responded: number; qualified: number; booked: number; attended: number; clients: number; avgFirstResponseSeconds: number; messages: { kai: number } };
  activity: { activeConversations: number; pendingFollowUps: number; callsToday: number; upcomingCalls: number; leadsWithoutReply: number };
  callsToday: { appointment: Appointment; leadName: string; leadScore: number; goal: string | null }[];
  upcoming: { appointment: Appointment; leadName: string; leadScore: number; goal: string | null }[];
  attention: {
    alerts: { alert: Alert; leadName: string | null }[];
    atRisk: { id: string; name: string; score: number; temperature: LeadTemperature; status: LeadStatus; lastInboundAt: string | null; goalSummary: string | null }[];
    waiting: { conversationId: string; leadId: string; name: string; score: number; preview: string | null; lastInboundAt: string | null; handoff: boolean }[];
  };
  value: {
    currency: string;
    servicePriceCents: number;
    weightedPipelineCents: number;
    potentialRevenueCents: number;
    revenue30dCents: number;
    roi30d: { costCents: number; revenueCents: number; roi: number | null; note: string };
  };
  insights: Insight[];
  insightsLocked?: boolean;
}

/** Hora actual (0-23) en la zona horaria del negocio; si la zona no es válida, la del navegador. */
function businessHour(timeZone: string): number {
  try {
    return Number(new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hourCycle: 'h23', timeZone }).format(new Date())) % 24;
  } catch {
    return new Date().getHours();
  }
}

export default function Dashboard() {
  const { me } = useAuth();
  const navigate = useNavigate();
  const { data, isLoading, error, refetch, isFetching } = useQuery({ queryKey: ['dashboard'], queryFn: () => api.get<DashboardData>('/dashboard'), refetchInterval: 30_000 });
  if (isLoading) return <PageLoading />;
  if (!data) {
    // Si la API falla, se explica y se puede reintentar (antes la pantalla se quedaba cargando para siempre).
    return (
      <div className="page">
        <EmptyState
          icon={AlertTriangle}
          title="No se pudo cargar tu resumen de hoy"
          description={errorText(error)}
          action={
            <Button icon={RotateCw} loading={isFetching} onClick={() => void refetch()}>
              Reintentar
            </Button>
          }
        />
      </div>
    );
  }
  const firstName = me?.user?.name.split(' ')[0] ?? '';
  // La hora del saludo, en la zona horaria del negocio (la misma que la fecha de al lado).
  const hour = businessHour(data.timezone);
  const greeting = hour < 6 ? 'Buenas noches' : hour < 13 ? 'Buenos días' : hour < 20 ? 'Buenas tardes' : 'Buenas noches';
  const { attention } = data;
  const handoffs = attention.alerts.filter((a) => a.alert.type === 'handoff');
  const otherAlerts = attention.alerts.filter((a) => a.alert.type !== 'handoff');
  // Las conversaciones en espera que ya tienen aviso de escalado se muestran una sola vez (como aviso): el contador cuenta lo mismo que se pinta.
  const waiting = attention.waiting.filter((w) => !handoffs.some((h) => h.alert.conversationId === w.conversationId));
  const attentionCount = handoffs.length + waiting.length + attention.atRisk.length + otherAlerts.length;
  const noLeadsYet = data.funnel30d.leads === 0 && data.leads.active === 0;

  return (
    <div className="page">
      <PageHeader
        title={`${greeting}${firstName ? `, ${firstName}` : ''}`}
        description={`${dayLabel(new Date(), data.timezone)} · ${
          attentionCount === 0 ? 'Todo bajo control: KAI se encarga del resto' : attentionCount === 1 ? '1 cosa necesita tu atención' : `${attentionCount} cosas necesitan tu atención`
        }`}
        actions={
          <>
            <Button icon={FlaskConical} onClick={() => navigate('/app/simulador')}>
              Probar KAI
            </Button>
            <Button variant="primary" icon={UserPlus} onClick={() => navigate('/app/leads?nuevo=1')}>
              Nuevo lead
            </Button>
          </>
        }
      />

      {noLeadsYet && (
        <div style={{ marginBottom: 16 }}>
          <Callout tone="accent" icon={Plug}>
            <strong>KAI está listo, pero todavía no han entrado leads.</strong> Conecta WhatsApp, Instagram o tus formularios en{' '}
            <a href="/app/integraciones" onClick={(e) => { e.preventDefault(); navigate('/app/integraciones'); }}>
              Integraciones
            </a>{' '}
            o pruébalo ahora en el{' '}
            <a href="/app/simulador" onClick={(e) => { e.preventDefault(); navigate('/app/simulador'); }}>
              simulador
            </a>
            .
          </Callout>
        </div>
      )}

      <div className="grid-split">
        <Card title="Necesita tu atención" icon={Hand} actions={<span className="badge">{attentionCount}</span>}>
          {attentionCount === 0 ? (
            <EmptyState icon={Target} title="Nada urgente" description="Cuando KAI necesite tu intervención, un lead caliente espere tu respuesta o alguien esté a punto de perderse, aparecerá aquí." />
          ) : (
            <div className="col">
              {handoffs.map(({ alert, leadName }) => (
                <button key={alert.id} className="attention-item" onClick={() => navigate(alert.conversationId ? `/app/inbox/${alert.conversationId}` : `/app/leads/${alert.leadId}`)}>
                  <span className="attention-icon" style={{ background: 'var(--warning-soft)', color: 'var(--warning)' }}>
                    <Hand />
                  </span>
                  <div className="grow">
                    <strong>KAI necesita tu intervención · {leadName ?? 'Lead'}</strong>
                    <div className="muted small ellipsis">{alert.body}</div>
                  </div>
                  <span className="subtle xs">{timeAgo(alert.createdAt)}</span>
                </button>
              ))}
              {waiting.map((w) => (
                <button key={w.conversationId} className="attention-item" onClick={() => navigate(`/app/inbox/${w.conversationId}`)}>
                  <span className="attention-icon" style={{ background: 'var(--info-soft)', color: 'var(--info)' }}>
                    <MessagesSquare />
                  </span>
                  <div className="grow">
                    <strong>{w.name || 'Lead'} espera tu respuesta</strong>
                    <div className="muted small ellipsis">“{w.preview}”</div>
                  </div>
                  <ScoreBadge score={w.score} />
                </button>
              ))}
              {attention.atRisk.map((l) => (
                <button key={l.id} className="attention-item" onClick={() => navigate(`/app/leads/${l.id}`)}>
                  <span className="attention-icon" style={{ background: 'var(--hot-soft)', color: 'var(--hot)' }}>
                    <Flame />
                  </span>
                  <div className="grow">
                    <strong>{l.name || 'Lead'} está a punto de perderse</strong>
                    <div className="muted small ellipsis">
                      {leadStatusLabel(l.status)} · sin respuesta {l.lastInboundAt ? timeAgo(l.lastInboundAt) : 'desde el inicio'}
                      {l.goalSummary ? ` · ${l.goalSummary}` : ''}
                    </div>
                  </div>
                  <ScoreBadge score={l.score} />
                </button>
              ))}
              {otherAlerts.map(({ alert, leadName }) => (
                <button
                  key={alert.id}
                  className="attention-item"
                  onClick={() =>
                    navigate(
                      alert.type === 'call_outcome'
                        ? '/app/agenda'
                        : // «No hay huecos libres»: lo que hay que revisar es el horario, aunque el aviso venga de una conversación.
                          alert.type === 'no_availability'
                          ? '/app/agenda?tab=disponibilidad'
                          : alert.conversationId
                            ? `/app/inbox/${alert.conversationId}`
                            : alert.leadId
                              ? `/app/leads/${alert.leadId}`
                              : '/app/integraciones',
                    )
                  }
                >
                  <span className="attention-icon" style={{ background: alert.severity === 'critical' ? 'var(--danger-soft)' : 'var(--surface-3)', color: alert.severity === 'critical' ? 'var(--danger)' : 'var(--text-2)' }}>
                    {alert.type === 'call_outcome' ? <CalendarCheck /> : <AlertTriangle />}
                  </span>
                  <div className="grow">
                    <strong>
                      {alert.title}
                      {leadName ? ` · ${leadName}` : ''}
                    </strong>
                    <div className="muted small ellipsis">{alert.body}</div>
                  </div>
                  <span className="subtle xs">{timeAgo(alert.createdAt)}</span>
                </button>
              ))}
            </div>
          )}
        </Card>

        <Card title="Llamadas de hoy" icon={CalendarClock} actions={<Button size="sm" variant="ghost" onClick={() => navigate('/app/agenda')}>Agenda</Button>}>
          {data.callsToday.length === 0 ? (
            <p className="muted small">No tienes llamadas hoy.</p>
          ) : (
            <div className="col">
              {data.callsToday.map((c) => (
                <button key={c.appointment.id} className="attention-item" onClick={() => navigate(`/app/leads/${c.appointment.leadId}`)}>
                  <span className="tnum" style={{ fontWeight: 700, minWidth: 44 }}>
                    {timeOnly(c.appointment.startsAt, data.timezone)}
                  </span>
                  <div className="grow">
                    <strong className="ellipsis">{c.leadName}</strong>
                    <div className="muted small ellipsis">{c.goal ?? 'Llamada de valoración'}</div>
                  </div>
                  <ScoreBadge score={c.leadScore} />
                </button>
              ))}
            </div>
          )}
          {data.upcoming.length > 0 && (
            <>
              <div className="section-title mt-16" style={{ marginBottom: 8 }}>
                Próximas
              </div>
              <div className="col gap-4">
                {data.upcoming.slice(0, 5).map((c) => (
                  <button key={c.appointment.id} className="row-between" onClick={() => navigate(`/app/leads/${c.appointment.leadId}`)} style={{ border: 0, background: 'none', padding: '6px 2px', cursor: 'pointer', color: 'inherit' }}>
                    <span className="ellipsis">{c.leadName}</span>
                    <span className="subtle small">{dateTime(c.appointment.startsAt, data.timezone)}</span>
                  </button>
                ))}
              </div>
            </>
          )}
        </Card>
      </div>

      <div className="section-title mt-24" style={{ marginBottom: 10 }}>
        Leads
      </div>
      <div className="grid-5">
        <Stat label="Nuevos hoy" value={data.leads.newToday} icon={UserPlus} onClick={() => navigate('/app/leads')} />
        <Stat label="Contactados (30 días)" value={data.funnel30d.contacted} sub="KAI o tu equipo ya les han escrito" icon={Send} onClick={() => navigate('/app/leads')} />
        <Stat label="Activos (7 días)" value={data.leads.active} icon={Users} onClick={() => navigate('/app/inbox')} />
        <Stat label="Calientes" value={data.leads.hot} icon={Flame} onClick={() => navigate('/app/inbox?filtro=hot')} />
        <Stat label="Cualificados" value={data.leads.qualified} icon={Target} onClick={() => navigate('/app/pipeline')} />
      </div>

      <div className="grid-2 mt-16" style={{ alignItems: 'start' }}>
        <Card title="Conversión · últimos 30 días" icon={TrendingUp}>
          <Funnel
            steps={[
              { label: 'Leads', value: data.funnel30d.leads },
              { label: 'Respondieron', value: data.funnel30d.responded },
              { label: 'Cualificados', value: data.funnel30d.qualified },
              { label: 'Agendaron', value: data.funnel30d.booked },
              { label: 'Clientes', value: data.funnel30d.clients },
            ]}
          />
          <div className="grid-5 mt-16" style={{ gap: 8 }}>
            {[
              ['Respuesta', data.conversion.response],
              ['Cualificación', data.conversion.qualification],
              ['Agendamiento', data.conversion.booking],
              ['Asistencia', data.conversion.attendance],
              ['Conversión', data.conversion.conversion],
            ].map(([label, v]) => (
              <div key={label as string} className="col gap-4">
                <span className="subtle xs">{label}</span>
                <strong className="tnum">{pct(v as number)}</strong>
              </div>
            ))}
          </div>
        </Card>

        <div className="col gap-16">
          <Card title="Actividad" icon={MessagesSquare}>
            <div className="grid-2" style={{ gap: 12 }}>
              <div className="col gap-4">
                <span className="subtle small">Conversaciones activas (24 h)</span>
                <strong className="stat-value tnum">{data.activity.activeConversations}</strong>
              </div>
              <div className="col gap-4">
                <span className="subtle small">Seguimientos programados</span>
                <strong className="stat-value tnum">{data.activity.pendingFollowUps}</strong>
              </div>
              <div className="col gap-4">
                <span className="subtle small">Llamadas hoy</span>
                <strong className="stat-value tnum">{data.activity.callsToday}</strong>
              </div>
              <div className="col gap-4">
                <span className="subtle small">Llamadas próximas (7 días)</span>
                <strong className="stat-value tnum">{data.activity.upcomingCalls}</strong>
              </div>
              <div className="col gap-4">
                <span className="subtle small">
                  <Clock size={12} style={{ verticalAlign: '-1px' }} aria-hidden /> Leads sin respuesta (+24 h)
                </span>
                <strong className="stat-value tnum">{data.activity.leadsWithoutReply}</strong>
                {data.activity.leadsWithoutReply > 0 && (
                  <a href="/app/inbox?filtro=no_reply" className="xs" onClick={(e) => { e.preventDefault(); navigate('/app/inbox?filtro=no_reply'); }}>
                    Ver en la bandeja
                  </a>
                )}
              </div>
              <div className="col gap-4">
                <span className="subtle small">Tiempo medio de primera respuesta</span>
                <strong className="stat-value tnum">{duration(data.funnel30d.avgFirstResponseSeconds)}</strong>
              </div>
            </div>
          </Card>

          <Card title="Valor económico" icon={Wallet}>
            {data.value.servicePriceCents === 0 ? (
              <Callout tone="info" icon={CircleDollarSign}>
                Añade el precio de tu servicio en{' '}
                <a href="/app/setter" onClick={(e) => { e.preventDefault(); navigate('/app/setter?tab=servicio'); }}>
                  Setter IA → Servicio y precio
                </a>{' '}
                para calcular el valor del pipeline y el ROI.
              </Callout>
            ) : (
              <>
                <div className="grid-2" style={{ gap: 12 }}>
                  <div className="col gap-4">
                    <span className="subtle small">Valor ponderado del pipeline</span>
                    <strong className="stat-value tnum">{money(data.value.weightedPipelineCents, data.value.currency)}</strong>
                  </div>
                  <div className="col gap-4">
                    <span className="subtle small">Ingresos potenciales (cualificados + llamadas)</span>
                    <strong className="stat-value tnum">{money(data.value.potentialRevenueCents, data.value.currency)}</strong>
                  </div>
                  <div className="col gap-4">
                    <span className="subtle small">Ingresos generados (30 días)</span>
                    <strong className="stat-value tnum">{money(data.value.revenue30dCents, data.value.currency)}</strong>
                  </div>
                  <div className="col gap-4">
                    <span className="subtle small">ROI estimado (30 días)</span>
                    <strong className="stat-value tnum">{data.value.roi30d.roi === null ? '—' : pct(data.value.roi30d.roi)}</strong>
                  </div>
                </div>
                <p className="subtle xs mt-12">
                  <Repeat size={11} style={{ verticalAlign: '-1px' }} /> {data.value.roi30d.note}
                </p>
              </>
            )}
          </Card>
        </div>
      </div>

      <InsightsCard insights={data.insights ?? []} locked={data.insightsLocked} className="mt-16" />
    </div>
  );
}
