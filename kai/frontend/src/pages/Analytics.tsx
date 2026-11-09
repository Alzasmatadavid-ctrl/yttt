import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { CalendarCheck, ChartColumn, Clock, Coins, Filter, Lock, MessagesSquare, RotateCw, Target, UserCheck, UserPlus, UserX, Wallet } from 'lucide-react';
import { leadSourceLabel, type LeadSource } from '@shared';
import { api, errorText } from '../lib/api';
import type { SettingsResponse } from '../lib/types';
import { compact, duration, isoDate, money, pct } from '../lib/format';
import { Button, Callout, Card, Field, Input, PageHeader, PageLoading, Segmented, Stat } from '../components/ui';
import { Funnel, SimpleBars, StackedBars } from '../components/charts';
import { SourceIcon } from '../components/lead-bits';
import { InsightsCard, type Insight } from '../components/Insights';

interface AnalyticsData {
  period: string;
  range: { from: string; to: string };
  timezone: string;
  funnel: {
    leads: number;
    contacted: number;
    responded: number;
    qualified: number;
    booked: number;
    attended: number;
    noShows: number;
    clients: number;
    lost: number;
    rates: { response: number; qualification: number; booking: number; attendance: number; conversion: number };
    avgFirstResponseSeconds: number;
    messages: { total: number; inbound: number; kai: number; human: number; conversations: number };
    clientsWon: number;
    revenueCents: number;
    currency: string;
  };
  series: { day: string; leads: number; bySource: Record<string, number>; booked: number; clients: number }[];
  sources: { source: LeadSource; leads: number; qualified: number; clients: number }[];
  value: { weightedPipelineCents: number; potentialRevenueCents: number; servicePriceCents: number; currency: string };
  roi: { costCents: number; revenueCents: number; roi: number | null; note: string };
  insights: Insight[];
  insightsLocked?: boolean;
}

type Period = 'today' | '7d' | '30d' | '90d' | 'custom';

/** Periodos incluidos solo en los planes con analítica avanzada (el servidor aplica la misma regla). */
const ADVANCED_PERIODS: Period[] = ['90d', 'custom'];

/** Máximo de días de un periodo personalizado (el mismo límite que aplica el servidor). */
const MAX_CUSTOM_DAYS = 366;

/** Error del periodo personalizado, o null si las fechas son válidas. */
function customRangeError(from: string, to: string): string | null {
  if (!from || !to) return 'Indica las fechas de inicio y fin.';
  const days = (Date.parse(to) - Date.parse(from)) / 86_400_000;
  if (!Number.isFinite(days)) return 'Revisa las fechas: alguna no es válida.';
  if (days < 0) return 'La fecha de inicio debe ser anterior a la de fin.';
  if (days > MAX_CUSTOM_DAYS) return 'El periodo máximo es de un año: acorta las fechas.';
  return null;
}

function shortDay(iso: string) {
  return new Date(`${iso}T12:00:00Z`).toLocaleDateString('es-ES', { day: 'numeric', month: 'short', timeZone: 'UTC' });
}
function longDay(iso: string) {
  return new Date(`${iso}T12:00:00Z`).toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
}

export default function Analytics() {
  const [period, setPeriod] = useState<Period>('30d');
  const [from, setFrom] = useState(isoDate(new Date(Date.now() - 13 * 86_400_000)));
  const [to, setTo] = useState(isoDate(new Date()));
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => api.get<SettingsResponse>('/settings'), staleTime: 30_000 });
  const advanced = settings.data?.limits.advancedAnalytics ?? true;
  const customLocked = ADVANCED_PERIODS.includes(period) && !advanced;
  // Las fechas se validan aquí con el mismo criterio que el servidor: así no se pide un periodo que va a fallar.
  const rangeError = period === 'custom' && !customLocked ? customRangeError(from, to) : null;
  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ['analytics', period, period === 'custom' ? from : '', period === 'custom' ? to : ''],
    queryFn: () => api.get<AnalyticsData>('/analytics', { period, ...(period === 'custom' ? { from, to } : {}) }),
    enabled: !customLocked && !rangeError,
    placeholderData: (prev) => prev,
  });

  const sourcesInData = useMemo(() => {
    const set = new Set<string>();
    for (const d of data?.series ?? []) for (const k of Object.keys(d.bySource)) set.add(k);
    return ['instagram', 'whatsapp', 'meta_ads', 'landing', 'webhook', 'manual'].filter((s) => set.has(s));
  }, [data]);

  // La cabecera (con el selector de periodo y las fechas) se pinta siempre: si una consulta falla,
  // el entrenador ve el motivo y puede cambiar el periodo o reintentar, en vez de un spinner sin fin.
  const header = (
    <PageHeader
      title="Analítica"
      description="Cómo está funcionando tu captación: de lead a cliente."
      actions={
        <div className="row wrap">
          <Segmented
            value={period}
            onChange={setPeriod}
            options={[
              { value: 'today', label: 'Hoy' },
              { value: '7d', label: '7 días' },
              { value: '30d', label: '30 días' },
              { value: '90d', label: '90 días' },
              { value: 'custom', label: 'Personalizado' },
            ]}
          />
          {period === 'custom' && advanced && (
            <div className="row">
              <Field>
                <Input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} aria-label="Desde" />
              </Field>
              <span className="subtle">–</span>
              <Field>
                <Input type="date" value={to} min={from} max={isoDate(new Date())} onChange={(e) => setTo(e.target.value)} aria-label="Hasta" />
              </Field>
            </div>
          )}
        </div>
      }
    />
  );
  const notices = (
    <>
      {customLocked && (
        <Callout tone="info" icon={Lock}>
          {period === '90d' ? 'El periodo de 90 días está incluido' : 'Los periodos personalizados están incluidos'} en los planes con analítica avanzada.
          {data ? ' Mientras tanto, se muestran los datos del último periodo consultado.' : ''}{' '}
          <Link to="/app/ajustes?tab=plan">Ver mi plan</Link>
        </Callout>
      )}
      {rangeError && <Callout tone="warning">{rangeError}{data ? ' Mientras tanto, se muestran los datos del último periodo consultado.' : ''}</Callout>}
      {error && !rangeError && (
        <Callout tone="danger">
          <div className="row-between wrap">
            <span>No se pudieron cargar los datos de este periodo: {errorText(error)}</span>
            <Button size="sm" icon={RotateCw} loading={isFetching} onClick={() => void refetch()}>
              Reintentar
            </Button>
          </div>
        </Callout>
      )}
    </>
  );

  if (!data) {
    return (
      <div className="page">
        {header}
        <div className="col gap-12">{notices}</div>
        {isLoading && <PageLoading />}
      </div>
    );
  }
  const f = data.funnel;
  const stacked = data.series.map((d) => ({ label: shortDay(d.day), fullLabel: longDay(d.day), values: d.bySource }));
  const calls = data.series.map((d) => ({ label: shortDay(d.day), fullLabel: longDay(d.day), value: d.booked }));
  const hasNotices = customLocked || Boolean(rangeError) || Boolean(error);

  return (
    <div className="page">
      {header}
      {hasNotices && <div className="col gap-12">{notices}</div>}

      <div className={`grid-5${hasNotices ? ' mt-16' : ''}`}>
        <Stat label="Leads" value={compact(f.leads)} icon={UserPlus} />
        <Stat label="Respondieron" value={compact(f.responded)} sub={`${pct(f.rates.response)} de respuesta`} icon={MessagesSquare} />
        <Stat label="Cualificados" value={compact(f.qualified)} sub={`${pct(f.rates.qualification)} de cualificación`} icon={Target} />
        <Stat label="Llamadas agendadas" value={compact(f.booked)} sub={`${pct(f.rates.booking)} de agendamiento`} icon={CalendarCheck} />
        <Stat label="Clientes" value={compact(f.clients)} sub={`${pct(f.rates.conversion)} de conversión`} icon={UserCheck} />
      </div>
      <div className="grid-5 mt-12">
        <Stat label="Conversaciones" value={compact(f.messages.conversations)} sub={`${compact(f.messages.kai)} mensajes de KAI`} icon={MessagesSquare} />
        <Stat label="Asistencia" value={pct(f.rates.attendance)} sub={`${f.attended} asistieron`} icon={UserCheck} />
        <Stat label="No-shows" value={compact(f.noShows)} icon={UserX} />
        <Stat label="Tiempo medio de respuesta" value={duration(f.avgFirstResponseSeconds)} icon={Clock} />
        <Stat label="Valor del pipeline" value={money(data.value.weightedPipelineCents, data.value.currency)} sub="ponderado por etapa" icon={Wallet} />
      </div>

      <div className="grid-split mt-16">
        <Card title="Leads por día y origen" icon={ChartColumn}>
          {f.leads === 0 ? <p className="muted small">Sin leads en este periodo.</p> : <StackedBars data={stacked} keys={sourcesInData} unit="leads" />}
        </Card>
        <Card title="Embudo" icon={Filter}>
          <Funnel
            steps={[
              { label: 'Leads', value: f.leads },
              { label: 'Respondieron', value: f.responded },
              { label: 'Cualificados', value: f.qualified },
              { label: 'Agendaron', value: f.booked },
              { label: 'Asistieron', value: f.attended },
              { label: 'Clientes', value: f.clients },
            ]}
          />
        </Card>
      </div>

      <div className="grid-split mt-16">
        <Card title="Llamadas agendadas por día" icon={CalendarCheck}>
          {f.booked === 0 ? <p className="muted small">Sin llamadas agendadas en este periodo.</p> : <SimpleBars data={calls} unit="llamadas" />}
        </Card>
        <Card title="Ingresos y ROI" icon={Coins}>
          <div className="col gap-12">
            <div className="row-between">
              <span className="muted">Ingresos generados</span>
              <strong className="tnum">{money(f.revenueCents, f.currency)}</strong>
            </div>
            <div className="row-between">
              <span className="muted">Coste estimado (KAI + anuncios)</span>
              <strong className="tnum">{money(data.roi.costCents, f.currency)}</strong>
            </div>
            <div className="row-between">
              <span className="muted">ROI estimado</span>
              <strong className="tnum">{data.roi.roi === null ? '—' : pct(data.roi.roi)}</strong>
            </div>
            <div className="row-between">
              <span className="muted">Ingresos potenciales</span>
              <strong className="tnum">{money(data.value.potentialRevenueCents, f.currency)}</strong>
            </div>
            <p className="subtle xs">{data.roi.note} Indica tu inversión mensual en anuncios en Ajustes → Negocio para afinarlo.</p>
          </div>
        </Card>
      </div>

      <InsightsCard insights={data.insights ?? []} locked={data.insightsLocked} className="mt-16" />

      <Card title="Rendimiento por origen" className="mt-16" flush>
        <div className="table-wrap" style={{ paddingTop: 8 }}>
          <table className="table">
            <thead>
              <tr>
                <th>Origen</th>
                <th className="num">Leads</th>
                <th className="num">Cualificados</th>
                <th className="num">Clientes</th>
                <th className="num">Conversión</th>
              </tr>
            </thead>
            <tbody>
              {data.sources.length === 0 && (
                <tr>
                  <td colSpan={5} className="muted">
                    Sin datos en este periodo.
                  </td>
                </tr>
              )}
              {[...data.sources]
                .sort((a, b) => b.leads - a.leads)
                .map((s) => (
                  <tr key={s.source}>
                    <td>
                      <span className="row">
                        <SourceIcon source={s.source} />
                        {leadSourceLabel(s.source)}
                      </span>
                    </td>
                    <td className="num">{s.leads}</td>
                    <td className="num">{s.qualified}</td>
                    <td className="num">{s.clients}</td>
                    <td className="num">{pct(s.leads ? (s.clients / s.leads) * 100 : 0)}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
