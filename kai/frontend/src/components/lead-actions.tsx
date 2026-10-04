/* Acciones reutilizables sobre un lead: cambiar etapa, agendar llamada, cualificación, memoria. */
import { useState } from 'react';
import { Link } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Minus } from 'lucide-react';
import { LEAD_STATUSES, type LeadQualification, type LeadStatus } from '@shared';
import { api, errorText } from '../lib/api';
import { dayLabel, parseOptionalAmount, timeOnly } from '../lib/format';
import { useBusinessCurrency } from '../lib/business';
import { Button, Field, Input, Modal, Select, Spinner, useToast } from './ui';
import type { QualificationRule } from '../lib/types';

export function StatusSelect({ leadId, status, onChanged }: { leadId: string; status: LeadStatus; onChanged?: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [pending, setPending] = useState<LeadStatus | null>(null);
  const [deal, setDeal] = useState('');
  const [dealError, setDealError] = useState<string | null>(null);
  const currency = useBusinessCurrency();
  const mutate = useMutation({
    mutationFn: (body: { status: LeadStatus; dealValueCents?: number | null }) => api.post(`/leads/${leadId}/status`, body),
    onSuccess: () => {
      toast('Etapa actualizada');
      setPending(null);
      void qc.invalidateQueries();
      onChanged?.();
    },
    onError: (e) => toast(errorText(e), 'error'),
  });
  return (
    <>
      <Select
        aria-label="Etapa del pipeline"
        value={status}
        onChange={(e) => {
          const next = e.target.value as LeadStatus;
          if (next === 'client') {
            // Cada vez que se abre, el importe empieza vacío (no se arrastra el de otro lead).
            setDeal('');
            setDealError(null);
            setPending(next);
          } else mutate.mutate({ status: next });
        }}
        options={LEAD_STATUSES.map((s) => ({ value: s.key, label: s.label }))}
      />
      <Modal
        open={pending === 'client'}
        onClose={() => setPending(null)}
        title="Marcar como cliente"
        footer={
          <>
            <Button onClick={() => setPending(null)}>Cancelar</Button>
            <Button
              variant="primary"
              loading={mutate.isPending}
              onClick={() => {
                const amount = parseOptionalAmount(deal, { currency });
                if (amount.error) return setDealError(amount.error);
                mutate.mutate({ status: 'client', dealValueCents: amount.cents });
              }}
            >
              Guardar
            </Button>
          </>
        }
      >
        <Field label="Importe de la venta (opcional)" hint="Si lo dejas vacío se usa el precio de tu servicio principal para calcular ingresos y ROI." error={dealError}>
          <Input
            inputMode="decimal"
            value={deal}
            onChange={(e) => {
              setDeal(e.target.value);
              setDealError(null);
            }}
            placeholder="Ej. 297 o 1.200,50"
          />
        </Field>
      </Modal>
    </>
  );
}

interface SlotsResponse {
  provider: string;
  timezone: string;
  slots: { id: string; start: string; end: string; label: string }[];
}

export function BookCallModal({ open, onClose, leadId, conversationId }: { open: boolean; onClose: () => void; leadId: string; conversationId?: string | null }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [selected, setSelected] = useState<string | null>(null);
  const slots = useQuery({ queryKey: ['slots'], queryFn: () => api.get<SlotsResponse>('/agenda/slots'), enabled: open });
  const book = useMutation({
    mutationFn: (start: string) => api.post('/agenda/appointments', { leadId, start, conversationId: conversationId ?? null }),
    onSuccess: () => {
      toast('Llamada agendada. KAI enviará la confirmación y los recordatorios.');
      void qc.invalidateQueries();
      onClose();
    },
    onError: (e) => toast(errorText(e), 'error'),
  });
  const grouped = new Map<string, SlotsResponse['slots']>();
  for (const s of slots.data?.slots ?? []) {
    const key = dayLabel(s.start, slots.data?.timezone);
    grouped.set(key, [...(grouped.get(key) ?? []), s]);
  }
  const chosen = slots.data?.slots.find((s) => s.id === selected);
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Agendar llamada"
      wide
      footer={
        <>
          <Button onClick={onClose}>Cancelar</Button>
          <Button variant="primary" disabled={!chosen} loading={book.isPending} onClick={() => chosen && book.mutate(chosen.start)}>
            Agendar {chosen ? chosen.label : ''}
          </Button>
        </>
      }
    >
      {slots.isLoading && <Spinner />}
      {slots.error && <p className="error-text">{errorText(slots.error)}</p>}
      {slots.data?.provider === 'calendly' && <p className="muted small">Con Calendly conectado, la reserva la confirma el lead desde el enlace que le envía KAI.</p>}
      {slots.data && slots.data.slots.length === 0 && (
        <p className="muted">
          No hay huecos libres. Revisa tu horario en <Link to="/app/agenda?tab=disponibilidad">Agenda → Disponibilidad</Link>.
        </p>
      )}
      <div className="col" style={{ gap: 14, maxHeight: 420, overflowY: 'auto' }}>
        {[...grouped.entries()].slice(0, 10).map(([day, list]) => (
          <div key={day}>
            <div className="section-title" style={{ marginBottom: 6 }}>
              {day}
            </div>
            <div className="chips">
              {list.map((s) => (
                <button key={s.id} className="chip" aria-pressed={selected === s.id} onClick={() => setSelected(s.id)} disabled={slots.data?.provider === 'calendly'}>
                  {timeOnly(s.start, slots.data?.timezone)}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </Modal>
  );
}

export function QualificationList({ rules, qualification }: { rules: QualificationRule[]; qualification: LeadQualification }) {
  const enabled = rules.filter((r) => r.enabled);
  return (
    <div>
      {enabled.map((r) => {
        const item = qualification[r.key];
        return (
          <div key={r.key} className="qual-item">
            <span className={`check ${item?.value ? 'ok' : 'no'}`}>{item?.value ? <Check /> : <Minus />}</span>
            <div className="grow" style={{ minWidth: 0 }}>
              <div style={{ fontWeight: 560 }}>
                {r.label}
                {item?.level && <span className="subtle xs"> · {levelLabel(item.level)}</span>}
              </div>
              <div className={item?.value ? 'muted' : 'subtle'} style={{ fontSize: 12.5 }}>
                {item?.value ?? 'Pendiente'}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function levelLabel(level: string) {
  return (
    { high: 'alta', medium: 'media', low: 'baja', yes: 'sí', maybe: 'quizá', no: 'no', unknown: 'por confirmar' } as Record<string, string>
  )[level] ?? level;
}

export function OutcomeModal({ appointmentId, open, onClose }: { appointmentId: string | null; open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [attended, setAttended] = useState<'yes' | 'no'>('yes');
  const [outcome, setOutcome] = useState<'won' | 'lost' | 'follow_up'>('won');
  const [notes, setNotes] = useState('');
  const [deal, setDeal] = useState('');
  const [dealError, setDealError] = useState<string | null>(null);
  const currency = useBusinessCurrency();
  // El modal está siempre montado: al abrirlo (o al pasar a otra cita) el formulario vuelve a empezar de cero,
  // para no registrar en un lead el resultado, las notas o el importe que se escribieron para otro.
  const formKey = open ? appointmentId : null;
  const [shownFor, setShownFor] = useState(formKey);
  if (formKey !== shownFor) {
    setShownFor(formKey);
    if (formKey) {
      setAttended('yes');
      setOutcome('won');
      setNotes('');
      setDeal('');
      setDealError(null);
    }
  }
  const save = useMutation({
    mutationFn: (dealValueCents: number | null) =>
      api.post(`/agenda/appointments/${appointmentId}/outcome`, {
        attended: attended === 'yes',
        outcome: attended === 'yes' ? outcome : undefined,
        notes: notes || undefined,
        dealValueCents: attended === 'yes' && outcome === 'won' && dealValueCents !== null ? dealValueCents : undefined,
      }),
    onSuccess: () => {
      toast(attended === 'no' ? 'Registrado como no presentado. KAI le escribirá para reagendar.' : 'Resultado registrado');
      void qc.invalidateQueries();
      onClose();
    },
    onError: (e) => toast(errorText(e), 'error'),
  });
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Resultado de la llamada"
      footer={
        <>
          <Button onClick={onClose}>Cancelar</Button>
          <Button
            variant="primary"
            loading={save.isPending}
            onClick={() => {
              const won = attended === 'yes' && outcome === 'won';
              const amount = won ? parseOptionalAmount(deal, { currency }) : { cents: null, error: null };
              if (amount.error) return setDealError(amount.error);
              save.mutate(amount.cents);
            }}
          >
            Guardar resultado
          </Button>
        </>
      }
    >
      <div className="col gap-16">
        <Field label="¿Se presentó a la llamada?">
          <div className="segmented" role="group" aria-label="¿Se presentó a la llamada?">
            <button type="button" aria-pressed={attended === 'yes'} onClick={() => setAttended('yes')}>
              Sí, asistió
            </button>
            <button type="button" aria-pressed={attended === 'no'} onClick={() => setAttended('no')}>
              No se presentó
            </button>
          </div>
        </Field>
        {attended === 'yes' ? (
          <Field label="Resultado">
            <div className="segmented" role="group" aria-label="Resultado de la llamada">
              <button type="button" aria-pressed={outcome === 'won'} onClick={() => setOutcome('won')}>
                Cliente 🎉
              </button>
              <button type="button" aria-pressed={outcome === 'follow_up'} onClick={() => setOutcome('follow_up')}>
                Seguimiento
              </button>
              <button type="button" aria-pressed={outcome === 'lost'} onClick={() => setOutcome('lost')}>
                No cerró
              </button>
            </div>
          </Field>
        ) : (
          <p className="muted small">KAI le enviará un mensaje natural para buscar otro hueco (si la automatización de no presentados está activa).</p>
        )}
        {attended === 'yes' && outcome === 'won' && (
          <Field label="Importe de la venta (opcional)" hint="Si lo dejas vacío se usa el precio de tu servicio principal." error={dealError}>
            <Input
              inputMode="decimal"
              value={deal}
              onChange={(e) => {
                setDeal(e.target.value);
                setDealError(null);
              }}
              placeholder="Ej. 297 o 1.200,50"
            />
          </Field>
        )}
        <Field label="Notas (opcional)">
          <Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Ej. quiere empezar en enero" />
        </Field>
      </div>
    </Modal>
  );
}
