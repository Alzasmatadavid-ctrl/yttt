import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Brain, CalendarPlus, ClipboardCheck, History, MessagesSquare, Plus, Repeat, Save, Target, Trash2, UserRound, X } from 'lucide-react';
import { leadStatusLabel, type LeadStatus } from '@shared';
import { api, errorText } from '../lib/api';
import { dateTime, money, timeAgo } from '../lib/format';
import { Button, Card, ConfirmDialog, EmptyState, Field, Input, PageLoading, Textarea, useToast, TagInput } from '../components/ui';
import { LeadAvatar, ScoreBadge, SourceBadge, StatusBadge, TemperatureBadge } from '../components/lead-bits';
import { BookCallModal, OutcomeModal, QualificationList, StatusSelect } from '../components/lead-actions';
import type { Appointment, Conversation, Lead, Memory, QualificationRule } from '../lib/types';

interface Profile {
  lead: Lead;
  memories: Memory[];
  events: { id: string; type: string; actorType: string; data: Record<string, unknown>; createdAt: string }[];
  appointments: Appointment[];
  conversations: Conversation[];
  qualificationRules: QualificationRule[];
  scoreBreakdown: { key: string; weight: number; earned: number }[];
  followUps: { followUp: { id: string; step: number; status: string; scheduledFor: string; reason: string; note: string | null; sentAt: string | null } }[];
}

const EVENT_LABELS: Record<string, string> = {
  created: 'Lead creado',
  status_changed: 'Cambio de etapa',
  message_in: 'Mensaje del lead',
  message_out: 'Mensaje enviado',
  score_changed: 'Puntuación actualizada',
  call_booked: 'Llamada agendada',
  call_cancelled: 'Llamada cancelada',
  call_completed: 'Llamada realizada',
  reminder_sent: 'Recordatorio enviado',
  no_show: 'No se presentó',
  no_show_message_sent: 'Mensaje de no-show enviado',
  followup_sent: 'Seguimiento enviado',
  handoff: 'KAI pidió intervención humana',
  opted_out: 'Pidió no recibir mensajes',
};

const ACTOR_LABELS: Record<string, string> = { kai: 'KAI', human: 'Equipo', system: 'Sistema', lead: 'Lead', integration: 'Integración' };

function describeEvent(e: Profile['events'][number]) {
  if (e.type === 'status_changed') return `${leadStatusLabel(e.data.from as LeadStatus)} → ${leadStatusLabel(e.data.to as LeadStatus)}`;
  if (e.type === 'score_changed') return `${e.data.from} → ${e.data.to}`;
  if (e.type === 'created') return `Origen: ${String(e.data.source ?? '')}`;
  if (e.type === 'handoff') return String(e.data.detail ?? e.data.reason ?? '');
  return '';
}

export default function LeadDetail() {
  const { leadId } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const [booking, setBooking] = useState(false);
  const [outcomeFor, setOutcomeFor] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [newMemory, setNewMemory] = useState('');
  const { data, isLoading, error } = useQuery({ queryKey: ['lead', leadId], queryFn: () => api.get<Profile>(`/leads/${leadId}`), enabled: Boolean(leadId) });
  const [form, setForm] = useState({ name: '', phone: '', email: '', instagramUsername: '', notes: '', tags: [] as string[] });
  useEffect(() => {
    if (data?.lead)
      setForm({ name: data.lead.name, phone: data.lead.phone ?? '', email: data.lead.email ?? '', instagramUsername: data.lead.instagramUsername ?? '', notes: data.lead.notes, tags: data.lead.tags });
  }, [data?.lead]);

  const invalidate = () => void qc.invalidateQueries({ queryKey: ['lead', leadId] });
  const save = useMutation({
    mutationFn: () => api.patch(`/leads/${leadId}`, { ...form, phone: form.phone || null, email: form.email || null, instagramUsername: form.instagramUsername || null }),
    onSuccess: () => {
      toast('Datos guardados');
      invalidate();
    },
    onError: (e) => toast(errorText(e), 'error'),
  });
  const addMemory = useMutation({
    mutationFn: () => api.post(`/leads/${leadId}/memories`, { content: newMemory, kind: 'fact' }),
    onSuccess: () => {
      setNewMemory('');
      invalidate();
    },
    onError: (e) => toast(errorText(e), 'error'),
  });
  const delMemory = useMutation({ mutationFn: (id: string) => api.del(`/leads/${leadId}/memories/${id}`), onSuccess: invalidate });
  const del = useMutation({
    mutationFn: () => api.del(`/leads/${leadId}`),
    onSuccess: () => {
      toast('Lead eliminado');
      void qc.invalidateQueries({ queryKey: ['leads'] });
      navigate('/app/leads');
    },
    onError: (e) => toast(errorText(e), 'error'),
  });
  const cancelAppt = useMutation({
    mutationFn: (id: string) => api.post(`/agenda/appointments/${id}/cancel`, { reason: 'Cancelada por el equipo' }),
    onSuccess: () => {
      toast('Llamada cancelada');
      invalidate();
    },
    onError: (e) => toast(errorText(e), 'error'),
  });

  if (isLoading) return <PageLoading />;
  if (error || !data) return <div className="page"><EmptyState icon={UserRound} title="Lead no encontrado" description={errorText(error)} action={<Button onClick={() => navigate('/app/leads')}>Volver a leads</Button>} /></div>;
  const { lead } = data;
  const conversation = data.conversations.find((c) => c.channel !== 'web') ?? data.conversations[0];
  const upcoming = data.appointments.find((a) => a.status === 'scheduled' && new Date(a.endsAt) > new Date());
  const totalWeight = data.scoreBreakdown.reduce((s, b) => s + b.weight, 0) || 1;
  const set = (k: 'name' | 'phone' | 'email' | 'instagramUsername' | 'notes') => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));

  return (
    <div className="page">
      <Button variant="ghost" size="sm" icon={ArrowLeft} onClick={() => navigate(-1)}>
        Volver
      </Button>
      <div className="row-between wrap mt-12" style={{ marginBottom: 20 }}>
        <div className="row" style={{ gap: 14 }}>
          <LeadAvatar name={lead.name} url={lead.avatarUrl} size={56} channel={lead.source} />
          <div>
            <h1>{lead.name || 'Sin nombre'}</h1>
            <div className="row wrap mt-4" style={{ gap: 6 }}>
              <StatusBadge status={lead.status} />
              <TemperatureBadge temperature={lead.temperature} />
              <ScoreBadge score={lead.score} />
              <SourceBadge source={lead.source} />
              {lead.isTest && <span className="badge">Prueba</span>}
              {lead.optedOut && <span className="badge badge-danger">No contactar</span>}
            </div>
          </div>
        </div>
        <div className="row wrap">
          {conversation && (
            <Button icon={MessagesSquare} onClick={() => navigate(conversation.channel === 'web' ? `/app/simulador/${conversation.id}` : `/app/inbox/${conversation.id}`)}>
              Conversación
            </Button>
          )}
          {!upcoming && (
            <Button icon={CalendarPlus} onClick={() => setBooking(true)}>
              Agendar llamada
            </Button>
          )}
          <div style={{ width: 190 }}>
            <StatusSelect leadId={lead.id} status={lead.status} onChanged={invalidate} />
          </div>
          <Button variant="danger" iconOnly icon={Trash2} onClick={() => setConfirmDelete(true)}>
            Eliminar lead
          </Button>
        </div>
      </div>

      <div className="grid-split">
        <div className="col gap-16">
          <Card title="Cualificación" icon={Target} actions={<span className="subtle small">Puntuación interna: {lead.score}/100 · el lead no la ve</span>}>
            <div className="grid-2" style={{ gap: 24 }}>
              <QualificationList rules={data.qualificationRules} qualification={lead.qualification} />
              <div className="col" style={{ gap: 10 }}>
                <span className="section-title">Cómo se calcula</span>
                {data.scoreBreakdown.map((b) => {
                  const rule = data.qualificationRules.find((r) => r.key === b.key);
                  return (
                    <div key={b.key} className="col gap-4">
                      <div className="row-between xs">
                        <span className="muted">{rule?.label ?? b.key}</span>
                        <span className="tnum subtle">
                          {Math.round((b.earned / totalWeight) * 100)} / {Math.round((b.weight / totalWeight) * 100)}
                        </span>
                      </div>
                      <div style={{ height: 6, borderRadius: 6, background: 'var(--surface-3)' }}>
                        <div style={{ width: `${(b.earned / Math.max(1, b.weight)) * 100}%`, height: '100%', borderRadius: 6, background: 'var(--series-1)' }} />
                      </div>
                    </div>
                  );
                })}
                {lead.signals.fit === 'no' && <span className="badge badge-danger">No encaja (puntuación limitada)</span>}
              </div>
            </div>
          </Card>

          <Card title="Memoria de KAI" icon={Brain}>
            {data.memories.length === 0 && <p className="muted small">Aún no hay recuerdos. KAI guarda automáticamente lo relevante (eventos, horarios, lesiones, preferencias…).</p>}
            <div className="col gap-4">
              {data.memories.map((m) => (
                <div key={m.id} className="row-between" style={{ padding: '6px 0', borderBottom: '1px dashed var(--border)' }}>
                  <span>{m.content}</span>
                  <Button variant="ghost" size="sm" iconOnly icon={X} onClick={() => delMemory.mutate(m.id)}>
                    Borrar recuerdo
                  </Button>
                </div>
              ))}
            </div>
            <form
              className="row mt-12"
              onSubmit={(e) => {
                e.preventDefault();
                if (newMemory.trim().length >= 3) addMemory.mutate();
              }}
            >
              <Input value={newMemory} onChange={(e) => setNewMemory(e.target.value)} placeholder="Añadir algo que KAI deba recordar (ej. trabaja a turnos)" />
              <Button type="submit" icon={Plus} loading={addMemory.isPending}>
                Añadir
              </Button>
            </form>
          </Card>

          <Card title="Datos del lead" icon={UserRound} actions={<Button size="sm" variant="primary" icon={Save} loading={save.isPending} onClick={() => save.mutate()}>Guardar</Button>}>
            <div className="grid-2" style={{ gap: 12 }}>
              <Field label="Nombre">
                <Input value={form.name} onChange={set('name')} />
              </Field>
              <Field label="Teléfono">
                <Input value={form.phone} onChange={set('phone')} />
              </Field>
              <Field label="Email">
                <Input value={form.email} onChange={set('email')} />
              </Field>
              <Field label="Instagram">
                <Input value={form.instagramUsername} onChange={set('instagramUsername')} />
              </Field>
            </div>
            <div className="mt-12">
              <Field label="Etiquetas">
                <TagInput value={form.tags} onChange={(tags) => setForm((f) => ({ ...f, tags }))} />
              </Field>
            </div>
            <div className="mt-12">
              <Field label="Notas internas">
                <Textarea value={form.notes} onChange={set('notes')} rows={4} />
              </Field>
            </div>
            <dl className="kv mt-16">
              <dt>Entró</dt>
              <dd>{dateTime(lead.createdAt)}</dd>
              {lead.sourceDetail && (
                <>
                  <dt>Campaña / detalle</dt>
                  <dd>{lead.sourceDetail}</dd>
                </>
              )}
              <dt>Primera respuesta</dt>
              <dd>{lead.firstResponseSeconds !== null ? `${Math.round(lead.firstResponseSeconds / 60)} min` : '—'}</dd>
              {lead.dealValueCents !== null && (
                <>
                  <dt>Importe venta</dt>
                  <dd>{money(lead.dealValueCents)}</dd>
                </>
              )}
              {lead.lostReason && (
                <>
                  <dt>Motivo pérdida</dt>
                  <dd>{lead.lostReason}</dd>
                </>
              )}
            </dl>
          </Card>
        </div>

        <div className="col gap-16">
          <Card title="Llamadas" icon={ClipboardCheck}>
            {data.appointments.length === 0 ? (
              <p className="muted small">Sin llamadas todavía.</p>
            ) : (
              <div className="col">
                {data.appointments.map((a) => (
                  <div key={a.id} className="attention-item" style={{ cursor: 'default' }}>
                    <div className="grow">
                      <strong>{dateTime(a.startsAt)}</strong>
                      <div className="subtle xs">
                        {a.bookedBy === 'kai' ? 'Agendada por KAI' : a.bookedBy === 'lead' ? 'Reservada por el lead' : 'Agendada por el equipo'} · {a.calendarProvider === 'internal' ? 'Agenda KAI' : a.calendarProvider === 'google' ? 'Google Calendar' : 'Calendly'}
                      </div>
                      {a.meetingUrl && (
                        <a href={a.meetingUrl} target="_blank" rel="noreferrer" className="xs">
                          Enlace de la videollamada
                        </a>
                      )}
                    </div>
                    <div className="col" style={{ alignItems: 'flex-end', gap: 6 }}>
                      <span className={`badge ${a.status === 'scheduled' ? 'badge-info' : a.status === 'completed' ? 'badge-success' : a.status === 'no_show' ? 'badge-danger' : ''}`}>
                        {{ scheduled: 'Programada', completed: 'Realizada', no_show: 'No presentado', cancelled: 'Cancelada', rescheduled: 'Reprogramada' }[a.status]}
                      </span>
                      {a.status === 'scheduled' && (
                        <div className="row" style={{ gap: 4 }}>
                          <Button size="sm" onClick={() => setOutcomeFor(a.id)}>
                            Resultado
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => cancelAppt.mutate(a.id)}>
                            Cancelar
                          </Button>
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Card>

          <Card title="Seguimientos" icon={Repeat}>
            {data.followUps.length === 0 ? (
              <p className="muted small">KAI programará seguimientos si el lead deja de responder.</p>
            ) : (
              <div className="col gap-4">
                {data.followUps.slice(0, 10).map(({ followUp: f }) => (
                  <div key={f.id} className="row-between small" style={{ padding: '5px 0' }}>
                    <span>
                      Paso {f.step} · {f.status === 'scheduled' ? `programado ${dateTime(f.scheduledFor)}` : f.status === 'sent' ? `enviado ${timeAgo(f.sentAt)}` : f.note ?? f.status}
                    </span>
                    <span className={`badge ${f.status === 'sent' ? 'badge-success' : f.status === 'scheduled' ? 'badge-info' : ''}`}>
                      {{ scheduled: 'Programado', sent: 'Enviado', cancelled: 'Cancelado', skipped: 'Omitido', failed: 'Fallido' }[f.status] ?? f.status}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </Card>

          <Card title="Historial" icon={History}>
            <div className="col" style={{ gap: 0 }}>
              {data.events.slice(0, 40).map((e) => (
                <div key={e.id} className="row" style={{ alignItems: 'flex-start', gap: 10, padding: '7px 0', borderBottom: '1px dashed var(--border)' }}>
                  <span className="badge" style={{ minWidth: 70, justifyContent: 'center' }}>
                    {ACTOR_LABELS[e.actorType] ?? e.actorType}
                  </span>
                  <div className="grow small">
                    <div>{EVENT_LABELS[e.type] ?? e.type}</div>
                    {describeEvent(e) && <div className="subtle xs">{describeEvent(e)}</div>}
                  </div>
                  <span className="subtle xs">{timeAgo(e.createdAt)}</span>
                </div>
              ))}
            </div>
          </Card>
        </div>
      </div>

      <BookCallModal open={booking} onClose={() => setBooking(false)} leadId={lead.id} conversationId={conversation?.id} />
      <OutcomeModal open={Boolean(outcomeFor)} appointmentId={outcomeFor} onClose={() => setOutcomeFor(null)} />
      <ConfirmDialog
        open={confirmDelete}
        title="¿Eliminar este lead?"
        message="Se borrarán definitivamente el lead, sus conversaciones, mensajes, citas y memoria. Esta acción no se puede deshacer."
        confirmLabel="Eliminar definitivamente"
        danger
        loading={del.isPending}
        onConfirm={() => del.mutate()}
        onClose={() => setConfirmDelete(false)}
      />
    </div>
  );
}
