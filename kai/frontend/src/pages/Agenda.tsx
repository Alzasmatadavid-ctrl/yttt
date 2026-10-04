import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CalendarClock, ChevronLeft, ChevronRight, ClipboardCheck, Clock, Lock, Plus, RotateCw, Save, Trash2 } from 'lucide-react';
import { WEEKDAY_LABELS, type AvailabilityWeek } from '@shared';
import { api, errorText } from '../lib/api';
import { dateTime } from '../lib/format';
import { useCan } from '../lib/business';
import { Button, Callout, Card, ConfirmDialog, EmptyState, Field, Input, Modal, PageHeader, PageLoading, Tabs, useToast } from '../components/ui';
import { OutcomeModal } from '../components/lead-actions';
import type { Appointment, AvailabilityConfig, CalendarConnection } from '../lib/types';

interface ApptRow {
  appointment: Appointment;
  /** isTest: cita de una conversación de prueba del simulador (no es un lead real). */
  lead: { id: string; name: string; score: number; goalSummary: string | null; isTest?: boolean };
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
                    title={`${a.lead.name}${a.lead.isTest ? ' (prueba)' : ''} · ${dateTime(a.appointment.startsAt, timezone)}`}
                  >
                    <strong>
                      {String(s.hour).padStart(2, '0')}:{String(s.minute).padStart(2, '0')}
                    </strong>{' '}
                    {a.lead.name}
                    {a.lead.isTest && (
                      <span className="badge" style={{ marginLeft: 4, padding: '0 5px', fontSize: 10 }}>
                        Prueba
                      </span>
                    )}
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

/** Lo que se edita en «Disponibilidad» (la antelación, en horas). */
type AvailabilityDraft = {
  weekly: AvailabilityWeek;
  slotMinutes: number;
  bufferMinutes: number;
  minNoticeHours: number;
  maxDaysAhead: number;
  blackout: string[];
};

function toDraft(config: AvailabilityConfig): AvailabilityDraft {
  return {
    weekly: config.weekly,
    slotMinutes: config.slotMinutes,
    bufferMinutes: config.bufferMinutes,
    minNoticeHours: Math.round(config.minNoticeMinutes / 60),
    maxDaysAhead: config.maxDaysAhead,
    blackout: config.blackoutDates,
  };
}

const sameDraft = (a: AvailabilityDraft, b: AvailabilityDraft) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Borrador del horario. Se resincroniza con el servidor solo si no hay cambios pendientes: volver a la pestaña del
 * navegador refresca la disponibilidad, y eso no debe borrar las franjas que se están editando y aún no se han guardado.
 */
function useAvailabilityDraft(config: AvailabilityConfig) {
  const source = toDraft(config);
  const sourceKey = JSON.stringify(source);
  const [state, setState] = useState({ key: sourceKey, base: source, draft: source });
  let current = state;
  if (state.key !== sourceKey) {
    const pending = !sameDraft(state.draft, state.base);
    current = { key: sourceKey, base: source, draft: pending ? state.draft : source };
    setState(current);
  }
  return {
    draft: current.draft,
    dirty: !sameDraft(current.draft, current.base),
    update: (fn: (d: AvailabilityDraft) => AvailabilityDraft) => setState((s) => ({ ...s, draft: fn(s.draft) })),
    discard: () => setState((s) => ({ ...s, draft: s.base })),
    /** Tras guardar, lo enviado es la nueva base (si se siguió editando mientras tanto, se conserva lo escrito). */
    markSaved: (sent: AvailabilityDraft) => setState((s) => ({ ...s, base: sent, draft: sameDraft(s.draft, sent) ? sent : s.draft })),
  };
}

function AvailabilityEditor({ config, connections, onDirtyChange }: { config: AvailabilityConfig; connections: CalendarConnection[]; onDirtyChange: (dirty: boolean) => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { draft, dirty, update, markSaved } = useAvailabilityDraft(config);
  const { weekly, slotMinutes, bufferMinutes, minNoticeHours, maxDaysAhead, blackout } = draft;
  const [newDate, setNewDate] = useState('');
  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);
  const setWeekly = (fn: (w: AvailabilityWeek) => AvailabilityWeek) => update((d) => ({ ...d, weekly: fn(d.weekly) }));
  const setField = <K extends 'slotMinutes' | 'bufferMinutes' | 'minNoticeHours' | 'maxDaysAhead'>(key: K) => (e: { target: { value: string } }) =>
    update((d) => ({ ...d, [key]: Number(e.target.value) }));
  const setBlackout = (fn: (b: string[]) => string[]) => update((d) => ({ ...d, blackout: fn(d.blackout) }));
  const save = useMutation({
    mutationFn: (d: AvailabilityDraft) =>
      api.put('/agenda/availability', {
        weekly: d.weekly,
        slotMinutes: d.slotMinutes,
        bufferMinutes: d.bufferMinutes,
        minNoticeMinutes: d.minNoticeHours * 60,
        maxDaysAhead: d.maxDaysAhead,
        blackoutDates: d.blackout,
      }),
    onSuccess: (_r, sent) => {
      markSaved(sent);
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
    <Card
      title="Disponibilidad para llamadas"
      icon={Clock}
      actions={
        canEdit ? (
          <>
            {dirty && <span className="subtle small">Cambios sin guardar</span>}
            <Button variant="primary" size="sm" icon={Save} loading={save.isPending} onClick={() => save.mutate(draft)}>
              Guardar
            </Button>
          </>
        ) : undefined
      }
    >
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
            <Input type="number" min={10} max={240} value={slotMinutes} onChange={setField('slotMinutes')} />
          </Field>
          <Field label="Margen entre citas (min)">
            <Input type="number" min={0} max={120} value={bufferMinutes} onChange={setField('bufferMinutes')} />
          </Field>
          <Field label="Antelación mínima (horas)">
            <Input type="number" min={0} max={168} value={minNoticeHours} onChange={setField('minNoticeHours')} />
          </Field>
          <Field label="Agendar hasta (días vista)">
            <Input type="number" min={1} max={90} value={maxDaysAhead} onChange={setField('maxDaysAhead')} />
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

type AgendaTab = 'semana' | 'disponibilidad';
const STATUS_TEXT: Record<Appointment['status'], string> = { scheduled: 'Programada', completed: 'Realizada', no_show: 'No presentado', cancelled: 'Cancelada', rescheduled: 'Reprogramada' };

export default function Agenda() {
  const navigate = useNavigate();
  // La pestaña va en la URL (?tab=disponibilidad): así los avisos y textos que mandan a «Disponibilidad» la abren directamente.
  const [params, setParams] = useSearchParams();
  const tab: AgendaTab = params.get('tab') === 'disponibilidad' ? 'disponibilidad' : 'semana';
  const selectTab = (next: AgendaTab) =>
    setParams(
      (prev) => {
        const p = new URLSearchParams(prev);
        if (next === 'semana') p.delete('tab');
        else p.set('tab', next);
        return p;
      },
      { replace: true },
    );
  // El editor del horario se monta la primera vez que se abre la pestaña y después solo se oculta: así no se pierden
  // las franjas editadas y aún no guardadas al pasar a «Semana» y volver.
  const [editorVisited, setEditorVisited] = useState(tab === 'disponibilidad');
  if (tab === 'disponibilidad' && !editorVisited) setEditorVisited(true);
  const [availabilityDirty, setAvailabilityDirty] = useState(false);
  const [offset, setOffset] = useState(0);
  const [outcomeFor, setOutcomeFor] = useState<string | null>(null);
  const [picked, setPicked] = useState<ApptRow | null>(null);
  const availability = useQuery({ queryKey: ['availability'], queryFn: () => api.get<{ config: AvailabilityConfig; connections: CalendarConnection[] }>('/agenda/availability') });
  const pastRange = useMemo(() => ({ from: new Date(Date.now() - 14 * 86_400_000).toISOString(), to: new Date().toISOString() }), []);
  const pending = useQuery({ queryKey: ['appointments', 'past'], queryFn: () => api.get<{ appointments: ApptRow[] }>('/agenda/appointments', pastRange) });

  // Aviso del navegador si se intenta cerrar o recargar con cambios sin guardar en el horario.
  useEffect(() => {
    if (!availabilityDirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [availabilityDirty]);
  // Aviso propio al ir a otra pantalla de la aplicación (menú lateral, enlaces…) con cambios sin guardar.
  const [leaveTo, setLeaveTo] = useState<string | null>(null);
  useEffect(() => {
    if (!availabilityDirty) return;
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const link = e.target instanceof Element ? e.target.closest<HTMLAnchorElement>('a[href]') : null;
      if (!link || (link.target && link.target !== '_self') || link.hasAttribute('download')) return;
      const url = new URL(link.href, window.location.href);
      if (url.origin !== window.location.origin || url.pathname === window.location.pathname) return;
      e.preventDefault();
      e.stopPropagation();
      setLeaveTo(url.pathname + url.search + url.hash);
    };
    document.addEventListener('click', onClick, true);
    return () => document.removeEventListener('click', onClick, true);
  }, [availabilityDirty]);
  const goTo = (path: string) => (availabilityDirty ? setLeaveTo(path) : navigate(path));

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
  const now = new Date();
  // Las citas de prueba (simulador) no se registran: no son leads reales ni cuentan en las estadísticas.
  const needOutcome = (pending.data?.appointments ?? []).filter((a) => !a.lead.isTest && a.appointment.status === 'scheduled' && new Date(a.appointment.endsAt) < now);
  // El resultado solo se registra cuando la llamada ya ha empezado: en una futura, «no se presentó» haría que KAI
  // le escribiera al lead como si hubiera faltado.
  const pickedStarted = picked ? new Date(picked.appointment.startsAt) <= now : false;

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
            { value: 'disponibilidad', label: availabilityDirty ? 'Disponibilidad (sin guardar)' : 'Disponibilidad' },
          ]}
          value={tab}
          onChange={selectTab}
        />
      </div>
      {tab === 'semana' && availabilityDirty && (
        <p className="small muted" role="status" style={{ marginBottom: 12 }}>
          Tienes cambios sin guardar en «Disponibilidad». Se conservan mientras no salgas de esta página: vuelve a esa pestaña y pulsa Guardar.
        </p>
      )}
      {tab === 'semana' && <WeekView timezone={tz} weekly={availability.data.config.weekly} offset={offset} onPick={setPicked} />}
      {editorVisited && (
        <div hidden={tab !== 'disponibilidad'}>
          <AvailabilityEditor config={availability.data.config} connections={availability.data.connections} onDirtyChange={setAvailabilityDirty} />
        </div>
      )}
      <Modal
        open={picked !== null}
        onClose={() => setPicked(null)}
        title={
          picked ? (
            <span className="row">
              <CalendarClock size={18} aria-hidden /> {picked.lead.name}
              {picked.lead.isTest && <span className="badge">Prueba</span>}
            </span>
          ) : (
            ''
          )
        }
        footer={
          picked && (
            <>
              <Button
                onClick={() => {
                  setPicked(null);
                  goTo(`/app/leads/${picked.lead.id}`);
                }}
              >
                Ver lead
              </Button>
              {picked.appointment.status === 'scheduled' && pickedStarted && (
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
            </>
          )
        }
      >
        {picked && (
          <>
            <dl className="kv">
              <dt>Cuándo</dt>
              <dd>{dateTime(picked.appointment.startsAt, tz)}</dd>
              <dt>Objetivo</dt>
              <dd>{picked.lead.goalSummary ?? '—'}</dd>
              <dt>Estado</dt>
              <dd>{STATUS_TEXT[picked.appointment.status]}</dd>
              {picked.appointment.meetingUrl && (
                <>
                  <dt>Enlace</dt>
                  <dd style={{ overflowWrap: 'anywhere' }}>
                    <a href={picked.appointment.meetingUrl} target="_blank" rel="noreferrer">
                      {picked.appointment.meetingUrl}
                    </a>
                  </dd>
                </>
              )}
            </dl>
            {picked.appointment.status === 'scheduled' && !pickedStarted && (
              <p className="subtle small" style={{ marginBottom: 0 }}>
                Podrás registrar cómo fue cuando empiece la llamada. Si el lead no puede asistir, cancélala desde su ficha y agenda otra.
              </p>
            )}
          </>
        )}
      </Modal>
      <OutcomeModal open={Boolean(outcomeFor)} appointmentId={outcomeFor} onClose={() => setOutcomeFor(null)} />
      <ConfirmDialog
        open={leaveTo !== null}
        title="¿Salir sin guardar?"
        message="Tienes cambios sin guardar en tu horario de llamadas. Si sales ahora, se perderán. Para conservarlos, quédate y pulsa Guardar en «Disponibilidad»."
        confirmLabel="Salir sin guardar"
        danger
        onConfirm={() => {
          const target = leaveTo;
          setLeaveTo(null);
          if (target) navigate(target);
        }}
        onClose={() => setLeaveTo(null)}
      />
    </div>
  );
}
