/* Pestaña «Seguimientos»: automatizaciones de seguimiento, recordatorios, no presentados y aviso tras la llamada. */
import { useId, useRef, useState, type ReactNode } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { BellRing, CalendarCheck, ClipboardCheck, Moon, Plus, Repeat, Trash2, UserX, type LucideIcon } from 'lucide-react';
import { AUTOMATION_LABELS, type AutomationConfig, type AutomationType, type FollowUpStep } from '@shared';
import { api, errorText } from '../../lib/api';
import { Button, Callout, Card, Field, Input, Select, Switch, Textarea, useToast } from '../../components/ui';
import type { Automation } from '../../lib/types';
import { CharCount, NumInput, SaveBar, humanHours, humanMinutes, isTime, useDraft, useReportDirty, type TabProps } from './setter-shared';

interface AutoDraft {
  enabled: boolean;
  config: AutomationConfig;
}
type Draft = Record<AutomationType, AutoDraft | null>;
type Quiet = NonNullable<AutomationConfig['quietHours']>;

const TYPES: AutomationType[] = ['followup_no_reply', 'appointment_reminders', 'no_show_recovery', 'post_call'];
const MAX_STEPS = 6;
const MIN_DELAY_HOURS = 0.25;
const MAX_DELAY_HOURS = 24 * 30;
const MAX_DELAY_MINUTES = 24 * 60;
const DEFAULT_QUIET: Record<'followup_no_reply' | 'appointment_reminders', Quiet> = {
  followup_no_reply: { start: '21:30', end: '09:00' },
  appointment_reminders: { start: '22:00', end: '08:30' },
};

/** Rellena los valores que el servidor aplica por defecto cuando no están definidos. */
function normalize(type: AutomationType, a: Automation | undefined): AutoDraft | null {
  if (!a) return null;
  const c: AutomationConfig = { ...(a.config ?? {}) };
  if (type === 'followup_no_reply') c.steps = (c.steps ?? []).map((s) => ({ delayHours: s.delayHours, angle: s.angle ?? '' }));
  if (type === 'appointment_reminders') {
    c.confirmation = c.confirmation !== false;
    c.reminder24h = c.reminder24h !== false;
    c.reminder1h = c.reminder1h !== false;
  }
  if (type === 'no_show_recovery') c.delayMinutes = c.delayMinutes ?? 15;
  if (type === 'post_call') c.delayMinutes = c.delayMinutes ?? 10;
  return { enabled: a.enabled, config: c };
}

function toDraft(list: Automation[]): Draft {
  return Object.fromEntries(TYPES.map((t) => [t, normalize(t, list.find((a) => a.type === t))])) as Draft;
}

// ───────────── Validación (mismos límites que el servidor) ─────────────
interface StepErrors {
  delay?: string;
  angle?: string;
}
interface Errors {
  steps: StepErrors[];
  stepsGlobal?: string;
  quiet: Partial<Record<AutomationType, string>>;
  delay: Partial<Record<AutomationType, string>>;
}

function quietError(q: Quiet | undefined): string | undefined {
  if (!q) return undefined;
  if (!isTime(q.start) || !isTime(q.end)) return 'Indica la hora de inicio y de fin del horario de silencio.';
  if (q.start === q.end) return 'La hora de inicio y la de fin no pueden ser iguales.';
  return undefined;
}

function validate(d: Draft): Errors {
  const e: Errors = { steps: [], quiet: {}, delay: {} };
  const fu = d.followup_no_reply;
  if (fu) {
    const steps = fu.config.steps ?? [];
    if (steps.length > MAX_STEPS) e.stepsGlobal = `Puedes tener como máximo ${MAX_STEPS} seguimientos.`;
    e.steps = steps.map((s) => {
      const se: StepErrors = {};
      if (!Number.isFinite(s.delayHours) || s.delayHours < MIN_DELAY_HOURS || s.delayHours > MAX_DELAY_HOURS) se.delay = 'La espera debe estar entre 15 minutos y 30 días.';
      const angle = s.angle.trim();
      if (angle.length < 3) se.angle = 'Describe en pocas palabras qué debe hacer KAI en este mensaje.';
      else if (angle.length > 300) se.angle = 'Máximo 300 caracteres.';
      return se;
    });
  }
  for (const t of TYPES) {
    const a = d[t];
    if (!a) continue;
    const qe = quietError(a.config.quietHours);
    if (qe && (t === 'followup_no_reply' || t === 'appointment_reminders')) e.quiet[t] = qe;
    if (t === 'no_show_recovery' || t === 'post_call') {
      const m = a.config.delayMinutes ?? 0;
      if (!Number.isInteger(m) || m < 0 || m > MAX_DELAY_MINUTES) e.delay[t] = 'Escribe un número entero de minutos entre 0 y 1440 (24 horas).';
    }
  }
  return e;
}

function firstError(e: Errors): string | null {
  if (e.stepsGlobal) return e.stepsGlobal;
  const i = e.steps.findIndex((s) => s.delay || s.angle);
  if (i >= 0) return `Seguimiento ${i + 1}: ${e.steps[i].delay ?? e.steps[i].angle}`;
  for (const t of TYPES) {
    if (e.quiet[t]) return `${AUTOMATION_LABELS[t]}: ${e.quiet[t]}`;
    if (e.delay[t]) return `${AUTOMATION_LABELS[t]}: ${e.delay[t]}`;
  }
  return null;
}

/** Configuración limpia para el servidor (textos recortados). */
function toPayload(a: AutoDraft): AutoDraft {
  const config: AutomationConfig = { ...a.config };
  if (config.steps) config.steps = config.steps.map((s) => ({ delayHours: s.delayHours, angle: s.angle.trim() }));
  if (!config.quietHours) delete config.quietHours;
  return { enabled: a.enabled, config };
}

// ───────────── Controles ─────────────
type Unit = 'hours' | 'days';

/** Espera expresada en horas o días (se guarda siempre en horas). */
function DelayInput({ id, hours, onChange, invalid }: { id: string; hours: number; onChange: (h: number) => void; invalid?: boolean }) {
  const [unit, setUnit] = useState<Unit>(() => (hours >= 24 && hours % 24 === 0 ? 'days' : 'hours'));
  const factor = unit === 'days' ? 24 : 1;
  const shown = Math.round((hours / factor) * 100) / 100;
  return (
    <div className="row" style={{ gap: 8 }}>
      <NumInput id={id} value={shown} min={unit === 'days' ? 0.5 : MIN_DELAY_HOURS} max={MAX_DELAY_HOURS / factor} step={unit === 'days' ? 0.5 : 0.25} width={90} invalid={invalid} onChange={(v) => onChange(v * factor)} />
      <Select
        aria-label="Unidad de tiempo"
        value={unit}
        style={{ width: 110 }}
        options={[
          { value: 'hours', label: 'horas' },
          { value: 'days', label: 'días' },
        ]}
        onChange={(e) => {
          const next = e.target.value as Unit;
          setUnit(next);
          // Conserva el número escrito y cambia la unidad («4 horas» → «4 días»).
          onChange(shown * (next === 'days' ? 24 : 1));
        }}
      />
    </div>
  );
}

function QuietHoursEditor({
  value,
  onChange,
  fallback,
  timezone,
  error,
  explanation,
}: {
  value: Quiet | undefined;
  onChange: (q: Quiet | undefined) => void;
  fallback: Quiet;
  timezone: string;
  error?: string;
  explanation: ReactNode;
}) {
  const ids = { start: useId(), end: useId() };
  const [last, setLast] = useState<Quiet>(value ?? fallback);
  return (
    <div className="col gap-12">
      <div className="setter-toggle-row" style={{ paddingBottom: 0, borderBottom: 0 }}>
        <div>
          <strong className="row" style={{ gap: 6 }}>
            <Moon size={15} aria-hidden /> Horario de silencio
          </strong>
          <p className="muted small mt-4">{explanation}</p>
        </div>
        <Switch
          checked={Boolean(value)}
          onChange={(on) => {
            if (on) onChange(last);
            else {
              if (value) setLast(value);
              onChange(undefined);
            }
          }}
          label={<span className="sr-only">Respetar el horario de silencio</span>}
        />
      </div>
      {value && (
        <div className="col gap-4">
          <div className="setter-time-range">
            <label className="small muted" htmlFor={ids.start}>
              No escribir desde las
            </label>
            <Input id={ids.start} type="time" value={value.start} aria-invalid={Boolean(error) || undefined} onChange={(e) => onChange({ ...value, start: e.target.value })} />
            <label className="small muted" htmlFor={ids.end}>
              hasta las
            </label>
            <Input id={ids.end} type="time" value={value.end} aria-invalid={Boolean(error) || undefined} onChange={(e) => onChange({ ...value, end: e.target.value })} />
          </div>
          {error ? <span className="error-text">{error}</span> : <span className="hint">Hora de tu negocio ({timezone}). Si la hora de inicio es posterior a la de fin, el silencio cruza la medianoche (por ejemplo, de 21:30 a 09:00).</span>}
        </div>
      )}
    </div>
  );
}

function AutomationCard({
  type,
  icon,
  draft,
  onToggle,
  children,
}: {
  type: AutomationType;
  icon: LucideIcon;
  draft: AutoDraft | null;
  onToggle: (enabled: boolean) => void;
  children: ReactNode;
}) {
  const label = AUTOMATION_LABELS[type];
  return (
    <Card
      title={label}
      icon={icon}
      actions={
        draft && (
          <Switch
            checked={draft.enabled}
            onChange={onToggle}
            label={
              <>
                <span className="sr-only">{`${label}: `}</span>
                {draft.enabled ? 'Activado' : 'Desactivado'}
              </>
            }
          />
        )
      }
    >
      {draft ? (
        <div className="col gap-16" style={draft.enabled ? undefined : { opacity: 0.75 }}>
          {children}
        </div>
      ) : (
        <Callout tone="warning">Esta automatización no está disponible en tu cuenta. Si crees que es un error, contacta con soporte.</Callout>
      )}
    </Card>
  );
}

function ToggleRow({ title, description, checked, onChange }: { title: string; description: ReactNode; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="setter-toggle-row">
      <div>
        <strong>{title}</strong>
        <p className="muted small mt-4">{description}</p>
      </div>
      <Switch checked={checked} onChange={onChange} label={<span className="sr-only">{title}</span>} />
    </div>
  );
}

// ───────────── Pasos de seguimiento ─────────────
function StepsEditor({ steps, errors, onChange }: { steps: FollowUpStep[]; errors: StepErrors[]; onChange: (steps: FollowUpStep[]) => void }) {
  const baseId = useId();
  // Claves estables por paso (los pasos no tienen id) para no mezclar el estado de cada fila al eliminar.
  const nextKey = useRef(steps.length);
  const [keys, setKeys] = useState<number[]>(() => steps.map((_, i) => i));
  let rowKeys = keys;
  if (keys.length !== steps.length) {
    rowKeys = steps.map(() => nextKey.current++);
    setKeys(rowKeys);
  }
  const update = (i: number, patch: Partial<FollowUpStep>) => onChange(steps.map((s, idx) => (idx === i ? { ...s, ...patch } : s)));
  const remove = (i: number) => {
    setKeys(rowKeys.filter((_, idx) => idx !== i));
    onChange(steps.filter((_, idx) => idx !== i));
  };
  const add = () => {
    setKeys([...rowKeys, nextKey.current++]);
    onChange([...steps, { delayHours: steps.length ? Math.min(MAX_DELAY_HOURS, Math.max(24, steps[steps.length - 1].delayHours * 2)) : 4, angle: '' }]);
  };
  let cumulative = 0;
  const total = steps.reduce((acc, s) => acc + (Number.isFinite(s.delayHours) ? s.delayHours : 0), 0);
  return (
    <div className="col gap-12">
      {steps.length === 0 ? (
        <Callout tone="warning">No hay ningún seguimiento configurado: aunque la automatización esté activada, KAI no volverá a escribir a quien deje de responder. Añade al menos uno.</Callout>
      ) : (
        <div className="setter-list">
          {steps.map((s, i) => {
            cumulative += Number.isFinite(s.delayHours) ? s.delayHours : 0;
            const err = errors[i] ?? {};
            const delayId = `${baseId}-delay-${i}`;
            const angleId = `${baseId}-angle-${i}`;
            return (
              <div key={rowKeys[i] ?? i} className="setter-item">
                <div className="setter-item-head">
                  <span className="setter-order" aria-hidden>
                    {i + 1}
                  </span>
                  <div className="setter-item-main">
                    <strong>Seguimiento {i + 1}</strong>
                    <div className="subtle small">
                      {err.delay
                        ? 'Revisa la espera'
                        : i === 0
                          ? `Se envía ${humanHours(s.delayHours)} después del último mensaje de KAI sin respuesta.`
                          : `Se envía ${humanHours(s.delayHours)} después del seguimiento ${i} (${humanHours(cumulative)} en total sin respuesta).`}
                    </div>
                  </div>
                  <div className="setter-actions">
                    <Button size="sm" variant="ghost" iconOnly icon={Trash2} onClick={() => remove(i)}>
                      {`Eliminar el seguimiento ${i + 1}`}
                    </Button>
                  </div>
                </div>
                <div className="setter-item-body">
                  <div className="setter-fields-2">
                    <Field label={i === 0 ? 'Esperar sin respuesta' : `Esperar tras el seguimiento ${i}`} htmlFor={delayId} error={err.delay}>
                      <DelayInput id={delayId} hours={s.delayHours} invalid={Boolean(err.delay)} onChange={(delayHours) => update(i, { delayHours })} />
                    </Field>
                    <Field label="Enfoque del mensaje" htmlFor={angleId} error={err.angle} hint="Qué debe intentar KAI en este mensaje. Lo redacta con lo que sabe del lead, nunca con un «¿sigues ahí?» genérico.">
                      <Textarea id={angleId} rows={2} maxLength={300} value={s.angle} placeholder="Ej.: Retomar la conversación conectando con lo último que dijo el lead." onChange={(e) => update(i, { angle: e.target.value })} />
                      <CharCount value={s.angle} max={300} />
                    </Field>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
      <div className="row-between wrap">
        <span className="subtle small">
          {steps.length > 0 && Number.isFinite(total) && total > 0
            ? `Si el lead no contesta a ninguno, el último seguimiento se envía aproximadamente ${humanHours(total)} después del último mensaje de KAI. Después, KAI deja de escribirle.`
            : ' '}
        </span>
        <Button
          size="sm"
          icon={Plus}
          disabled={steps.length >= MAX_STEPS}
          onClick={add}
        >
          {steps.length >= MAX_STEPS ? `Máximo ${MAX_STEPS} seguimientos` : 'Añadir seguimiento'}
        </Button>
      </div>
    </div>
  );
}

// ───────────── Pestaña ─────────────
export default function FollowUpsTab({ settings, canEdit, onDirtyChange }: TabProps) {
  const qc = useQueryClient();
  const toast = useToast();
  const ids = { noShow: useId(), postCall: useId() };
  const timezone = settings.business.timezone || 'Europe/Madrid';
  const { draft, base, setDraft, dirty, reset, markSaved } = useDraft<Draft>(toDraft(settings.automations));
  useReportDirty(onDirtyChange, dirty);
  const errors = validate(draft);
  const error = firstError(errors);

  const patch = (type: AutomationType, change: Partial<AutoDraft> | ((a: AutoDraft) => Partial<AutoDraft>)) =>
    setDraft((d) => {
      const current = d[type];
      if (!current) return d;
      const next = typeof change === 'function' ? change(current) : change;
      return { ...d, [type]: { ...current, ...next } };
    });
  const patchConfig = (type: AutomationType, config: Partial<AutomationConfig>) => patch(type, (a) => ({ config: { ...a.config, ...config } }));

  const save = useMutation({
    mutationFn: async () => {
      const changed = TYPES.filter((t) => draft[t] && JSON.stringify(draft[t]) !== JSON.stringify(base[t]));
      for (const t of changed) await api.put(`/settings/automations/${t}`, toPayload(draft[t]!));
      return changed.length;
    },
    onSuccess: () => {
      markSaved();
      toast('Seguimientos guardados');
      void qc.invalidateQueries({ queryKey: ['settings'] });
    },
    onError: (e) => {
      toast(errorText(e), 'error');
      // Puede haberse guardado una parte: recargamos para mostrar el estado real.
      void qc.invalidateQueries({ queryKey: ['settings'] });
    },
  });

  const fu = draft.followup_no_reply;
  const rem = draft.appointment_reminders;
  const noShow = draft.no_show_recovery;
  const post = draft.post_call;

  return (
    <>
      <p className="setter-lead">
        Aquí decides qué hace KAI por su cuenta cuando no hay conversación activa: volver a escribir a quien deja de responder, recordar las llamadas, recuperar a quien no se presentó y avisarte para que registres cómo fue la llamada.
      </p>
      <Callout tone="info">
        WhatsApp e Instagram solo permiten escribir libremente durante las 24 horas siguientes al último mensaje del lead. Pasado ese plazo, en WhatsApp KAI usa una plantilla aprobada por Meta (se configuran en Integraciones) y en Instagram el mensaje no se puede enviar: en ese caso te avisamos.
      </Callout>

      <AutomationCard type="followup_no_reply" icon={Repeat} draft={fu} onToggle={(enabled) => patch('followup_no_reply', { enabled })}>
        {fu && (
          <>
            <p className="muted small">
              Si un lead deja de contestar, KAI vuelve a escribirle pasado el tiempo que indiques. Cada mensaje se redacta con lo que el lead ha contado. Los seguimientos se detienen en cuanto el lead responde, si tomas tú el control de la conversación, si agenda la llamada o si pide que no le escriban más.
            </p>
            <StepsEditor steps={fu.config.steps ?? []} errors={errors.steps} onChange={(steps) => patchConfig('followup_no_reply', { steps })} />
            {errors.stepsGlobal && <span className="error-text">{errors.stepsGlobal}</span>}
            <QuietHoursEditor
              value={fu.config.quietHours}
              fallback={DEFAULT_QUIET.followup_no_reply}
              timezone={timezone}
              error={errors.quiet.followup_no_reply}
              onChange={(quietHours) => patchConfig('followup_no_reply', { quietHours })}
              explanation="Si un seguimiento cae dentro de este horario, KAI espera a que termine para enviarlo. Así nadie recibe mensajes de madrugada."
            />
          </>
        )}
      </AutomationCard>

      <AutomationCard type="appointment_reminders" icon={CalendarCheck} draft={rem} onToggle={(enabled) => patch('appointment_reminders', { enabled })}>
        {rem && (
          <>
            <p className="muted small">Mensajes automáticos al lead para que no se olvide de la llamada. Reducen las ausencias y le permiten avisar si necesita cambiar la hora.</p>
            <div>
              <ToggleRow
                title="Confirmación al agendar"
                description="En cuanto se agenda la llamada, KAI envía un mensaje con el día y la hora (si no lo ha confirmado ya en la propia conversación)."
                checked={rem.config.confirmation !== false}
                onChange={(confirmation) => patchConfig('appointment_reminders', { confirmation })}
              />
              <ToggleRow title="Recordatorio 24 horas antes" description="Un día antes, KAI le recuerda la llamada y le pregunta si le sigue viniendo bien." checked={rem.config.reminder24h !== false} onChange={(reminder24h) => patchConfig('appointment_reminders', { reminder24h })} />
              <ToggleRow title="Recordatorio 1 hora antes" description="Un aviso breve una hora antes, con el enlace de la llamada si lo hay." checked={rem.config.reminder1h !== false} onChange={(reminder1h) => patchConfig('appointment_reminders', { reminder1h })} />
            </div>
            <QuietHoursEditor
              value={rem.config.quietHours}
              fallback={DEFAULT_QUIET.appointment_reminders}
              timezone={timezone}
              error={errors.quiet.appointment_reminders}
              onChange={(quietHours) => patchConfig('appointment_reminders', { quietHours })}
              explanation="Solo afecta al recordatorio de 24 horas: si cae dentro de este horario, se retrasa hasta que termine (siempre que siga quedando al menos 3 horas para la llamada). La confirmación y el aviso de 1 hora se envían a su hora."
            />
          </>
        )}
      </AutomationCard>

      <div className="grid-2">
        <AutomationCard type="no_show_recovery" icon={UserX} draft={noShow} onToggle={(enabled) => patch('no_show_recovery', { enabled })}>
          {noShow && (
            <>
              <p className="muted small">
                Cuando marcas una llamada como «No se presentó», KAI espera unos minutos y escribe al lead con amabilidad para buscar otro hueco. Si el lead te escribe antes, no se envía.
              </p>
              <Field label="Esperar antes de escribir" htmlFor={ids.noShow} error={errors.delay.no_show_recovery}>
                <NumInput
                  id={ids.noShow}
                  value={noShow.config.delayMinutes ?? 15}
                  min={0}
                  max={MAX_DELAY_MINUTES}
                  width={100}
                  invalid={Boolean(errors.delay.no_show_recovery)}
                  suffix={`minutos · ${humanMinutes(noShow.config.delayMinutes ?? 15)}`}
                  onChange={(delayMinutes) => patchConfig('no_show_recovery', { delayMinutes })}
                />
              </Field>
              <p className="subtle xs">Se cuenta desde que registras la ausencia. Valor por defecto: 15 minutos.</p>
            </>
          )}
        </AutomationCard>

        <AutomationCard type="post_call" icon={ClipboardCheck} draft={post} onToggle={(enabled) => patch('post_call', { enabled })}>
          {post && (
            <>
              <p className="muted small">
                Al terminar cada llamada, KAI te deja un aviso (en la campana de Avisos) para que registres si el lead asistió y cómo fue. Así tu embudo y tus estadísticas se mantienen al día. El lead no recibe nada.
              </p>
              <Field label="Avisarme tras la hora de fin de la llamada" htmlFor={ids.postCall} error={errors.delay.post_call}>
                <NumInput
                  id={ids.postCall}
                  value={post.config.delayMinutes ?? 10}
                  min={0}
                  max={MAX_DELAY_MINUTES}
                  width={100}
                  invalid={Boolean(errors.delay.post_call)}
                  suffix={`minutos · ${humanMinutes(post.config.delayMinutes ?? 10)}`}
                  onChange={(delayMinutes) => patchConfig('post_call', { delayMinutes })}
                />
              </Field>
              <p className="subtle xs">Valor por defecto: 10 minutos.</p>
            </>
          )}
        </AutomationCard>
      </div>

      <p className="subtle xs row" style={{ gap: 6 }}>
        <BellRing size={13} aria-hidden /> Los mensajes y avisos que ya estaban programados mantienen su hora; los cambios se aplican a los siguientes.
      </p>

      <SaveBar dirty={dirty} saving={save.isPending} canEdit={canEdit} error={error} onDiscard={reset} onSave={() => save.mutate()} saveLabel="Guardar seguimientos" />
    </>
  );
}
