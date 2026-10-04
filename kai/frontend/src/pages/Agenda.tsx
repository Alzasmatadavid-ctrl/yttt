import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CalendarClock, ChevronLeft, ChevronRight, ClipboardCheck, Clock, Lock, Plus, RotateCw, Save, Trash2 } from 'lucide-react';
import { WEEKDAY_LABELS, type AvailabilityWeek } from '@shared';
import { api, errorText } from '../lib/api';
import { dateTime } from '../lib/format';
import { useCan } from '../lib/business';
import { Button, Callout, Card, EmptyState, Field, Input, PageHeader, PageLoading, Tabs, useToast } from '../components/ui';
import { OutcomeModal } from '../components/lead-actions';
import type { Appointment, AvailabilityConfig, CalendarConnection } from '../lib/types';

interface ApptRow {
  appointment: Appointment;
  lead: { id: string; name: string; score: number; goalSummary: string | null };
}

/** Partes de una fecha en la zona horaria del negocio. */
function tzParts(d: Date, timeZone: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
      .formatToParts(d)
      .map((p) => [p.type, p.value]),
  );
  const hour = Number(parts.hour) % 24;
  return { iso: `${parts.year}-${parts.month}-${parts.day}`, hour, minute: Number(parts.minute) };
}

function addDaysIso(iso: string, days: number) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function weekdayOfIso(iso: string) {
  const wd = new Date(`${iso}T12:00:00Z`).getUTCDay();
  return wd === 0 ? 7 : wd; // ISO: 1 = lunes
}

const HOUR_H = 44;
const toMin = (hm: string) => {
  const [h, m] = hm.split(':').map(Number);
  return h * 60 + m;
};

function WeekView({ timezone, weekly, offset, onPick }: { timezone: string; weekly: AvailabilityWeek; offset: number; onPick: (a: ApptRow) => void }) {
  const today = tzParts(new Date(), timezone).iso;
  const monday = addDaysIso(today, -(weekdayOfIso(today) - 1) + offset * 7);
  const days = Array.from({ length: 7 }, (_, i) => addDaysIso(monday, i));
  const from = new Date(`${days[0]}T00:00:00Z`).getTime() - 14 * 3600_000;
  const to = new Date(`${days[6]}T23:59:59Z`).getTime() + 14 * 3600_000;
  const { data } = useQuery({
    queryKey: ['appointments', days[0]],
    queryFn: () => api.get<{ appointments: ApptRow[] }>('/agenda/appointments', { from: new Date(from).toISOString(), to: new Date(to).toISOString() }),
    refetchInterval: 30_000,
  });
  const ranges = Object.values(weekly).flat();
  const startHour = Math.min(8, ...ranges.map((r) => Math.floor(toMin(r.start) / 60)));
  const endHour = Math.max(21, ...ranges.map((r) => Math.ceil(toMin(r.end) / 60)));
  const hours = Array.from({ length: endHour - startHour }, (_, i) => startHour + i);
  const now = tzParts(new Date(), timezone);
  const appts = (data?.appointments ?? []).filter((a) => a.appointment.status !== 'cancelled' && a.appointment.status !== 'rescheduled');

  return (
    <div style={{ overflowX: 'auto' }}>
      <div className="week">
        <div className="week-head" style={{ borderLeft: 0 }} />
        {days.map((d) => (
          <div key={d} className={`week-head ${d === today ? 'today' : ''}`}>
            {new Date(`${d}T12:00:00Z`).toLocaleDateString('es-ES', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })}
          </div>
        ))}
        <div className="week-times">
          {hours.map((h) => (
            <div key={h} className="week-time">
              {String(h).padStart(2, '0')}:00
            </div>
          ))}
        </div>
        {days.map((d) => {
          const wd = String(weekdayOfIso(d)) as keyof AvailabilityWeek;
          const dayAppts = appts.filter((a) => tzParts(new Date(a.appointment.startsAt), timezone).iso === d);
          return (
            <div key={d} className="week-day">
              {hours.map((h) => (
                <div key={h} className="week-cell" />
              ))}
              {(weekly[wd] ?? []).map((r) => (
                <div key={`${r.start}-${r.end}`} className="week-avail" style={{ top: ((toMin(r.start) - startHour * 60) / 60) * HOUR_H, height: ((toMin(r.end) - toMin(r.start)) / 60) * HOUR_H }} />
              ))}
              {d === now.iso && now.hour >= startHour && now.hour < endHour && <div className="now-line" style={{ top: ((now.hour * 60 + now.minute - startHour * 60) / 60) * HOUR_H }} />}
              {dayAppts.map((a) => {
                const s = tzParts(new Date(a.appointment.startsAt), timezone);
                const minutes = (new Date(a.appointment.endsAt).getTime() - new Date(a.appointment.startsAt).getTime()) / 60000;
                const top = ((s.hour * 60 + s.minute - startHour * 60) / 60) * HOUR_H;
                return (
                  <button
                    key={a.appointment.id}
                    className={`week-event ${a.appointment.bookedBy === 'kai' ? 'kai' : ''} ${a.appointment.status}`}
                    style={{ top, height: Math.max(22, (minutes / 60) * HOUR_H - 2) }}
                    onClick={() => onPick(a)}
                    title={`${a.lead.name} · ${dateTime(a.appointment.startsAt, timezone)}`}
                  >
                    <strong>
                      {String(s.hour).padStart(2, '0')}:{String(s.minute).padStart(2, '0')}
                    </strong>{' '}
                    {a.lead.name}
                  </button>
                );
              })}
            </div>
          );
        })}
      </div>
      <div className="legend mt-8">
        <span className="legend-item">
          <span className="legend-swatch" style={{ background: 'var(--accent-soft)', border: '1px solid var(--accent-line)' }} />
          Disponibilidad para llamadas
        </span>
        <span className="legend-item">
          <span className="legend-swatch" style={{ background: 'var(--accent)' }} />
          Agendada por KAI
        </span>
        <span className="legend-item">
          <span className="legend-swatch" style={{ background: 'var(--info)' }} />
          Agendada por ti o por el lead
        </span>
      </div>
    </div>
  );
}

function AvailabilityEditor({ config, connections }: { config: AvailabilityConfig; connections: CalendarConnection[] }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [weekly, setWeekly] = useState<AvailabilityWeek>(config.weekly);
  const [slotMinutes, setSlotMinutes] = useState(config.slotMinutes);
  const [bufferMinutes, setBufferMinutes] = useState(config.bufferMinutes);
  const [minNoticeHours, setMinNoticeHours] = useState(Math.round(config.minNoticeMinutes / 60));
  const [maxDaysAhead, setMaxDaysAhead] = useState(config.maxDaysAhead);
  const [blackout, setBlackout] = useState<string[]>(config.blackoutDates);
  const [newDate, setNewDate] = useState('');
  useEffect(() => setWeekly(config.weekly), [config.weekly]);
  const save = useMutation({
    mutationFn: () => api.put('/agenda/availability', { weekly, slotMinutes, bufferMinutes, minNoticeMinutes: minNoticeHours * 60, maxDaysAhead, blackoutDates: blackout }),
    onSuccess: () => {
      toast('Disponibilidad guardada. KAI solo ofrecerá estos horarios.');
      void qc.invalidateQueries({ queryKey: ['availability'] });
      void qc.invalidateQueries({ queryKey: ['slots'] });
    },
    onError: (e) => toast(errorText(e), 'error'),
  });
  const setRange = (day: keyof AvailabilityWeek, i: number, key: 'start' | 'end', value: string) =>
    setWeekly((w) => ({ ...w, [day]: w[day].map((r, idx) => (idx === i ? { ...r, [key]: value } : r)) }));
  const calendly = connections.find((c) => c.provider === 'calendly');
  // Cambiar la disponibilidad es configuración del negocio: el servidor solo se lo permite a la persona titular.
  const canEdit = useCan('settings:write');

  return (
    <Card title="Disponibilidad para llamadas" icon={Clock} actions={canEdit ? <Button variant="primary" size="sm" icon={Save} loading={save.isPending} onClick={() => save.mutate()}>Guardar</Button> : undefined}>
      {!canEdit && (
        <div style={{ marginBottom: 12 }}>
          <Callout tone="info" icon={Lock}>
            Puedes consultar el horario, pero solo la persona titular del negocio (rol Entrenador) puede cambiarlo.
          </Callout>
        </div>
      )}
      {calendly && <p className="callout callout-info small" style={{ marginBottom: 12 }}>Tienes Calendly conectado: los huecos reales salen de tu Calendly. Este horario se usa solo si lo desconectas.</p>}
      <fieldset disabled={!canEdit} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
        <p className="muted small" style={{ marginBottom: 14 }}>
          KAI solo ofrecerá huecos dentro de este horario, descontando tus citas{connections.some((c) => c.provider === 'google') ? ' y lo que tengas ocupado en Google Calendar' : ''}. Zona horaria: <strong>{config.timezone}</strong>.
        </p>
        <div className="col" style={{ gap: 10 }}>
          {(Object.keys(WEEKDAY_LABELS) as (keyof AvailabilityWeek)[]).map((day) => (
            <div key={day} className="row wrap" style={{ alignItems: 'flex-start', gap: 10, paddingBottom: 10, borderBottom: '1px dashed var(--border)' }}>
              <strong style={{ width: 90, paddingTop: 8 }}>{WEEKDAY_LABELS[day]}</strong>
              <div className="col grow" style={{ gap: 6 }}>
                {weekly[day].length === 0 && <span className="subtle small" style={{ paddingTop: 8 }}>No disponible</span>}
                {weekly[day].map((r, i) => (
                  <div key={i} className="row" style={{ gap: 6 }}>
                    <Input type="time" value={r.start} onChange={(e) => setRange(day, i, 'start', e.target.value)} style={{ width: 120 }} aria-label="Desde" />
                    <span className="subtle">–</span>
                    <Input type="time" value={r.end} onChange={(e) => setRange(day, i, 'end', e.target.value)} style={{ width: 120 }} aria-label="Hasta" />
                    <Button variant="ghost" size="sm" iconOnly icon={Trash2} onClick={() => setWeekly((w) => ({ ...w, [day]: w[day].filter((_, idx) => idx !== i) }))}>
                      Quitar franja
                    </Button>
                  </div>
                ))}
              </div>
              <Button size="sm" variant="ghost" icon={Plus} onClick={() => setWeekly((w) => ({ ...w, [day]: [...w[day], { start: '17:00', end: '20:00' }] }))}>
                Franja
              </Button>
            </div>
          ))}
        </div>
        <div className="grid-4 mt-16" style={{ gap: 12 }}>
          <Field label="Duración de la llamada" hint="Se configura en Setter IA → Llamada">
            <Input value={`${config.callDurationMinutes} min`} disabled />
          </Field>
          <Field label="Intervalo entre huecos (min)">
            <Input type="number" min={10} max={240} value={slotMinutes} onChange={(e) => setSlotMinutes(Number(e.target.value))} />
          </Field>
          <Field label="Margen entre citas (min)">
            <Input type="number" min={0} max={120} value={bufferMinutes} onChange={(e) => setBufferMinutes(Number(e.target.value))} />
          </Field>
          <Field label="Antelación mínima (horas)">
            <Input type="number" min={0} max={168} value={minNoticeHours} onChange={(e) => setMinNoticeHours(Number(e.target.value))} />
          </Field>
          <Field label="Agendar hasta (días vista)">
            <Input type="number" min={1} max={90} value={maxDaysAhead} onChange={(e) => setMaxDaysAhead(Number(e.target.value))} />
          </Field>
        </div>
        <div className="mt-16">
          <Field label="Días bloqueados (vacaciones, festivos…)">
            <div className="row wrap" style={{ gap: 6 }}>
              {blackout.map((d) => (
                <span key={d} className="badge" style={{ height: 26 }}>
                  {d}
                  <button type="button" onClick={() => setBlackout((b) => b.filter((x) => x !== d))} style={{ border: 0, background: 'none', cursor: 'pointer', color: 'inherit' }} aria-label={`Quitar ${d}`}>
                    ×
                  </button>
                </span>
              ))}
              <Input type="date" value={newDate} onChange={(e) => setNewDate(e.target.value)} style={{ width: 170 }} aria-label="Día que quieres bloquear" />
              <Button size="sm" disabled={!newDate} onClick={() => { setBlackout((b) => [...new Set([...b, newDate])].sort()); setNewDate(''); }}>
                Bloquear día
              </Button>
            </div>
          </Field>
        </div>
      </fieldset>
    </Card>
  );
}

export default function Agenda() {
  const navigate = useNavigate();
  const [tab, setTab] = useState<'semana' | 'disponibilidad'>('semana');
  const [offset, setOffset] = useState(0);
  const [outcomeFor, setOutcomeFor] = useState<string | null>(null);
  const [picked, setPicked] = useState<ApptRow | null>(null);
  const availability = useQuery({ queryKey: ['availability'], queryFn: () => api.get<{ config: AvailabilityConfig; connections: CalendarConnection[] }>('/agenda/availability') });
  const pastRange = useMemo(() => ({ from: new Date(Date.now() - 14 * 86_400_000).toISOString(), to: new Date().toISOString() }), []);
  const pending = useQuery({ queryKey: ['appointments', 'past'], queryFn: () => api.get<{ appointments: ApptRow[] }>('/agenda/appointments', pastRange) });
  if (availability.isLoading) return <PageLoading />;
  if (!availability.data) {
    return (
      <div className="page">
        <EmptyState
          icon={AlertTriangle}
          title="No se pudo cargar la agenda"
          description={errorText(availability.error)}
          action={
            <Button icon={RotateCw} loading={availability.isFetching} onClick={() => void availability.refetch()}>
              Reintentar
            </Button>
          }
        />
      </div>
    );
  }
  const tz = availability.data.config.timezone;
  const needOutcome = (pending.data?.appointments ?? []).filter((a) => a.appointment.status === 'scheduled' && new Date(a.appointment.endsAt) < new Date());

  return (
    <div className="page">
      <PageHeader
        title="Agenda"
        description="Tus llamadas de valoración. KAI agenda solo en huecos reales de tu disponibilidad."
        actions={
          tab === 'semana' && (
            <div className="row">
              <Button size="sm" iconOnly icon={ChevronLeft} onClick={() => setOffset((o) => o - 1)}>
                Semana anterior
              </Button>
              <Button size="sm" onClick={() => setOffset(0)}>
                Hoy
              </Button>
              <Button size="sm" iconOnly icon={ChevronRight} onClick={() => setOffset((o) => o + 1)}>
                Semana siguiente
              </Button>
            </div>
          )
        }
      />
      {needOutcome.length > 0 && (
        <Card title="Registra el resultado" icon={ClipboardCheck} className="mb-16">
          <div className="col">
            {needOutcome.map((a) => (
              <div key={a.appointment.id} className="attention-item" style={{ cursor: 'default' }}>
                <div className="grow">
                  <strong>{a.lead.name}</strong>
                  <div className="subtle small">{dateTime(a.appointment.startsAt, tz)}</div>
                </div>
                <Button size="sm" variant="primary" onClick={() => setOutcomeFor(a.appointment.id)}>
                  ¿Cómo fue?
                </Button>
              </div>
            ))}
          </div>
        </Card>
      )}
      <div style={{ marginTop: needOutcome.length ? 16 : 0, marginBottom: 16 }}>
        <Tabs
          tabs={[
            { value: 'semana', label: 'Semana' },
            { value: 'disponibilidad', label: 'Disponibilidad' },
          ]}
          value={tab}
          onChange={setTab}
        />
      </div>
      {tab === 'semana' ? (
        <WeekView timezone={tz} weekly={availability.data.config.weekly} offset={offset} onPick={setPicked} />
      ) : (
        <AvailabilityEditor config={availability.data.config} connections={availability.data.connections} />
      )}
      {picked && (
        <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && setPicked(null)}>
          <div className="modal" role="dialog" aria-modal="true">
            <div className="modal-header">
              <h2 className="row">
                <CalendarClock size={18} /> {picked.lead.name}
              </h2>
              <Button variant="ghost" size="sm" onClick={() => setPicked(null)}>
                Cerrar
              </Button>
            </div>
            <dl className="kv">
              <dt>Cuándo</dt>
              <dd>{dateTime(picked.appointment.startsAt, tz)}</dd>
              <dt>Objetivo</dt>
              <dd>{picked.lead.goalSummary ?? '—'}</dd>
              <dt>Estado</dt>
              <dd>{{ scheduled: 'Programada', completed: 'Realizada', no_show: 'No presentado', cancelled: 'Cancelada', rescheduled: 'Reprogramada' }[picked.appointment.status]}</dd>
              {picked.appointment.meetingUrl && (
                <>
                  <dt>Enlace</dt>
                  <dd>
                    <a href={picked.appointment.meetingUrl} target="_blank" rel="noreferrer">
                      {picked.appointment.meetingUrl}
                    </a>
                  </dd>
                </>
              )}
            </dl>
            <div className="modal-footer">
              <Button onClick={() => navigate(`/app/leads/${picked.lead.id}`)}>Ver lead</Button>
              {picked.appointment.status === 'scheduled' && (
                <Button
                  variant="primary"
                  onClick={() => {
                    setOutcomeFor(picked.appointment.id);
                    setPicked(null);
                  }}
                >
                  Registrar resultado
                </Button>
              )}
            </div>
          </div>
        </div>
      )}
      <OutcomeModal open={Boolean(outcomeFor)} appointmentId={outcomeFor} onClose={() => setOutcomeFor(null)} />
    </div>
  );
}
