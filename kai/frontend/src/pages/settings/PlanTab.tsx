/* Pestaña «Plan y uso»: plan actual, estado de la suscripción, consumo del mes y comparativa de planes. */
import { useQuery } from '@tanstack/react-query';
import { Check, CircleAlert, CreditCard, Gauge, Hourglass, LifeBuoy, Minus, RefreshCw, Table2 } from 'lucide-react';
import { BILLING_PERIOD_LABELS, formatMoney, type PlanLimits } from '@shared';
import { api, errorText } from '../../lib/api';
import { Button, Callout, Card, EmptyState, PageLoading } from '../../components/ui';
import { Meter } from '../../components/charts';
import type { Plan } from '../../lib/types';
import { PLAN_QUERY_KEY, daysUntil, longDate, type PlanResponse, type SubscriptionStatus } from './settings-shared';

const STATUS_INFO: Record<SubscriptionStatus, { label: string; tone: string }> = {
  trialing: { label: 'Periodo de prueba', tone: 'badge-info' },
  active: { label: 'Activa', tone: 'badge-success' },
  past_due: { label: 'Pago pendiente', tone: 'badge-warning' },
  canceled: { label: 'Cancelada', tone: 'badge-danger' },
};

const fmtNumber = (n: number) => n.toLocaleString('es-ES');
const planPrice = (p: Plan) => (p.priceMonthlyCents > 0 ? `${formatMoney(p.priceMonthlyCents, p.currency || 'EUR')} ${BILLING_PERIOD_LABELS.monthly}` : 'Gratis');

/** Filas de la tabla comparativa. */
const COMPARE_ROWS: { label: string; hint?: string; value: (l: PlanLimits) => number | null | boolean; unlimited?: string }[] = [
  { label: 'Leads nuevos al mes', value: (l) => l.maxLeadsPerMonth, unlimited: 'Ilimitados' },
  { label: 'Mensajes de KAI al mes', hint: 'Respuestas que KAI envía a tus leads', value: (l) => l.maxAiMessagesPerMonth, unlimited: 'Ilimitados' },
  { label: 'Usuarios del equipo', value: (l) => l.maxTeamMembers, unlimited: 'Ilimitados' },
  { label: 'Canales conectados', hint: 'WhatsApp, Instagram, anuncios de Meta…', value: (l) => l.maxChannels, unlimited: 'Ilimitados' },
  { label: 'Negocios', value: (l) => l.maxBusinesses, unlimited: 'Ilimitados' },
  { label: 'KAI Copilot', hint: 'Asistente al que puedes preguntar por tus leads y datos', value: (l) => l.copilot },
  { label: 'Analítica avanzada', value: (l) => l.advancedAnalytics },
];

function CompareCell({ value, unlimited }: { value: number | null | boolean; unlimited?: string }) {
  if (typeof value === 'boolean') {
    return value ? (
      <span className="row" style={{ gap: 6, color: 'var(--success)' }}>
        <Check size={16} aria-hidden />
        <span className="small">Incluido</span>
      </span>
    ) : (
      <span className="row subtle" style={{ gap: 6 }}>
        <Minus size={16} aria-hidden />
        <span className="small">No incluido</span>
      </span>
    );
  }
  if (value === null) return <strong>{unlimited ?? 'Ilimitado'}</strong>;
  return <span className="tnum">{fmtNumber(value)}</span>;
}

/** Medidor con explicación de qué pasa al llegar al límite. */
function UsageMeter({ label, value, max, description, atLimit }: { label: string; value: number; max: number | null; description: string; atLimit: string }) {
  const ratio = max ? value / max : 0;
  const reached = max !== null && value >= max;
  const near = max !== null && !reached && ratio >= 0.8;
  return (
    <div className="settings-usage">
      <Meter label={label} value={value} max={max} />
      <p className="subtle xs">{description}</p>
      {reached ? (
        <p className="small settings-usage-alert is-danger" role="status">
          <CircleAlert aria-hidden />
          <span>{atLimit}</span>
        </p>
      ) : near ? (
        <p className="small settings-usage-alert is-warning" role="status">
          <CircleAlert aria-hidden />
          <span>Estás cerca del límite de tu plan ({Math.round(ratio * 100)} % usado).</span>
        </p>
      ) : null}
    </div>
  );
}

export default function PlanTab() {
  const plan = useQuery({ queryKey: PLAN_QUERY_KEY, queryFn: () => api.get<PlanResponse>('/settings/plan') });

  if (plan.isPending) return <PageLoading />;
  if (plan.isError || !plan.data) {
    return (
      <div className="card">
        <EmptyState
          icon={CircleAlert}
          title="No hemos podido cargar tu plan"
          description={errorText(plan.error)}
          action={
            <Button icon={RefreshCw} loading={plan.isFetching} onClick={() => void plan.refetch()}>
              Reintentar
            </Button>
          }
        />
      </div>
    );
  }

  const data = plan.data;
  const current = data.plan;
  const status = data.subscriptionStatus ? STATUS_INFO[data.subscriptionStatus] : null;
  const trialDays = data.subscriptionStatus === 'trialing' && data.trialEndsAt ? daysUntil(data.trialEndsAt) : null;
  const plans = data.availablePlans;
  const currentInTable = current ? plans.some((p) => p.id === current.id) : false;
  const monthName = new Date().toLocaleDateString('es-ES', { month: 'long', year: 'numeric' });
  const copilotQueries = data.usage.copilot_queries ?? 0;

  return (
    <>
      <Card title="Tu plan" icon={CreditCard}>
        <div className="settings-plan-hero">
          <div className="col" style={{ gap: 6, minWidth: 0 }}>
            <div className="row wrap" style={{ gap: 10 }}>
              <h3 className="settings-plan-name">{current?.name ?? 'Sin plan asignado'}</h3>
              {status && <span className={`badge badge-dot ${status.tone}`}>{status.label}</span>}
            </div>
            {current?.description && <p className="muted">{current.description}</p>}
            {!current && <p className="muted">Tu negocio todavía no tiene un plan asignado, así que se aplican unos límites básicos (los que ves abajo).</p>}
          </div>
          {current && (
            <div className="settings-plan-price">
              <span className="tnum">{current.priceMonthlyCents > 0 ? formatMoney(current.priceMonthlyCents, current.currency || 'EUR') : 'Gratis'}</span>
              {current.priceMonthlyCents > 0 && <span className="subtle small"> {BILLING_PERIOD_LABELS.monthly}</span>}
            </div>
          )}
        </div>

        <div className="col gap-12 mt-16">
          {data.subscriptionStatus === 'trialing' && (
            <Callout tone="info" icon={Hourglass}>
              {trialDays === null
                ? 'Estás en el periodo de prueba.'
                : trialDays > 0
                  ? `Estás en el periodo de prueba: te ${trialDays === 1 ? 'queda 1 día' : `quedan ${trialDays} días`} (hasta el ${longDate(data.trialEndsAt)}).`
                  : `Tu periodo de prueba terminó el ${longDate(data.trialEndsAt)}.`}
            </Callout>
          )}
          {data.subscriptionStatus === 'past_due' && <Callout tone="warning">Hay un pago pendiente en tu suscripción. Contacta con el equipo de soporte de KAI para regularizarlo.</Callout>}
          {data.subscriptionStatus === 'canceled' && <Callout tone="danger">Tu suscripción está cancelada. Si quieres reactivarla, contacta con el equipo de soporte de KAI.</Callout>}
          <Callout tone="accent" icon={LifeBuoy}>
            <strong>El pago online todavía no está disponible en KAI.</strong> Desde aquí no se te cobra nada ni puedes cambiar de plan por tu cuenta. Si quieres cambiar de plan, contacta con el equipo de soporte de KAI y lo gestionarán por ti.
          </Callout>
        </div>
      </Card>

      <Card title={`Uso de este mes (${monthName})`} icon={Gauge}>
        <p className="muted small" style={{ marginTop: -6, marginBottom: 16 }}>
          Los contadores de leads y mensajes se reinician el día 1 de cada mes. El símbolo ∞ significa que tu plan no tiene límite.
        </p>
        <div className="grid-2">
          <UsageMeter
            label="Leads nuevos"
            value={data.usage.leads ?? 0}
            max={data.limits.maxLeadsPerMonth}
            description="Personas nuevas que han entrado en tu CRM este mes (los leads de prueba del simulador no cuentan)."
            atLimit="Has llegado al límite: los leads nuevos se siguen guardando, pero KAI no les responderá solo y te pasará la conversación a ti."
          />
          <UsageMeter
            label="Mensajes enviados por KAI"
            value={data.usage.ai_messages ?? 0}
            max={data.limits.maxAiMessagesPerMonth}
            description={`Respuestas que KAI ha enviado a tus leads este mes.${
              copilotQueries > 0 ? ` Además, has hecho ${fmtNumber(copilotQueries)} consulta(s) a KAI Copilot: Copilot deja de responder cuando la suma de mensajes y consultas llega a este límite.` : ''
            }`}
            atLimit="Has llegado al límite: KAI ha dejado de responder automáticamente y te pasa las conversaciones a ti hasta el mes que viene."
          />
          <UsageMeter
            label="Usuarios del equipo"
            value={data.seats}
            max={data.limits.maxTeamMembers}
            description="Personas con acceso a este negocio, incluidas las invitaciones pendientes."
            atLimit="Has llegado al límite: no puedes invitar a más personas salvo que quites a alguien o canceles una invitación."
          />
          <UsageMeter
            label="Canales conectados"
            value={data.channels}
            max={data.limits.maxChannels}
            description="Cuentas de WhatsApp, Instagram o anuncios de Meta conectadas en Integraciones."
            atLimit="Has llegado al límite: para conectar otro canal tendrás que desconectar uno de los actuales."
          />
        </div>
      </Card>

      <Card title="Compara los planes" icon={Table2} flush>
        {plans.length === 0 ? (
          <div style={{ padding: '0 18px 18px' }}>
            <p className="muted small">Ahora mismo no hay planes publicados para comparar.</p>
          </div>
        ) : (
          <>
            <div className="table-wrap">
              <table className="table settings-compare">
                <caption className="sr-only">Comparativa de los planes disponibles</caption>
                <thead>
                  <tr>
                    <th scope="col">
                      <span className="sr-only">Característica</span>
                    </th>
                    {plans.map((p) => {
                      const isCurrent = current?.id === p.id;
                      return (
                        <th key={p.id} scope="col" className={isCurrent ? 'is-current' : undefined}>
                          <div className="col" style={{ gap: 4 }}>
                            <span className="row" style={{ gap: 6 }}>
                              <strong className="settings-compare-name">{p.name}</strong>
                              {isCurrent && <span className="badge badge-accent">Tu plan</span>}
                            </span>
                            <span className="tnum settings-compare-price">{planPrice(p)}</span>
                          </div>
                        </th>
                      );
                    })}
                  </tr>
                </thead>
                <tbody>
                  {COMPARE_ROWS.map((row) => (
                    <tr key={row.label}>
                      <th scope="row">
                        <span className="settings-compare-label">{row.label}</span>
                        {row.hint && <span className="subtle xs settings-compare-hint">{row.hint}</span>}
                      </th>
                      {plans.map((p) => (
                        <td key={p.id} className={current?.id === p.id ? 'is-current' : undefined}>
                          <CompareCell value={row.value(p.limits)} unlimited={row.unlimited} />
                        </td>
                      ))}
                    </tr>
                  ))}
                  <tr>
                    <th scope="row">
                      <span className="settings-compare-label">Para quién es</span>
                    </th>
                    {plans.map((p) => (
                      <td key={p.id} className={`muted small ${current?.id === p.id ? 'is-current' : ''}`} style={{ minWidth: 200, whiteSpace: 'normal' }}>
                        {p.description || '—'}
                      </td>
                    ))}
                  </tr>
                </tbody>
              </table>
            </div>
            <div style={{ padding: '12px 18px 16px', borderTop: '1px solid var(--border)' }}>
              <p className="subtle xs">
                {current && !currentInTable ? 'Tu plan actual es un plan personalizado y no aparece en la tabla. ' : ''}
                Para cambiar de plan, contacta con el equipo de soporte de KAI: el cambio se gestiona a mano mientras el pago online no esté disponible.
              </p>
            </div>
          </>
        )}
      </Card>
    </>
  );
}
