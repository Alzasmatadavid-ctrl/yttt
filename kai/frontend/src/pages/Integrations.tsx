/* Integraciones: estado de la IA, canales de Meta (WhatsApp, Instagram, Lead Ads), calendario y formularios/webhooks. */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { BrainCircuit, CalendarDays, Globe, Lock, Mail, Megaphone, RefreshCw, Sparkles } from 'lucide-react';
import { api, errorText } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Button, Callout, Card, EmptyState, PageHeader, PageLoading, Tabs, useToast } from '../components/ui';
import { WhatsAppIcon, InstagramIcon } from '../components/lead-bits';
import { ChannelsSection } from './integrations/ChannelsSection';
import { CalendarSection } from './integrations/CalendarSection';
import { WebSection } from './integrations/WebSection';
import { connState, INTEGRATIONS_KEY, type IntegrationsResponse } from './integrations/shared';
import '../styles/integrations.css';

type TabKey = 'canales' | 'calendario' | 'web';

const TABS: { value: TabKey; label: string; short: string }[] = [
  { value: 'canales', label: 'WhatsApp, Instagram y anuncios', short: 'Mensajes' },
  { value: 'calendario', label: 'Calendario', short: 'Calendario' },
  { value: 'web', label: 'Formularios y webhooks', short: 'Formularios' },
];

const NARROW = '(max-width: 640px)';

/** En pantallas estrechas las pestañas usan nombres cortos para que se vean las tres sin desplazarse. */
function useNarrow() {
  const [narrow, setNarrow] = useState(() => Boolean(typeof window !== 'undefined' && window.matchMedia?.(NARROW).matches));
  useEffect(() => {
    const mq = window.matchMedia?.(NARROW);
    if (!mq) return;
    const on = () => setNarrow(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return narrow;
}

const GOOGLE_RESULT: Record<string, { text: string; tone: 'success' | 'error' | 'info' }> = {
  ok: { text: 'Google Calendar conectado. KAI ya tiene en cuenta tus horas ocupadas.', tone: 'success' },
  error: { text: 'No se ha podido conectar Google Calendar. Inténtalo de nuevo y, si se repite, avisa a quien administra KAI.', tone: 'error' },
  cancelado: { text: 'Se ha cancelado la conexión con Google Calendar (o Google no ha dado permiso). No se ha conectado nada.', tone: 'info' },
  sesion: { text: 'Al volver de Google no hemos encontrado tu sesión de KAI. Inicia sesión de nuevo y vuelve a intentarlo.', tone: 'error' },
};

function tabFromHash(): TabKey | null {
  const hash = window.location.hash.replace('#', '');
  return TABS.some((t) => t.value === hash) ? (hash as TabKey) : null;
}

function initialTab(params: URLSearchParams): TabKey {
  if (params.get('google')) return 'calendario';
  return tabFromHash() ?? 'canales';
}

function AiStatusCard({ ai }: { ai: IntegrationsResponse['ai'] }) {
  const live = ai.mode === 'llm';
  return (
    <Card
      title="Inteligencia artificial de KAI"
      icon={BrainCircuit}
      actions={
        live ? (
          <span className="badge badge-dot badge-success">{/claude/i.test(ai.provider) ? 'IA: Claude' : 'IA activa'}</span>
        ) : (
          <span className="badge badge-dot badge-warning">Modo simulado</span>
        )
      }
    >
      {live ? (
        <div className="col gap-12">
          <p className="muted">KAI está usando inteligencia artificial real para entender y responder a tus leads.</p>
          <dl className="kv intg-kv-wide">
            <dt>Proveedor</dt>
            <dd>{ai.provider}</dd>
            <dt>Modelo principal</dt>
            <dd>
              <span className="intg-mono">{ai.mainModel}</span> <span className="subtle small">· redacta las respuestas y atiende a Copilot</span>
            </dd>
            <dt>Modelo rápido</dt>
            <dd>
              <span className="intg-mono">{ai.fastModel}</span> <span className="subtle small">· analiza cada mensaje y revisa las respuestas antes de enviarlas</span>
            </dd>
          </dl>
        </div>
      ) : (
        <Callout tone="warning" icon={Sparkles}>
          <strong>KAI está funcionando en modo simulado.</strong> Falta la clave de la IA (<code className="code-inline">ANTHROPIC_API_KEY</code>) en el
          servidor, o el servidor tiene la IA desactivada a propósito (<code className="code-inline">AI_PROVIDER=simulated</code>).
          <ul className="intg-list-plain mt-8">
            <li>
              Las respuestas salen de un motor de reglas sencillo: sirven para probar todo el sistema (CRM, agenda, automatizaciones), pero los mensajes son más
              básicos y KAI entiende peor lo que escribe el lead.
            </li>
            <li>Copilot solo responde a preguntas básicas sobre tus datos.</li>
            <li>
              Puedes ver cómo contesta KAI ahora mismo en el <Link to="/app/simulador">Simulador</Link>, sin escribir a ningún lead real.
            </li>
            <li>
              Para atender a leads reales, pide a quien administra el servidor que añada la clave <code className="code-inline">ANTHROPIC_API_KEY</code> y
              reinicie KAI. No tienes que cambiar nada de tu configuración.
            </li>
          </ul>
        </Callout>
      )}
    </Card>
  );
}

/** Resumen rápido del estado de cada bloque. */
function Overview({ data, onGo }: { data: IntegrationsResponse; onGo: (t: TabKey) => void }) {
  const active = data.channels.filter((c) => c.status !== 'disconnected');
  const by = (ch: string) => connState(active.filter((c) => c.channel === ch));
  const cal = data.calendars.find((c) => c.status !== 'disconnected');
  const label = { connected: 'Conectado', error: 'Con errores', none: 'Sin conectar' } as const;
  const tone = { connected: 'badge-success', error: 'badge-danger', none: '' } as const;
  const items: { key: string; icon: ReactNode; name: string; state: keyof typeof label | 'internal'; tab: TabKey }[] = [
    { key: 'wa', icon: <WhatsAppIcon size={16} />, name: 'WhatsApp', state: by('whatsapp'), tab: 'canales' },
    { key: 'ig', icon: <InstagramIcon size={16} />, name: 'Instagram', state: by('instagram'), tab: 'canales' },
    { key: 'ads', icon: <Megaphone size={16} aria-hidden />, name: 'Meta Lead Ads', state: by('meta_lead_ads'), tab: 'canales' },
    { key: 'cal', icon: <CalendarDays size={16} aria-hidden />, name: cal ? (cal.provider === 'google' ? 'Google Calendar' : 'Calendly') : 'Agenda de KAI', state: cal ? connState([cal]) : 'internal', tab: 'calendario' },
    { key: 'web', icon: <Globe size={16} aria-hidden />, name: 'Formularios y webhooks', state: 'internal', tab: 'web' },
  ];
  return (
    <div className="col gap-12">
    <ul className="intg-overview" aria-label="Resumen de integraciones">
      {items.map((it) => (
        <li key={it.key}>
          <button type="button" className="intg-overview-item" onClick={() => onGo(it.tab)}>
            <span className="intg-overview-icon">{it.icon}</span>
            <span className="grow ellipsis">{it.name}</span>
            {it.state === 'internal' ? (
              <span className="badge badge-dot badge-success">Disponible</span>
            ) : (
              <span className={`badge badge-dot ${tone[it.state]}`}>{label[it.state]}</span>
            )}
          </button>
        </li>
      ))}
    </ul>
    <p className="xs subtle row intg-email">
      <Mail aria-hidden size={14} />
      <span>
        Emails de KAI (recuperar contraseña, invitar al equipo):{' '}
        {data.server.email ? <strong>activos</strong> : <strong>sin configurar en el servidor</strong>}
        {!data.server.email && '. Mientras tanto, esos emails no llegan; avisa a quien administra KAI si los necesitas.'}
      </span>
    </p>
    </div>
  );
}

export default function Integrations() {
  const qc = useQueryClient();
  const toast = useToast();
  const { activeBusiness } = useAuth();
  const [params, setParams] = useSearchParams();
  const [tab, setTab] = useState<TabKey>(() => initialTab(params));
  const handledGoogle = useRef(false);
  const query = useQuery({ queryKey: INTEGRATIONS_KEY, queryFn: () => api.get<IntegrationsResponse>('/integrations') });
  const canManage = activeBusiness?.role !== 'team_member';
  const narrow = useNarrow();

  // Vuelta desde Google: ?google=ok|error|cancelado|sesion → aviso y limpiamos la URL.
  useEffect(() => {
    const result = params.get('google');
    if (!result || handledGoogle.current) return;
    handledGoogle.current = true;
    const info = GOOGLE_RESULT[result] ?? GOOGLE_RESULT.error;
    toast(info.text, info.tone);
    setTab('calendario');
    const next = new URLSearchParams(params);
    next.delete('google');
    setParams(next, { replace: true });
    void qc.invalidateQueries({ queryKey: INTEGRATIONS_KEY });
    void qc.invalidateQueries({ queryKey: ['availability'] });
    void qc.invalidateQueries({ queryKey: ['slots'] });
  }, [params, setParams, toast, qc]);

  // Enlaces a /app/integraciones#web (u otra pestaña) mientras ya estás en la página.
  useEffect(() => {
    const onHash = () => {
      const t = tabFromHash();
      if (t) setTab(t);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const goTo = (t: TabKey) => {
    setTab(t);
    window.history.replaceState(window.history.state, '', `${window.location.pathname}${window.location.search}#${t}`);
  };

  if (query.isLoading) return <PageLoading />;

  if (query.isError || !query.data) {
    return (
      <div className="page intg-page">
        <PageHeader title="Integraciones" />
        <div className="card">
          <EmptyState
            icon={RefreshCw}
            title="No hemos podido cargar tus integraciones"
            description={errorText(query.error)}
            action={
              <Button variant="primary" icon={RefreshCw} loading={query.isFetching} onClick={() => void query.refetch()}>
                Reintentar
              </Button>
            }
          />
        </div>
      </div>
    );
  }

  const data = query.data;

  return (
    <div className="page intg-page">
      <PageHeader
        title="Integraciones"
        description="Conecta KAI con tus canales de mensajes, tu calendario y tu web. Aquí ves qué funciona y qué falta por configurar."
        actions={
          <Button icon={RefreshCw} loading={query.isFetching} onClick={() => void query.refetch()}>
            Comprobar estado
          </Button>
        }
      />

      {!canManage && (
        <div className="intg-gap-b">
          <Callout tone="info" icon={Lock}>
            Puedes consultar las integraciones, pero solo la persona titular de la cuenta (entrenador) puede conectarlas o cambiarlas.
          </Callout>
        </div>
      )}

      <div className="intg-top">
        <AiStatusCard ai={data.ai} />
        <Card title="Resumen">
          <Overview data={data} onGo={goTo} />
        </Card>
      </div>

      <div className="mt-24">
        <Tabs tabs={TABS.map((t) => ({ value: t.value, label: narrow ? t.short : t.label }))} value={tab} onChange={goTo} />
      </div>
      <div role="tabpanel" aria-label={TABS.find((t) => t.value === tab)?.label}>
        {tab === 'canales' && <ChannelsSection data={data} canManage={canManage} />}
        {tab === 'calendario' && <CalendarSection data={data} canManage={canManage} />}
        {tab === 'web' && <WebSection data={data} canManage={canManage} />}
      </div>
    </div>
  );
}
