/* Pestaña «Llamada»: cómo se llama, cuánto dura y para qué sirve la llamada que KAI agenda. */
import { useId } from 'react';
import { Link } from 'react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CalendarClock, Eye, PhoneCall } from 'lucide-react';
import { api, errorText } from '../../lib/api';
import { Callout, Card, Field, Input, Textarea, useToast } from '../../components/ui';
import type { AiSettings } from '../../lib/types';
import { CharCount, NumInput, SaveBar, humanMinutes, useDraft, useReportDirty, type TabProps } from './setter-shared';

type CallDraft = Pick<AiSettings, 'callLabel' | 'callDurationMinutes' | 'callDescription'>;

const LABEL_MIN = 3;
const LABEL_MAX = 60;
const DURATION_MIN = 10;
const DURATION_MAX = 120;
const DESCRIPTION_MAX = 500;
const LABEL_SUGGESTIONS = ['llamada de valoración', 'videollamada gratuita', 'sesión de diagnóstico', 'llamada de estrategia'];
const DURATION_SUGGESTIONS = [15, 20, 30, 45, 60];

type Errors = Partial<Record<keyof CallDraft, string>>;

function validate(d: CallDraft): Errors {
  const e: Errors = {};
  const label = d.callLabel.trim();
  if (label.length < LABEL_MIN) e.callLabel = `Escribe un nombre de al menos ${LABEL_MIN} caracteres.`;
  else if (label.length > LABEL_MAX) e.callLabel = `Máximo ${LABEL_MAX} caracteres.`;
  if (!Number.isInteger(d.callDurationMinutes) || d.callDurationMinutes < DURATION_MIN || d.callDurationMinutes > DURATION_MAX)
    e.callDurationMinutes = `La duración debe ser un número entero de minutos entre ${DURATION_MIN} y ${DURATION_MAX}.`;
  if (d.callDescription.length > DESCRIPTION_MAX) e.callDescription = `Máximo ${DESCRIPTION_MAX} caracteres.`;
  return e;
}

export default function CallTab({ settings, canEdit, onDirtyChange }: TabProps) {
  const qc = useQueryClient();
  const toast = useToast();
  const ids = { label: useId(), duration: useId(), description: useId() };
  const ai = settings.aiSettings;
  const { draft, setDraft, dirty, reset, markSaved } = useDraft<CallDraft>({
    callLabel: ai.callLabel ?? '',
    callDurationMinutes: ai.callDurationMinutes,
    callDescription: ai.callDescription ?? '',
  });
  useReportDirty(onDirtyChange, dirty);
  const errors = validate(draft);
  const error = Object.values(errors)[0] ?? null;
  const set = <K extends keyof CallDraft>(key: K, value: CallDraft[K]) => setDraft((d) => ({ ...d, [key]: value }));

  const trainer = settings.trainer.displayName?.trim() || 'tu entrenador';
  const label = draft.callLabel.trim() || 'llamada de valoración';
  const minutes = errors.callDurationMinutes ? null : draft.callDurationMinutes;

  const save = useMutation({
    mutationFn: async () => {
      const payload: CallDraft = { callLabel: draft.callLabel.trim(), callDurationMinutes: draft.callDurationMinutes, callDescription: draft.callDescription.trim() };
      await api.put('/settings/ai', payload);
      return payload;
    },
    onSuccess: (payload) => {
      markSaved(payload);
      toast('Datos de la llamada guardados');
      // La duración también define los huecos de la agenda.
      for (const key of ['settings', 'availability', 'slots']) void qc.invalidateQueries({ queryKey: [key] });
    },
    onError: (e) => toast(errorText(e), 'error'),
  });

  return (
    <>
      <p className="setter-lead">
        El objetivo de KAI es que los leads que encajan contigo agenden una llamada. Aquí defines cómo se llama esa llamada, cuánto dura y para qué sirve, para que KAI la presente con tus palabras.
      </p>

      <div className="grid-split">
        <Card title="La llamada" icon={PhoneCall}>
          <div className="col gap-16">
            <Field
              label="Nombre de la llamada"
              htmlFor={ids.label}
              error={errors.callLabel}
              hint="Es como KAI la menciona en sus mensajes, en minúscula y detrás de «una» o «la» (por ejemplo, «¿Te viene bien una llamada de valoración?»)."
            >
              <Input id={ids.label} value={draft.callLabel} maxLength={LABEL_MAX} placeholder="Ej.: llamada de valoración" aria-invalid={Boolean(errors.callLabel) || undefined} onChange={(e) => set('callLabel', e.target.value)} />
            </Field>
            <div className="chips" role="group" aria-label="Nombres sugeridos">
              {LABEL_SUGGESTIONS.map((s) => (
                <button key={s} type="button" className="chip" aria-pressed={draft.callLabel.trim() === s} onClick={() => set('callLabel', s)}>
                  {s}
                </button>
              ))}
            </div>

            <Field
              label="Duración"
              htmlFor={ids.duration}
              error={errors.callDurationMinutes}
              hint="KAI la menciona al proponer la llamada y la usa para ofrecer huecos libres en tu agenda y reservar el tiempo en tu calendario."
            >
              <div className="row wrap" style={{ gap: 12 }}>
                <NumInput
                  id={ids.duration}
                  value={draft.callDurationMinutes}
                  min={DURATION_MIN}
                  max={DURATION_MAX}
                  width={90}
                  invalid={Boolean(errors.callDurationMinutes)}
                  suffix={`minutos${minutes ? ` · ${humanMinutes(minutes)}` : ''}`}
                  onChange={(v) => set('callDurationMinutes', v)}
                />
                <div className="chips" role="group" aria-label="Duraciones habituales">
                  {DURATION_SUGGESTIONS.map((m) => (
                    <button key={m} type="button" className="chip" aria-pressed={draft.callDurationMinutes === m} onClick={() => set('callDurationMinutes', m)}>
                      {m} min
                    </button>
                  ))}
                </div>
              </div>
            </Field>

            <Field
              label="Para qué sirve la llamada (opcional)"
              htmlFor={ids.description}
              error={errors.callDescription}
              hint="Una o dos frases. KAI lo usa para explicar la llamada cuando la propone o si el lead pregunta qué es. Evita prometer resultados."
            >
              <Textarea
                id={ids.description}
                rows={3}
                maxLength={DESCRIPTION_MAX}
                value={draft.callDescription}
                placeholder={`Ej.: Llamada sin compromiso con ${trainer} para conocer tu caso y ver si podemos ayudarte.`}
                onChange={(e) => set('callDescription', e.target.value)}
              />
              <CharCount value={draft.callDescription} max={DESCRIPTION_MAX} />
            </Field>
          </div>
        </Card>

        <div className="col gap-16">
          <Card title="Así la presentará KAI" icon={Eye}>
            <div className="phone">
              <div className="msg-row out kai">
                <div className="bubble">
                  Creo que tendría sentido que lo vierais en una {label}
                  {minutes ? ` de ${minutes} minutos` : ''} con {trainer} para valorar tu caso. ¿Te encaja?
                </div>
                <div className="msg-meta">Al proponer la llamada</div>
              </div>
              <div className="msg-row out kai">
                <div className="bubble">Te confirmo la {label} con {trainer} el jueves a las 18:00. Si necesitas cambiarla, dímelo por aquí.</div>
                <div className="msg-meta">Confirmación al agendar</div>
              </div>
            </div>
            <p className="subtle xs mt-12">Ejemplos orientativos con un día y una hora inventados. Con inteligencia artificial, KAI adapta la frase a cada conversación y a tu tono.</p>
          </Card>

          <Card title="Horarios disponibles" icon={CalendarClock}>
            <p className="muted small">
              KAI solo ofrece huecos dentro de tu disponibilidad y nunca se inventa horarios. Los días y horas en los que puede agendar se configuran en la <Link to="/app/agenda">Agenda</Link>.
            </p>
            {dirty && !errors.callDurationMinutes && draft.callDurationMinutes !== ai.callDurationMinutes && (
              <div className="mt-12">
                <Callout tone="info">Al guardar la nueva duración, los huecos que ofrece KAI se recalcularán. Las llamadas ya agendadas no cambian.</Callout>
              </div>
            )}
          </Card>
        </div>
      </div>

      <SaveBar dirty={dirty} saving={save.isPending} canEdit={canEdit} error={error} onDiscard={reset} onSave={() => save.mutate()} saveLabel="Guardar llamada" />
    </>
  );
}
