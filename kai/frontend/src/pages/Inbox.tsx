import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ArrowLeft, Bot, Brain, CalendarPlus, CheckCheck, Hand, Inbox as InboxIcon, PanelRight, Play, RotateCw, Search, Send, Sparkles, User, UserRound, X } from 'lucide-react';
import { CHANNEL_LABELS, HANDOFF_REASONS, type HandoffReason, type LeadSource, type LeadStatus, type LeadTemperature } from '@shared';
import { api, errorText } from '../lib/api';
import { dateTime, dayLabel, shortTime, timeAgo, timeOnly } from '../lib/format';
import { nextActionFor } from '../lib/leads';
import { useBusinessSettings } from '../lib/business';
import { Button, Card, EmptyState, Spinner, Switch, useToast } from '../components/ui';
import { LeadAvatar, ScoreBadge, SourceBadge, StatusBadge, TemperatureBadge } from '../components/lead-bits';
import { BookCallModal, QualificationList, StatusSelect } from '../components/lead-actions';
import type { Appointment, Conversation, Lead, Memory, Message } from '../lib/types';

interface InboxItem {
  conversation: Conversation;
  lead: {
    id: string;
    name: string;
    avatarUrl: string | null;
    source: LeadSource;
    status: LeadStatus;
    score: number;
    temperature: LeadTemperature;
    goalSummary: string | null;
    nextAction: string | null;
    optedOut: boolean;
  };
}

const FILTERS: { value: string; label: string }[] = [
  { value: 'all', label: 'Todos' },
  { value: 'new', label: 'Nuevos' },
  { value: 'hot', label: 'Calientes' },
  { value: 'qualified', label: 'Cualificados' },
  { value: 'pending', label: 'Pendientes' },
  { value: 'booked', label: 'Agendados' },
  { value: 'no_reply', label: 'No respondieron' },
  { value: 'clients', label: 'Clientes' },
];

interface Detail {
  conversation: Conversation;
  lead: Lead;
  messages: Message[];
  memories: Memory[];
  appointments: Appointment[];
  connection: { displayName: string; status: string } | null;
}

function MessageList({ messages }: { messages: Message[] }) {
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => endRef.current?.scrollIntoView({ block: 'end' }), [messages.length]);
  let lastDay = '';
  return (
    <div className="thread-messages">
      {messages.map((m) => {
        const day = new Date(m.createdAt).toDateString();
        const showDay = day !== lastDay;
        lastDay = day;
        const failed = m.status === 'failed' || m.status === 'skipped';
        const who = m.senderType === 'kai' ? 'KAI' : m.senderType === 'human' ? 'Tú / equipo' : m.senderType === 'system' ? 'Sistema' : '';
        return (
          <Fragment key={m.id}>
            {showDay && <div className="day-sep">{dayLabel(m.createdAt)}</div>}
            <div className={`msg-row ${m.direction === 'inbound' ? 'in' : 'out'} ${m.senderType === 'kai' ? 'kai' : ''} ${failed ? 'failed' : ''}`}>
              <div className="bubble">{m.content}</div>
              <div className="msg-meta">
                {m.direction === 'outbound' && (m.senderType === 'kai' ? <Sparkles /> : <User />)}
                {who && <span>{who}</span>}
                <span>{timeOnly(m.createdAt)}</span>
                {m.direction === 'outbound' && !failed && m.status !== 'sent' && <span>· {m.status === 'read' ? 'leído' : m.status === 'delivered' ? 'entregado' : m.status}</span>}
                {failed && (
                  <span style={{ color: 'var(--danger)' }}>
                    · {m.status === 'skipped' ? 'no enviado' : 'error'}: {m.error}
                  </span>
                )}
              </div>
            </div>
          </Fragment>
        );
      })}
      <div ref={endRef} />
    </div>
  );
}

function Thread({ conversationId, onBack, onTogglePanel, panelOpen }: { conversationId: string; onBack: () => void; onTogglePanel: () => void; panelOpen: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [text, setText] = useState('');
  const [pauseKai, setPauseKai] = useState(true);
  const { data, isLoading, error } = useQuery({
    queryKey: ['conversation', conversationId],
    queryFn: () => api.get<Detail>(`/conversations/${conversationId}`),
    refetchInterval: 5000,
  });
  const markRead = useMutation({ mutationFn: () => api.post(`/conversations/${conversationId}/read`) });
  useEffect(() => {
    if (data?.conversation.unreadCount) markRead.mutate(undefined, { onSuccess: () => void qc.invalidateQueries({ queryKey: ['inbox'] }) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data?.conversation.unreadCount, conversationId]);

  /** Bandeja, conversación, avisos y panel: lo que cambia cuando se atiende un escalado. */
  const refreshAfterHandoff = () => {
    for (const key of ['conversation', 'inbox', 'inbox-counts', 'alerts', 'dashboard']) void qc.invalidateQueries({ queryKey: [key] });
  };
  const send = useMutation({
    mutationFn: (body: { text: string; pauseKai: boolean }) => api.post<{ delivered: boolean; blockedReason: string | null }>(`/conversations/${conversationId}/messages`, body),
    onSuccess: (r) => {
      if (!r.delivered) toast(`Mensaje no enviado: ${r.blockedReason ?? 'revisa el canal'}`, 'error');
      void qc.invalidateQueries({ queryKey: ['conversation', conversationId] });
      void qc.invalidateQueries({ queryKey: ['inbox'] });
      // Si KAI había escalado la conversación, al entregarse el mensaje el servidor da el escalado por atendido
      // (se cierra el aviso «KAI necesita tu intervención»): se refrescan también los avisos y los contadores.
      if (r.delivered && data?.conversation.handoffActive) refreshAfterHandoff();
    },
    onError: (e) => toast(errorText(e), 'error'),
  });
  const attended = useMutation({
    mutationFn: () => api.post<{ ok: boolean; changed: boolean }>(`/conversations/${conversationId}/handoff-attended`),
    onSuccess: (r) => {
      toast(r.changed ? 'Marcado como atendido. KAI sigue en pausa en esta conversación hasta que se la devuelvas.' : 'Esta conversación ya estaba atendida.');
      refreshAfterHandoff();
    },
    onError: (e) => toast(errorText(e), 'error'),
  });
  const takeOver = useMutation({
    mutationFn: () => api.post(`/conversations/${conversationId}/take-over`),
    onSuccess: () => {
      toast('Has tomado el control. KAI no responderá en esta conversación.');
      void qc.invalidateQueries({ queryKey: ['conversation', conversationId] });
    },
    onError: (e) => toast(errorText(e), 'error'),
  });
  const release = useMutation({
    mutationFn: (replyNow: boolean) => api.post(`/conversations/${conversationId}/release`, { replyNow }),
    onSuccess: () => {
      toast('KAI vuelve a encargarse de esta conversación.');
      void qc.invalidateQueries();
    },
    onError: (e) => toast(errorText(e), 'error'),
  });
  // Un solo envío a la vez: el texto no se borra hasta que el servidor confirma, así que pulsar Enter
  // dos veces seguidas (o Enter y el botón) mandaría el mismo mensaje dos veces al lead.
  // La ref bloquea al instante, sin esperar a que React vuelva a pintar con send.isPending.
  const sendingRef = useRef(false);
  const submit = () => {
    if (!text.trim() || sendingRef.current || send.isPending || data?.lead.optedOut) return;
    sendingRef.current = true;
    const body = { text, pauseKai };
    send.mutate(body, {
      // Se vacía el cuadro solo si no se ha seguido escribiendo mientras se enviaba.
      onSuccess: () => setText((t) => (t === body.text ? '' : t)),
      onSettled: () => {
        sendingRef.current = false;
      },
    });
  };

  if (isLoading) return <div className="thread page-loading"><Spinner /></div>;
  if (error || !data) return <div className="thread"><EmptyState icon={AlertTriangle} title="No se pudo cargar la conversación" description={errorText(error)} /></div>;
  const { conversation: conv, lead } = data;
  const reason = conv.handoffReason as HandoffReason | null;

  return (
    <section className="thread" aria-label={`Conversación con ${lead.name}`}>
      <header className="thread-header">
        <Button variant="ghost" size="sm" iconOnly icon={ArrowLeft} onClick={onBack} className="hide-desktop">
          Volver
        </Button>
        <LeadAvatar name={lead.name} url={lead.avatarUrl} channel={conv.channel} />
        <div className="grow" style={{ minWidth: 0 }}>
          <div className="row" style={{ gap: 8 }}>
            <strong className="ellipsis">{lead.name || 'Sin nombre'}</strong>
            <StatusBadge status={lead.status} />
          </div>
          <div className="subtle small ellipsis">
            {CHANNEL_LABELS[conv.channel]}
            {data.connection ? ` · ${data.connection.displayName}` : ''} · última actividad {timeAgo(conv.lastMessageAt)}
          </div>
        </div>
        {conv.aiEnabled && !conv.handoffActive ? (
          <Button size="sm" icon={Hand} loading={takeOver.isPending} onClick={() => takeOver.mutate()}>
            Tomar el control
          </Button>
        ) : (
          <Button size="sm" variant="primary" icon={Bot} loading={release.isPending} onClick={() => release.mutate(false)}>
            Devolver a KAI
          </Button>
        )}
        <Button variant="ghost" size="sm" iconOnly icon={PanelRight} onClick={onTogglePanel} className="thread-panel-toggle" aria-expanded={panelOpen}>
          Ficha del lead
        </Button>
      </header>
      {conv.handoffActive && (
        <div className="handoff-banner">
          <AlertTriangle />
          <div className="grow">
            <strong>KAI necesita tu intervención.</strong> {reason ? HANDOFF_REASONS[reason] ?? reason : ''}. KAI no responderá hasta que se la devuelvas.
            <div className="xs muted mt-4">
              Si ya lo has resuelto por tu cuenta (por teléfono, en persona…), márcalo como atendido: desaparece de pendientes y KAI sigue en pausa aquí.
            </div>
          </div>
          <div className="row wrap" style={{ gap: 6, justifyContent: 'flex-end' }}>
            <Button size="sm" icon={CheckCheck} loading={attended.isPending} onClick={() => attended.mutate()}>
              Marcar como atendido
            </Button>
            <Button size="sm" icon={Play} loading={release.isPending && release.variables === true} onClick={() => release.mutate(true)}>
              Que KAI responda ahora
            </Button>
          </div>
        </div>
      )}
      {!conv.handoffActive && !conv.aiEnabled && (
        <div className="handoff-banner" style={{ background: 'var(--info-soft)' }}>
          <UserRound style={{ color: 'var(--info)' }} />
          <div className="grow">Estás llevando esta conversación. KAI está en pausa aquí.</div>
        </div>
      )}
      {lead.optedOut && (
        <div className="handoff-banner" style={{ background: 'var(--danger-soft)' }}>
          <AlertTriangle style={{ color: 'var(--danger)' }} />
          <div className="grow">
            Este lead está dado de baja: no recibe mensajes de KAI ni del equipo. Si te pide que vuelvas a escribirle, puedes permitirlo desde su
            ficha, con «Volver a permitir mensajes».
          </div>
        </div>
      )}
      <MessageList messages={data.messages} />
      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <div className="composer-box">
          <textarea
            className="textarea"
            rows={1}
            value={text}
            placeholder={lead.optedOut ? 'Este lead no acepta mensajes' : 'Escribe un mensaje… (Enter para enviar, Mayús+Enter para salto de línea)'}
            disabled={lead.optedOut}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                submit();
              }
            }}
            aria-label="Mensaje"
          />
          <Button type="submit" variant="primary" iconOnly icon={Send} loading={send.isPending} disabled={!text.trim() || lead.optedOut}>
            Enviar
          </Button>
        </div>
        {conv.aiEnabled && !conv.handoffActive && (
          <div className="mt-8 small">
            <Switch checked={pauseKai} onChange={setPauseKai} label={<span className="muted">Pausar a KAI en esta conversación al enviar</span>} />
          </div>
        )}
      </form>
    </section>
  );
}

/**
 * Ficha lateral del lead. En escritorio ancho es una columna fija; en pantallas medianas y móviles se abre
 * superpuesta (overlayOpen) con su propia cabecera para cerrarla, porque tapa la cabecera de la conversación.
 */
function LeadPanel({ conversationId, overlayOpen, onClose }: { conversationId: string; overlayOpen: boolean; onClose: () => void }) {
  const navigate = useNavigate();
  const [booking, setBooking] = useState(false);
  const rootRef = useRef<HTMLElement>(null);
  const { data } = useQuery({ queryKey: ['conversation', conversationId], queryFn: () => api.get<Detail>(`/conversations/${conversationId}`) });
  const settings = useBusinessSettings();
  const tz = settings.data?.business.timezone;
  // Al abrirse superpuesta, el foco pasa una sola vez al botón de cerrar (solo si es visible: en escritorio ancho no lo es).
  // Se espera a que haya datos, pero los refrescos posteriores no vuelven a mover el foco.
  const focusedRef = useRef(false);
  useEffect(() => {
    if (!overlayOpen) {
      focusedRef.current = false;
      return;
    }
    if (focusedRef.current) return;
    const btn = rootRef.current?.querySelector<HTMLElement>('.lead-panel-head button');
    if (!btn) return;
    focusedRef.current = true;
    if (btn.offsetParent !== null) btn.focus();
  }, [overlayOpen, data]);
  if (!data) return <aside className="lead-panel" ref={rootRef} />;
  const { lead, memories, appointments } = data;
  const upcoming = appointments.find((a) => a.status === 'scheduled' && new Date(a.endsAt) > new Date());
  return (
    <aside className="lead-panel" aria-label="Ficha del lead" ref={rootRef}>
      <div className="lead-panel-head">
        <strong>Ficha del lead</strong>
        <Button size="sm" variant="ghost" icon={X} onClick={onClose}>
          Cerrar
        </Button>
      </div>
      <div className="row" style={{ gap: 10 }}>
        <LeadAvatar name={lead.name} url={lead.avatarUrl} size={44} />
        <div className="grow" style={{ minWidth: 0 }}>
          <strong className="ellipsis" style={{ display: 'block' }}>
            {lead.name || 'Sin nombre'}
          </strong>
          <SourceBadge source={lead.source} />
        </div>
        <ScoreBadge score={lead.score} />
      </div>
      <div className="row wrap" style={{ gap: 6 }}>
        <TemperatureBadge temperature={lead.temperature} />
        {lead.isTest && <span className="badge">Prueba</span>}
        {lead.optedOut && <span className="badge badge-danger">Dado de baja</span>}
      </div>
      <div className="callout" style={{ padding: '10px 12px' }}>
        <Sparkles style={{ color: 'var(--accent-text)' }} />
        <div>
          <div className="subtle xs">Próxima acción</div>
          <strong className="small">{nextActionFor(lead, data.conversation, upcoming, tz, settings.data?.aiSettings.autopilotEnabled ?? true)}</strong>
        </div>
      </div>
      <div className="field">
        <span className="label">Etapa</span>
        <StatusSelect leadId={lead.id} status={lead.status} />
      </div>
      {lead.goalSummary && (
        <div>
          <div className="section-title">Objetivo</div>
          <p className="mt-4">{lead.goalSummary}</p>
        </div>
      )}
      <div>
        <div className="row-between">
          <span className="section-title">Llamada</span>
          {!upcoming && (
            <Button size="sm" variant="ghost" icon={CalendarPlus} onClick={() => setBooking(true)}>
              Agendar
            </Button>
          )}
        </div>
        <p className="mt-4 small">{upcoming ? dateTime(upcoming.startsAt, tz) : <span className="subtle">Sin llamada agendada</span>}</p>
        {upcoming?.meetingUrl && (
          <a className="small" href={upcoming.meetingUrl} target="_blank" rel="noreferrer">
            Enlace de la videollamada
          </a>
        )}
      </div>
      <div>
        <div className="section-title" style={{ marginBottom: 4 }}>
          Cualificación
        </div>
        <QualificationList rules={settings.data?.qualificationRules ?? []} qualification={lead.qualification} />
      </div>
      <div>
        <div className="section-title row" style={{ marginBottom: 6 }}>
          <Brain size={13} /> Memoria de KAI
        </div>
        {memories.length === 0 ? (
          <p className="subtle small">KAI guardará aquí lo importante que te cuente el lead (eventos, horarios, preferencias…).</p>
        ) : (
          <ul style={{ margin: 0, paddingLeft: 18 }} className="small">
            {memories.map((m) => (
              <li key={m.id} style={{ marginBottom: 4 }}>
                {m.content}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div>
        <div className="section-title" style={{ marginBottom: 6 }}>
          Contacto
        </div>
        <dl className="kv">
          {lead.phone && (
            <>
              <dt>Teléfono</dt>
              <dd>{lead.phone}</dd>
            </>
          )}
          {lead.email && (
            <>
              <dt>Email</dt>
              <dd>{lead.email}</dd>
            </>
          )}
          {lead.instagramUsername && (
            <>
              <dt>Instagram</dt>
              <dd>@{lead.instagramUsername}</dd>
            </>
          )}
          <dt>Entró</dt>
          <dd>{dateTime(lead.createdAt, tz)}</dd>
          {lead.sourceDetail && (
            <>
              <dt>Campaña</dt>
              <dd>{lead.sourceDetail}</dd>
            </>
          )}
        </dl>
      </div>
      <Button onClick={() => navigate(`/app/leads/${lead.id}`)}>Ver ficha completa</Button>
      <BookCallModal open={booking} onClose={() => setBooking(false)} leadId={lead.id} conversationId={conversationId} />
    </aside>
  );
}

export default function Inbox() {
  const { conversationId } = useParams();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const filter = params.get('filtro') ?? 'all';
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [showPanel, setShowPanel] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(search), 300);
    return () => clearTimeout(t);
  }, [search]);
  // La ficha superpuesta se cierra al cambiar de conversación…
  useEffect(() => setShowPanel(false), [conversationId]);
  // …con su botón «Cerrar», pulsando fuera o con Escape; el foco vuelve al botón que la abrió.
  const closePanel = () => {
    setShowPanel(false);
    document.querySelector<HTMLElement>('.thread-panel-toggle')?.focus();
  };
  useEffect(() => {
    if (!showPanel) return;
    const onKey = (e: KeyboardEvent) => {
      // Si hay un modal abierto encima (p. ej. «Agendar llamada»), Escape cierra ese modal, no la ficha.
      if (e.key === 'Escape' && !document.querySelector('.overlay')) {
        setShowPanel(false);
        document.querySelector<HTMLElement>('.thread-panel-toggle')?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [showPanel]);
  const settings = useBusinessSettings();
  const tz = settings.data?.business.timezone;

  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ['inbox', filter, debounced],
    queryFn: () => api.get<{ items: InboxItem[]; counts: Record<string, number> }>('/inbox', { filter, search: debounced, limit: 100 }),
    refetchInterval: 10_000,
  });
  const items = data?.items ?? [];
  const activeId = conversationId ?? null;
  const counts = data?.counts ?? {};

  const list = useMemo(
    () =>
      items.map((it) => (
        <button key={it.conversation.id} className={`inbox-item ${activeId === it.conversation.id ? 'active' : ''}`} onClick={() => navigate(`/app/inbox/${it.conversation.id}${filter !== 'all' ? `?filtro=${filter}` : ''}`)}>
          <LeadAvatar name={it.lead.name} url={it.lead.avatarUrl} channel={it.conversation.channel} size={40} />
          <div className="grow" style={{ minWidth: 0 }}>
            <div className="row-between">
              <span className="name ellipsis">{it.lead.name || 'Sin nombre'}</span>
              <span className="subtle xs" style={{ flexShrink: 0 }}>
                {shortTime(it.conversation.lastMessageAt)}
              </span>
            </div>
            <div className="row" style={{ gap: 6 }}>
              <span className="preview ellipsis grow">{it.conversation.lastMessagePreview ?? 'Sin mensajes'}</span>
              {it.conversation.unreadCount > 0 && <span className="unread-dot" aria-label="Sin leer" />}
            </div>
            <div className="row wrap mt-4" style={{ gap: 5 }}>
              {it.conversation.handoffActive && <span className="badge badge-warning">Te necesita</span>}
              {it.lead.optedOut && <span className="badge badge-danger">Dado de baja</span>}
              <StatusBadge status={it.lead.status} />
              <TemperatureBadge temperature={it.lead.temperature} />
              <ScoreBadge score={it.lead.score} />
              <SourceBadge source={it.lead.source} />
            </div>
            <div className="subtle xs ellipsis mt-4">
              {it.lead.goalSummary ? `${it.lead.goalSummary} · ` : ''}
              {nextActionFor(it.lead, it.conversation, null, tz, settings.data?.aiSettings.autopilotEnabled ?? true)}
            </div>
          </div>
        </button>
      )),
    [items, activeId, navigate, filter, tz],
  );

  return (
    <div className={`inbox ${activeId ? 'has-active' : ''} ${showPanel ? 'show-panel' : ''}`}>
      <section className="inbox-list" aria-label="Conversaciones">
        <div className="inbox-filters">
          <div className="input-group">
            <Search />
            <input className="input" placeholder="Buscar por nombre, teléfono o @usuario" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Buscar" />
          </div>
          <div className="chips" style={{ maxHeight: 72, overflowY: 'auto' }}>
            {FILTERS.map((f) => (
              <button key={f.value} className="chip" aria-pressed={filter === f.value} onClick={() => setParams(f.value === 'all' ? {} : { filtro: f.value })}>
                {f.label}
                <span className="count">{counts[f.value] ?? 0}</span>
              </button>
            ))}
          </div>
        </div>
        <div className="inbox-items">
          {isLoading && (
            <div className="page-loading" style={{ minHeight: 200 }}>
              <Spinner />
            </div>
          )}
          {!isLoading && error && !data && (
            <EmptyState
              icon={AlertTriangle}
              title="No se pudieron cargar las conversaciones"
              description={errorText(error)}
              action={
                <Button icon={RotateCw} loading={isFetching} onClick={() => void refetch()}>
                  Reintentar
                </Button>
              }
            />
          )}
          {!isLoading && data && items.length === 0 && <EmptyState icon={InboxIcon} title="No hay conversaciones" description={filter === 'all' ? 'Cuando un lead escriba por WhatsApp o Instagram, o entre por un formulario, aparecerá aquí.' : 'Ninguna conversación coincide con este filtro.'} />}
          {list}
        </div>
      </section>
      {activeId ? (
        <>
          <Thread key={activeId} conversationId={activeId} onBack={() => navigate('/app/inbox')} onTogglePanel={() => setShowPanel((s) => !s)} panelOpen={showPanel} />
          {showPanel && <div className="inbox-panel-backdrop" onClick={closePanel} aria-hidden />}
          <LeadPanel key={`panel-${activeId}`} conversationId={activeId} overlayOpen={showPanel} onClose={closePanel} />
        </>
      ) : (
        <section className="thread" style={{ display: 'grid', placeItems: 'center', gridColumn: 'span 2' }}>
          <Card className="card-tight" title={undefined}>
            <EmptyState icon={Sparkles} title="Selecciona una conversación" description="KAI responde, cualifica y agenda por ti. Entra en cualquier conversación para ver qué está pasando o tomar el control." />
          </Card>
        </section>
      )}
    </div>
  );
}
