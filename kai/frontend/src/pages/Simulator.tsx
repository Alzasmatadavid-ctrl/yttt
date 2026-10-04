import { useEffect, useRef, useState, Fragment } from 'react';
import { useNavigate, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Bot, Brain, FlaskConical, FormInput, Play, Plus, Repeat, Send, Sparkles, Trash2, User, Wrench } from 'lucide-react';
import { HANDOFF_REASONS, type HandoffReason } from '@shared';
import { api, errorText } from '../lib/api';
import { dateTime, timeOnly } from '../lib/format';
import { Button, Callout, Card, EmptyState, Field, Input, Modal, PageHeader, Spinner, useToast } from '../components/ui';
import { ScoreBadge, StatusBadge, TemperatureBadge } from '../components/lead-bits';
import { QualificationList } from '../components/lead-actions';
import type { Appointment, Conversation, Lead, Memory, Message, QualificationRule, SettingsResponse } from '../lib/types';

interface SimDetail {
  conversation: Conversation;
  lead: Lead;
  messages: Message[];
  memories: Memory[];
  appointments: Appointment[];
  qualificationRules: QualificationRule[];
  scoreBreakdown: { key: string; weight: number; earned: number }[];
  pendingFollowUps: { id: string; step: number; scheduledFor: string }[];
}

/** Por qué KAI no respondió en el simulador, explicado para el entrenador (los códigos vienen del motor del setter). */
const SKIP_REASONS: Record<string, string> = {
  autopilot_off: 'KAI está en pausa para todo el negocio: reactívalo desde «KAI en pausa», en el menú lateral.',
  ai_disabled: 'En esta prueba la conversación la lleva una persona. Pulsa «Devolver a KAI» (arriba del chat) para que vuelva a responder.',
  handoff_active: 'KAI pasó esta conversación a una persona. Pulsa «Devolver a KAI» para que vuelva a responder.',
  taken_over: 'Alguien tomó el control de la conversación mientras KAI preparaba la respuesta.',
  already_client: 'Este lead ya es cliente: KAI no le escribe como setter.',
  nothing_to_answer: 'No había ningún mensaje nuevo del lead al que responder.',
  superseded: 'Llegó otro mensaje mientras KAI escribía: responderá a todos juntos.',
  business_suspended: 'La cuenta está desactivada: KAI no responde a ningún lead.',
  limit_reached: 'Se ha alcanzado el límite del plan este mes: KAI no responde hasta que amplíes el plan o empiece el mes que viene.',
  opted_out: 'Este lead de prueba pidió no recibir más mensajes, así que KAI ya no le escribe. Crea una prueba nueva para seguir probando.',
  disabled: 'KAI está en pausa en esta conversación.',
  conversation_started: 'La conversación ya había empezado, así que KAI no envía el primer mensaje.',
};

const skipReasonText = (reason: string) => SKIP_REASONS[reason] ?? 'KAI ha decidido no responder a este mensaje.';

/** Señales que KAI detecta en el mensaje del lead, explicadas para el entrenador (las claves vienen del análisis). */
const FLAG_LABELS: Record<string, string> = {
  humanRequest: 'Pide hablar con una persona',
  asksIfBot: 'Pregunta si es un bot',
  medical: 'Tema de salud',
  angry: 'Está molesto',
  optOut: 'Pide que no le escriban más',
  asksPrice: 'Pregunta el precio',
  wantsCall: 'Quiere la llamada',
  declinesCall: 'No quiere llamada',
  complexNegotiation: 'Negociación complicada',
  outOfScope: 'Pide algo que no ofreces',
  technicalIssue: 'Problema técnico',
  wantsReschedule: 'Quiere cambiar la llamada',
  wantsCancel: 'Quiere cancelar la llamada',
  asksQuestion: 'Hace una pregunta',
};

/** Lo que hizo KAI con sus herramientas (agenda, reservas, escalado), en lenguaje del entrenador. */
const TOOL_LABELS: Record<string, string> = {
  get_available_slots: 'Consultó tu agenda',
  book_call: 'Reservó la llamada',
  reschedule_call: 'Cambió la llamada de hora',
  cancel_call: 'Canceló la llamada',
  request_human: 'Pidió que intervenga una persona',
};

const DIRECTIVE_LABELS: Record<string, string> = {
  greet_and_ask: 'Saludar y empezar a conocerle',
  ask_qualification: 'Seguir cualificando',
  handle_objection: 'Gestionar objeción',
  price_contextualize: 'Contextualizar antes del precio',
  share_price: 'Dar el precio real',
  propose_call: 'Proponer la llamada',
  offer_slots: 'Ofrecer horarios reales',
  clarify_slot: 'Concretar horario',
  book_slot: 'Reservar la llamada',
  reschedule: 'Reprogramar',
  post_booking: 'Post-reserva',
  disqualify_kindly: 'No encaja (con honestidad)',
  continue_without_call: 'Seguir sin llamada',
  reassure_call: 'Resolver dudas sobre la llamada',
  first_contact: 'Primer contacto',
  cancel_booking: 'Cancelar la llamada',
  handoff: 'Pasar a una persona',
  medical_notice: 'Aviso por tema médico',
  medical_redirect: 'Derivar a un profesional sanitario',
  opt_out_ack: 'Confirmar la baja',
};

function NewConversation({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (id: string) => void }) {
  const toast = useToast();
  const [name, setName] = useState('Carlos');
  const [mode, setMode] = useState<'chat' | 'form'>('chat');
  const [goal, setGoal] = useState('Perder grasa y ponerme en forma');
  const create = useMutation({
    mutationFn: () =>
      mode === 'chat'
        ? api.post<{ conversationId: string }>('/simulator/conversations', { leadName: name })
        : api.post<{ conversationId: string }>('/simulator/form-lead', { name, goal }),
    onSuccess: (r) => {
      onCreated(r.conversationId);
      onClose();
    },
    onError: (e) => toast(errorText(e), 'error'),
  });
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Nueva prueba"
      footer={
        <>
          <Button onClick={onClose}>Cancelar</Button>
          <Button variant="primary" loading={create.isPending} disabled={!name.trim()} onClick={() => create.mutate()}>
            Empezar
          </Button>
        </>
      }
    >
      <div className="col gap-16">
        <div className="option-grid">
          <button className="option" aria-pressed={mode === 'chat'} onClick={() => setMode('chat')}>
            <User />
            <strong>El lead escribe primero</strong>
            <span className="subtle small">Como un DM de Instagram o un WhatsApp.</span>
          </button>
          <button className="option" aria-pressed={mode === 'form'} onClick={() => setMode('form')}>
            <FormInput />
            <strong>Lead de formulario</strong>
            <span className="subtle small">Deja sus datos en un anuncio y KAI le escribe primero.</span>
          </button>
        </div>
        <Field label="Nombre del lead de prueba">
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        {mode === 'form' && (
          <Field label="Objetivo que indicó en el formulario">
            <Input value={goal} onChange={(e) => setGoal(e.target.value)} />
          </Field>
        )}
      </div>
    </Modal>
  );
}

export default function Simulator() {
  const { conversationId } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const [text, setText] = useState('');
  const [creating, setCreating] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => api.get<SettingsResponse>('/settings') });
  const list = useQuery({ queryKey: ['sim-list'], queryFn: () => api.get<{ conversations: { id: string; leadName: string; score: number; status: string; preview: string | null; updatedAt: string }[] }>('/simulator/conversations') });
  const detail = useQuery({
    queryKey: ['sim', conversationId],
    queryFn: () => api.get<SimDetail>(`/simulator/conversations/${conversationId}`),
    enabled: Boolean(conversationId),
  });
  const sendMsg = useMutation({
    mutationFn: (t: string) => api.post<{ result: { status: string; reason?: string; messageId?: string } }>(`/simulator/conversations/${conversationId}/messages`, { text: t }),
    onSuccess: (r) => {
      setText('');
      // Si el lead acaba de pedir la baja, KAI se despide (hay mensaje) y no hace falta avisar; si ya estaba de baja, sí.
      const justOptedOut = r.result.reason === 'opted_out' && Boolean(r.result.messageId);
      // Con la baja, KAI queda además en pausa en la conversación: el motor responde «ai_disabled», pero el motivo real es la baja.
      const reason = r.result.reason === 'ai_disabled' && detail.data?.lead.optedOut ? 'opted_out' : r.result.reason;
      if (r.result.status === 'skipped' && reason && !justOptedOut) toast(`KAI no respondió. ${skipReasonText(reason)}`, 'info');
      void qc.invalidateQueries({ queryKey: ['sim', conversationId] });
      void qc.invalidateQueries({ queryKey: ['sim-list'] });
    },
    onError: (e) => toast(errorText(e), 'error'),
  });
  const followUp = useMutation({
    mutationFn: () => api.post(`/simulator/conversations/${conversationId}/follow-up`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['sim', conversationId] }),
    onError: (e) => toast(errorText(e), 'error'),
  });
  const release = useMutation({
    mutationFn: () => api.post(`/conversations/${conversationId}/release`, { replyNow: false }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['sim', conversationId] }),
    onError: (e) => toast(errorText(e), 'error'),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.del(`/simulator/conversations/${id}`),
    onSuccess: (_r, id) => {
      void qc.invalidateQueries({ queryKey: ['sim-list'] });
      // Solo se sale de la prueba abierta si es la que se ha borrado.
      if (id === conversationId) navigate('/app/simulador');
    },
    onError: (e) => toast(errorText(e), 'error'),
  });
  useEffect(() => endRef.current?.scrollIntoView({ block: 'end' }), [detail.data?.messages.length, sendMsg.isPending]);

  const d = detail.data;
  const lastKai = [...(d?.messages ?? [])].reverse().find((m) => m.senderType === 'kai');
  const lastInbound = [...(d?.messages ?? [])].reverse().find((m) => m.direction === 'inbound');
  const analysis = lastInbound?.metadata.analysis as { engine?: string; summary?: string; flags?: Record<string, boolean>; objectionKey?: string | null } | undefined;
  const toolCalls = (lastKai?.metadata.toolCalls as { name: string; ok: boolean; input: Record<string, unknown> }[] | undefined) ?? [];
  const ai = settings.data?.ai;
  const tz = settings.data?.business.timezone;
  const objectionLabel = analysis?.objectionKey ? settings.data?.objections.find((o) => o.key === analysis.objectionKey)?.label ?? 'detectada' : null;

  return (
    <div className="page" style={{ maxWidth: 'none' }}>
      <PageHeader
        title="Simulador"
        description="Escribe como si fueras un lead y mira exactamente cómo respondería KAI con tu configuración y tu agenda reales. Las pruebas no cuentan en tus métricas."
        actions={
          <Button variant="primary" icon={Plus} onClick={() => setCreating(true)}>
            Nueva prueba
          </Button>
        }
      />
      {ai && (
        <div style={{ marginBottom: 16 }}>
          {ai.mode === 'simulated' ? (
            <Callout tone="warning" icon={Wrench}>
              <strong>Modo simulación:</strong> no hay API key de IA configurada, así que KAI usa un motor de reglas para que puedas probar todo el sistema. Con la clave de Anthropic configurada, las respuestas las redacta Claude adaptándose a tu estilo.
            </Callout>
          ) : (
            <Callout tone="accent" icon={Sparkles}>
              IA activa: <strong>{ai.provider}</strong> · modelo {ai.mainModel} (respuestas) y {ai.fastModel} (análisis y control de calidad).
            </Callout>
          )}
        </div>
      )}
      {/* Tres columnas en escritorio; en pantallas pequeñas, el chat primero y los paneles debajo (layout.css → .sim-layout). */}
      <div className="sim-layout">
        <Card title="Pruebas" icon={FlaskConical} className="card-tight">
          {list.data?.conversations.length === 0 && <p className="muted small">Crea una prueba para empezar.</p>}
          <div className="col gap-4">
            {list.data?.conversations.map((c) => (
              <div key={c.id} className="row" style={{ gap: 4 }}>
                <button className={`inbox-item ${c.id === conversationId ? 'active' : ''}`} style={{ borderRadius: 10, border: '1px solid var(--border)', padding: '8px 10px' }} onClick={() => navigate(`/app/simulador/${c.id}`)}>
                  <div className="grow" style={{ minWidth: 0 }}>
                    <div className="row-between">
                      <strong className="ellipsis small">{c.leadName}</strong>
                      <ScoreBadge score={c.score} />
                    </div>
                    <div className="subtle xs ellipsis">{c.preview ?? 'Sin mensajes'}</div>
                  </div>
                </button>
                <Button variant="ghost" size="sm" iconOnly icon={Trash2} onClick={() => remove.mutate(c.id)}>
                  Borrar prueba
                </Button>
              </div>
            ))}
          </div>
        </Card>

        <Card flush className="col sim-chat-card" title={undefined}>
          {!conversationId ? (
            <EmptyState icon={Bot} title="Prueba a KAI" description="Crea una prueba y escribe como lo haría un cliente potencial: “Hola, vi tu anuncio y quiero perder grasa”." action={<Button variant="primary" icon={Plus} onClick={() => setCreating(true)}>Nueva prueba</Button>} />
          ) : detail.isLoading ? (
            <div className="page-loading" style={{ minHeight: 300 }}>
              <Spinner />
            </div>
          ) : !d ? (
            // Prueba borrada o enlace antiguo: se explica en vez de dejar el chat cargando para siempre.
            <EmptyState
              icon={AlertTriangle}
              title="No se pudo abrir esta prueba"
              description={errorText(detail.error)}
              action={
                <Button variant="primary" icon={Plus} onClick={() => setCreating(true)}>
                  Nueva prueba
                </Button>
              }
            />
          ) : (
            <div className="sim-chat">
              <div className="thread-header">
                <strong className="ellipsis">{d.lead.name}</strong>
                <StatusBadge status={d.lead.status} />
                <div className="grow" />
                {/* KAI no responde si la prueba está escalada o en manos de una persona: se le devuelve desde aquí.
                    Con la baja no sirve (KAI no escribe a quien la pidió): se explica abajo. */}
                {(d.conversation.handoffActive || !d.conversation.aiEnabled) && !d.lead.optedOut && (
                  <Button size="sm" icon={Play} loading={release.isPending} onClick={() => release.mutate()}>
                    Devolver a KAI
                  </Button>
                )}
              </div>
              {d.conversation.handoffActive && (
                <div className="handoff-banner">
                  <Bot />
                  <div className="grow">
                    <strong>KAI ha pasado la conversación a una persona:</strong> {HANDOFF_REASONS[d.conversation.handoffReason as HandoffReason] ?? d.conversation.handoffReason}
                  </div>
                </div>
              )}
              {d.lead.optedOut && (
                <div className="handoff-banner" style={{ background: 'var(--danger-soft)' }}>
                  <AlertTriangle style={{ color: 'var(--danger)' }} />
                  <div className="grow">
                    <strong>Este lead de prueba pidió la baja.</strong> KAI ya no le escribe, igual que haría con un lead real. Para seguir probando, crea una prueba
                    nueva.
                  </div>
                  <Button size="sm" icon={Plus} onClick={() => setCreating(true)}>
                    Nueva prueba
                  </Button>
                </div>
              )}
              <div className="thread-messages">
                {d.messages.map((m) => (
                  <Fragment key={m.id}>
                    <div className={`msg-row ${m.direction === 'inbound' ? 'in' : 'out'} ${m.senderType === 'kai' ? 'kai' : ''}`}>
                      <div className="bubble">{m.content}</div>
                      <div className="msg-meta">
                        {m.direction === 'inbound' ? 'Lead (tú)' : m.senderType === 'kai' ? 'KAI' : 'Equipo'} · {timeOnly(m.createdAt, tz)}
                        {typeof m.metadata.directive === 'string' && <span>· {DIRECTIVE_LABELS[m.metadata.directive] ?? m.metadata.directive}</span>}
                        {typeof m.metadata.attempts === 'number' && m.metadata.attempts > 1 && (
                          <span>
                            · rehecho {m.metadata.attempts - 1 === 1 ? '1 vez' : `${m.metadata.attempts - 1} veces`} por el control de calidad
                          </span>
                        )}
                        {typeof m.metadata.step === 'number' && <span>· seguimiento {m.metadata.step}</span>}
                      </div>
                    </div>
                  </Fragment>
                ))}
                {sendMsg.isPending && (
                  <>
                    <div className="msg-row in">
                      <div className="bubble">{sendMsg.variables}</div>
                    </div>
                    <div className="msg-row out kai">
                      <div className="bubble">
                        <Spinner size={14} />
                      </div>
                    </div>
                  </>
                )}
                <div ref={endRef} />
              </div>
              <form
                className="composer"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (text.trim() && !sendMsg.isPending) sendMsg.mutate(text.trim());
                }}
              >
                <div className="composer-box">
                  <input className="input" value={text} onChange={(e) => setText(e.target.value)} placeholder="Escribe como si fueras el lead…" aria-label="Mensaje del lead" disabled={sendMsg.isPending} />
                  <Button type="submit" variant="primary" iconOnly icon={Send} loading={sendMsg.isPending} disabled={!text.trim()}>
                    Enviar
                  </Button>
                </div>
              </form>
            </div>
          )}
        </Card>

        <div className="col gap-12 sim-side">
          {d && (
            <>
              <Card title="Lead" className="card-tight">
                <div className="row wrap" style={{ gap: 6 }}>
                  <ScoreBadge score={d.lead.score} />
                  <TemperatureBadge temperature={d.lead.temperature} />
                  <StatusBadge status={d.lead.status} />
                </div>
                {d.appointments.filter((a) => a.status === 'scheduled').map((a) => (
                  <p key={a.id} className="small mt-8">
                    📅 Llamada reservada: <strong>{dateTime(a.startsAt, tz)}</strong>
                  </p>
                ))}
                <div className="mt-12">
                  <QualificationList rules={d.qualificationRules} qualification={d.lead.qualification} />
                </div>
              </Card>
              <Card title="Qué ha entendido KAI" icon={Brain} className="card-tight">
                {analysis ? (
                  <div className="col gap-4 small">
                    <span className="subtle xs">Motor: {analysis.engine === 'llm' ? 'IA' : 'reglas'}</span>
                    {analysis.summary && analysis.engine === 'llm' && <p>{analysis.summary}</p>}
                    <div className="chips">
                      {Object.entries(analysis.flags ?? {})
                        .filter(([, v]) => v)
                        .map(([k]) => (
                          <span key={k} className="badge badge-info">
                            {FLAG_LABELS[k] ?? 'Otra señal'}
                          </span>
                        ))}
                      {objectionLabel && <span className="badge badge-warning">Objeción: {objectionLabel}</span>}
                    </div>
                  </div>
                ) : (
                  <p className="muted small">Escribe un mensaje para ver el análisis.</p>
                )}
                {toolCalls.length > 0 && (
                  <div className="mt-12">
                    <div className="section-title" style={{ marginBottom: 6 }}>
                      Qué ha hecho KAI
                    </div>
                    <div className="col gap-4">
                      {toolCalls.map((t, i) => (
                        <div key={i} className="row small" style={{ gap: 6 }}>
                          <span className={`badge ${t.ok ? 'badge-success' : 'badge-danger'}`}>{t.ok ? 'Hecho' : 'Falló'}</span>
                          <span>{TOOL_LABELS[t.name] ?? 'Otra acción'}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {d.memories.length > 0 && (
                  <div className="mt-12">
                    <div className="section-title" style={{ marginBottom: 6 }}>
                      Memoria
                    </div>
                    <ul style={{ margin: 0, paddingLeft: 18 }} className="small">
                      {d.memories.map((m) => (
                        <li key={m.id}>{m.content}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </Card>
              <Card title="Seguimiento automático" icon={Repeat} className="card-tight">
                <p className="muted small">
                  {d.pendingFollowUps.length
                    ? `Programado el paso ${d.pendingFollowUps[0].step} para ${dateTime(d.pendingFollowUps[0].scheduledFor, tz)}.`
                    : 'No hay seguimientos programados ahora mismo.'}
                </p>
                <Button size="sm" className="mt-8" icon={Play} loading={followUp.isPending} onClick={() => followUp.mutate()}>
                  Simular que el lead no responde
                </Button>
              </Card>
            </>
          )}
        </div>
      </div>
      <NewConversation open={creating} onClose={() => setCreating(false)} onCreated={(id) => { void qc.invalidateQueries({ queryKey: ['sim-list'] }); navigate(`/app/simulador/${id}`); }} />
    </div>
  );
}
