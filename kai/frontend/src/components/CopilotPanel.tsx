import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { ArrowUp, Check, Sparkles, X } from 'lucide-react';
import { api, errorText } from '../lib/api';
import { dateTime, timeAgo } from '../lib/format';
import { useBusinessTimezone } from '../lib/business';
import { Button, Spinner, useToast } from './ui';
import { LeadAvatar, ScoreBadge, StatusBadge, TemperatureBadge } from './lead-bits';
import type { LeadStatus, LeadTemperature, LeadSource } from '@shared';

interface CopilotData {
  leads?: { id: string; name: string; score: number; temperature: string; status: string; source: string; goal: string | null; lastInboundAt: string | null; conversationId?: string | null }[];
  appointments?: { id: string; leadId: string; leadName: string; startsAt: string; status: string }[];
  draft?: { leadId: string; text: string };
  actions?: { id: string; type: string; summary: string }[];
  metrics?: Record<string, unknown>;
}
interface CopilotMsg {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  data: CopilotData;
  createdAt: string;
}

const SUGGESTIONS = [
  '¿A quién debería responder ahora?',
  '¿Qué leads están más calientes?',
  '¿Quién lleva más de 24 horas sin responder?',
  'Muéstrame las llamadas de mañana',
  '¿Cuántos leads de Instagram tengo esta semana?',
  'Cambia el tono de KAI para que sea más directo',
  '¿Qué puedo mejorar según mis datos?',
];

function ActionCard({ action, pending }: { action: { id: string; summary: string }; pending: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [local, setState] = useState<'done' | 'cancelled' | null>(null);
  const state = local ?? (pending ? 'pending' : 'resolved');
  const confirm = useMutation({
    mutationFn: () => api.post<{ ok: boolean; result: { delivered?: boolean; reason?: string } }>(`/copilot/actions/${action.id}/confirm`),
    onSuccess: (r) => {
      setState('done');
      if (r.result?.delivered === false) toast(`No se pudo enviar: ${r.result.reason ?? 'revisa el canal'}`, 'error');
      else toast('Acción realizada');
      void qc.invalidateQueries();
    },
    onError: (e) => toast(errorText(e), 'error'),
  });
  const cancel = useMutation({
    mutationFn: () => api.post(`/copilot/actions/${action.id}/cancel`),
    onSuccess: () => setState('cancelled'),
    onError: (e) => toast(errorText(e), 'error'),
  });
  return (
    <div className="action-card">
      <div className="small">
        <strong>Requiere tu confirmación</strong>
        {/* El resumen de «enviar mensaje» incluye el mensaje completo (con saltos de línea): se muestra entero antes de confirmar. */}
        <div className="muted mt-4" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
          {action.summary}
        </div>
      </div>
      {state === 'pending' ? (
        <div className="row">
          <Button variant="primary" size="sm" icon={Check} loading={confirm.isPending} onClick={() => confirm.mutate()}>
            Confirmar
          </Button>
          <Button size="sm" icon={X} loading={cancel.isPending} onClick={() => cancel.mutate()}>
            Cancelar
          </Button>
        </div>
      ) : (
        <span className={`badge ${state === 'done' ? 'badge-success' : ''}`}>{state === 'done' ? 'Hecho' : state === 'cancelled' ? 'Cancelada' : 'Resuelta'}</span>
      )}
    </div>
  );
}

function Cards({ data, onNavigate, pendingIds }: { data: CopilotData; onNavigate: (to: string) => void; pendingIds: Set<string> }) {
  // Las horas de las llamadas, en la zona horaria del negocio (como en la Agenda).
  const tz = useBusinessTimezone();
  return (
    <div className="col mt-8" style={{ gap: 8 }}>
      {data.leads && data.leads.length > 0 && (
        <div className="col" style={{ gap: 6 }}>
          {data.leads.slice(0, 8).map((l) => (
            <button key={l.id} className="attention-item" onClick={() => onNavigate(l.conversationId ? `/app/inbox/${l.conversationId}` : `/app/leads/${l.id}`)}>
              <LeadAvatar name={l.name} size={30} channel={l.source as LeadSource} />
              <div className="grow">
                <div className="row-between">
                  <strong className="ellipsis">{l.name}</strong>
                  <ScoreBadge score={l.score} />
                </div>
                <div className="row wrap mt-4" style={{ gap: 6 }}>
                  <StatusBadge status={l.status as LeadStatus} />
                  <TemperatureBadge temperature={l.temperature as LeadTemperature} />
                  <span className="subtle xs">{l.lastInboundAt ? `escribió ${timeAgo(l.lastInboundAt)}` : 'sin respuesta'}</span>
                </div>
              </div>
            </button>
          ))}
        </div>
      )}
      {data.appointments && data.appointments.length > 0 && (
        <div className="col" style={{ gap: 6 }}>
          {data.appointments.map((a) => (
            <button key={a.id} className="attention-item" onClick={() => onNavigate(`/app/leads/${a.leadId}`)}>
              <div className="grow">
                <strong>{a.leadName}</strong>
                <div className="subtle small">{dateTime(a.startsAt, tz)}</div>
              </div>
            </button>
          ))}
        </div>
      )}
      {data.draft && (
        <div className="phone small">
          <span className="subtle xs">Borrador</span>
          <div className="msg-row out kai" style={{ maxWidth: '100%' }}>
            <div className="bubble">{data.draft.text}</div>
          </div>
        </div>
      )}
      {data.actions?.map((a) => <ActionCard key={a.id} action={a} pending={pendingIds.has(a.id)} />)}
    </div>
  );
}

export default function CopilotPanel({ compact }: { compact?: boolean }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  const [text, setText] = useState('');
  const endRef = useRef<HTMLDivElement>(null);
  const history = useQuery({ queryKey: ['copilot-history'], queryFn: () => api.get<{ messages: CopilotMsg[] }>('/copilot/history') });
  const pending = useQuery({ queryKey: ['copilot-actions'], queryFn: () => api.get<{ actions: { id: string }[] }>('/copilot/actions') });
  const pendingIds = new Set((pending.data?.actions ?? []).map((a) => a.id));
  const ask = useMutation({
    mutationFn: (question: string) => api.post<{ id: string; text: string; data: CopilotData }>('/copilot/ask', { question }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['copilot-actions'] });
      await qc.invalidateQueries({ queryKey: ['copilot-history'] });
    },
    onError: (e) => toast(errorText(e), 'error'),
  });
  const messages = history.data?.messages ?? [];
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length, ask.isPending]);

  const send = (q: string) => {
    const question = q.trim();
    if (!question || ask.isPending) return;
    setText('');
    ask.mutate(question);
  };

  return (
    <div className="copilot">
      <div className="copilot-messages">
        {messages.length === 0 && !ask.isPending && (
          <div className="col" style={{ gap: 14 }}>
            <div className="row">
              <span className="copilot-avatar">
                <Sparkles />
              </span>
              <div>
                <strong>KAI Copilot</strong>
                <div className="muted small">Pregúntame por tus leads, tu agenda o tus métricas. Para cualquier cambio, te pediré confirmación.</div>
              </div>
            </div>
          </div>
        )}
        {messages.map((m) =>
          m.role === 'user' ? (
            <div key={m.id} className="copilot-msg user">
              {m.content}
            </div>
          ) : (
            <div key={m.id} className="copilot-msg assistant">
              <span className="copilot-avatar">
                <Sparkles />
              </span>
              <div className="grow" style={{ minWidth: 0 }}>
                <div style={{ whiteSpace: 'pre-wrap' }}>{m.content}</div>
                <Cards data={m.data} onNavigate={(to) => navigate(to)} pendingIds={pendingIds} />
              </div>
            </div>
          ),
        )}
        {ask.isPending && (
          <>
            <div className="copilot-msg user">{ask.variables}</div>
            <div className="copilot-msg assistant">
              <span className="copilot-avatar">
                <Sparkles />
              </span>
              <Spinner />
            </div>
          </>
        )}
        <div ref={endRef} />
      </div>
      {(messages.length === 0 || !compact) && (
        <div className="suggestions" style={{ padding: '0 14px 10px' }}>
          {SUGGESTIONS.slice(0, compact ? 4 : 7).map((s) => (
            <button key={s} className="chip" onClick={() => send(s)}>
              {s}
            </button>
          ))}
        </div>
      )}
      <form
        className="copilot-input"
        onSubmit={(e) => {
          e.preventDefault();
          send(text);
        }}
      >
        <input className="input" value={text} onChange={(e) => setText(e.target.value)} placeholder="Pregunta o pide algo a KAI…" aria-label="Mensaje para KAI Copilot" />
        <Button type="submit" variant="primary" iconOnly icon={ArrowUp} disabled={!text.trim()} loading={ask.isPending}>
          Enviar
        </Button>
      </form>
    </div>
  );
}
