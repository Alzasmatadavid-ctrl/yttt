/* Pestaña «Personalidad»: identidad, transparencia, tono, vocabulario, ejemplos, ritmo y vista previa. */
import { useId, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Eye, Lightbulb, ListChecks, MessageSquareText, Power, ShieldCheck, SlidersHorizontal, Sparkles, Timer, UserRound, Users } from 'lucide-react';
import { DEFAULT_TONE, type AiTone } from '@shared';
import { api, errorText } from '../../lib/api';
import { Button, Callout, Card, ConfirmDialog, Field, Input, Spinner, Switch, TagInput, Textarea, useToast } from '../../components/ui';
import { InstagramIcon, WhatsAppIcon } from '../../components/lead-bits';
import type { AiSettings, SettingsResponse } from '../../lib/types';
import { CharCount, ChoiceGroup, NumInput, OptionCards, SaveBar, ToneSlider, humanSeconds, useDraft, useReportDirty, type TabProps } from './setter-shared';

type PersonalityDraft = Pick<
  AiSettings,
  | 'assistantName'
  | 'persona'
  | 'disclosureMode'
  | 'tone'
  | 'wordsToUse'
  | 'wordsToAvoid'
  | 'examplesWhatsapp'
  | 'examplesInstagram'
  | 'examplesOther'
  | 'extraInstructions'
  | 'replyDelayMinSeconds'
  | 'replyDelayMaxSeconds'
>;

interface PreviewResponse {
  leadMessage: string;
  reply: string | null;
  issues: string[];
  engine: 'llm' | 'rules';
}

const DEFAULT_LEAD_MESSAGE = 'Hola! Vi tu anuncio, quiero perder grasa';

const TONE_SLIDERS: { key: 'formality' | 'energy' | 'directness'; label: string; hint: string; scale: string[] }[] = [
  { key: 'formality', label: 'Formalidad', hint: '¿Hablas como con un amigo o de forma más profesional?', scale: ['Muy cercano', 'Cercano', 'Equilibrado', 'Formal', 'Muy formal'] },
  { key: 'energy', label: 'Energía', hint: '¿Mensajes tranquilos o con mucha motivación?', scale: ['Muy calmado', 'Tranquilo', 'Equilibrado', 'Enérgico', 'Muy enérgico'] },
  { key: 'directness', label: 'Directividad', hint: 'Lo directo que es KAI al proponer el siguiente paso.', scale: ['Muy suave', 'Suave', 'Equilibrado', 'Directo', 'Muy directo'] },
];

const LIMITS = { name: 40, word: 40, wordsToUse: 50, wordsToAvoid: 100, examples: 6000, extra: 3000, delay: 3600 };

function toDraft(ai: AiSettings): PersonalityDraft {
  return {
    assistantName: ai.assistantName ?? '',
    persona: ai.persona,
    disclosureMode: ai.disclosureMode,
    tone: { ...DEFAULT_TONE, ...ai.tone },
    wordsToUse: ai.wordsToUse ?? [],
    wordsToAvoid: ai.wordsToAvoid ?? [],
    examplesWhatsapp: ai.examplesWhatsapp ?? '',
    examplesInstagram: ai.examplesInstagram ?? '',
    examplesOther: ai.examplesOther ?? '',
    extraInstructions: ai.extraInstructions ?? '',
    replyDelayMinSeconds: ai.replyDelayMinSeconds,
    replyDelayMaxSeconds: ai.replyDelayMaxSeconds,
  };
}

type Errors = Partial<Record<keyof PersonalityDraft, string>>;

function validate(d: PersonalityDraft): Errors {
  const e: Errors = {};
  const name = d.assistantName.trim();
  if (!name) e.assistantName = 'Escribe un nombre para el asistente.';
  else if (name.length > LIMITS.name) e.assistantName = `Máximo ${LIMITS.name} caracteres.`;
  if (d.wordsToUse.length > LIMITS.wordsToUse) e.wordsToUse = `Máximo ${LIMITS.wordsToUse} palabras o expresiones.`;
  else if (d.wordsToUse.some((w) => w.length > LIMITS.word)) e.wordsToUse = `Cada palabra o expresión puede tener como máximo ${LIMITS.word} caracteres.`;
  if (d.wordsToAvoid.length > LIMITS.wordsToAvoid) e.wordsToAvoid = `Máximo ${LIMITS.wordsToAvoid} palabras o expresiones.`;
  else if (d.wordsToAvoid.some((w) => w.length > LIMITS.word)) e.wordsToAvoid = `Cada palabra o expresión puede tener como máximo ${LIMITS.word} caracteres.`;
  if (d.examplesWhatsapp.length > LIMITS.examples) e.examplesWhatsapp = `Máximo ${LIMITS.examples} caracteres.`;
  if (d.examplesInstagram.length > LIMITS.examples) e.examplesInstagram = `Máximo ${LIMITS.examples} caracteres.`;
  if (d.examplesOther.length > LIMITS.examples) e.examplesOther = `Máximo ${LIMITS.examples} caracteres.`;
  if (d.extraInstructions.length > LIMITS.extra) e.extraInstructions = `Máximo ${LIMITS.extra} caracteres.`;
  const okDelay = (n: number) => Number.isInteger(n) && n >= 0 && n <= LIMITS.delay;
  if (!okDelay(d.replyDelayMinSeconds)) e.replyDelayMinSeconds = 'Escribe un número entero de segundos entre 0 y 3600 (una hora).';
  if (!okDelay(d.replyDelayMaxSeconds)) e.replyDelayMaxSeconds = 'Escribe un número entero de segundos entre 0 y 3600 (una hora).';
  else if (okDelay(d.replyDelayMinSeconds) && d.replyDelayMinSeconds > d.replyDelayMaxSeconds) e.replyDelayMaxSeconds = 'El máximo no puede ser menor que el mínimo.';
  return e;
}

// ───────────── Piloto automático ─────────────
function AutopilotCard({ enabled, canEdit }: { enabled: boolean; canEdit: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [confirm, setConfirm] = useState(false);
  const toggle = useMutation({
    mutationFn: (value: boolean) => api.put('/settings/ai', { autopilotEnabled: value }),
    onSuccess: (_d, value) => {
      void qc.invalidateQueries({ queryKey: ['settings'] });
      toast(value ? 'KAI vuelve a responder automáticamente' : 'KAI en pausa: no responderá automáticamente');
      setConfirm(false);
    },
    onError: (e) => toast(errorText(e), 'error'),
  });
  return (
    <Card title="Piloto automático" icon={Power}>
      <div className="setter-toggle-row">
        <div>
          <strong>{enabled ? 'KAI responde automáticamente a tus leads' : 'KAI está en pausa'}</strong>
          <p className="muted small mt-4">
            {enabled
              ? 'KAI contesta los mensajes nuevos, cualifica y propone la llamada sin que tengas que intervenir. Puedes tomar el control de cualquier conversación desde la bandeja.'
              : 'KAI no responde a nadie de forma automática. Los mensajes siguen llegando a tu bandeja y puedes contestar tú.'}
          </p>
          <p className="subtle xs mt-4">Este interruptor se aplica al momento, sin necesidad de pulsar Guardar.</p>
        </div>
        <Switch
          checked={enabled}
          disabled={!canEdit || toggle.isPending}
          onChange={() => setConfirm(true)}
          label={
            <>
              <span className="sr-only">Piloto automático: </span>
              {enabled ? 'Activado' : 'En pausa'}
            </>
          }
        />
      </div>
      <ConfirmDialog
        open={confirm}
        title={enabled ? '¿Pausar a KAI?' : '¿Reactivar a KAI?'}
        message={
          enabled
            ? 'KAI dejará de responder automáticamente a todos los leads hasta que lo reactives. Los mensajes seguirán llegando a tu bandeja.'
            : 'KAI volverá a responder automáticamente a los leads en las conversaciones donde esté activo.'
        }
        confirmLabel={enabled ? 'Pausar KAI' : 'Reactivar KAI'}
        danger={enabled}
        loading={toggle.isPending}
        onConfirm={() => toggle.mutate(!enabled)}
        onClose={() => setConfirm(false)}
      />
    </Card>
  );
}

// ───────────── Vista previa ─────────────
function PreviewCard({
  ai,
  assistantName,
  dirty,
  overrides,
  skipped,
}: {
  ai: SettingsResponse['ai'];
  assistantName: string;
  dirty: boolean;
  /** Cambios todavía sin guardar (solo los campos válidos). */
  overrides: Partial<PersonalityDraft>;
  /** Campos con errores que no se tienen en cuenta en la vista previa. */
  skipped: number;
}) {
  const toast = useToast();
  const inputId = useId();
  const [message, setMessage] = useState(DEFAULT_LEAD_MESSAGE);
  const [usedDraft, setUsedDraft] = useState(false);
  const preview = useMutation({
    mutationFn: (vars: { leadMessage: string; overrides?: Partial<PersonalityDraft> }) => api.post<PreviewResponse>('/settings/ai/preview', vars),
    onError: (e) => toast(errorText(e), 'error'),
  });
  const run = () => {
    const text = message.trim();
    if (!text) {
      toast('Escribe un mensaje de ejemplo como si fueras un lead.', 'error');
      return;
    }
    setUsedDraft(dirty);
    preview.mutate({ leadMessage: text.slice(0, 500), overrides: dirty ? overrides : undefined });
  };
  const result = preview.data;
  const bubbles = result?.reply
    ? result.reply
        .split(/\n{2,}/)
        .map((b) => b.trim())
        .filter(Boolean)
    : [];
  const busy = preview.isPending;

  return (
    <Card title="Vista previa" icon={Eye} className="setter-preview">
      <p className="muted small" style={{ marginBottom: 12 }}>
        Escribe un mensaje como si fueras un lead (simulamos que se llama Carlos y te escribe por Instagram) y mira cómo respondería KAI. No se envía nada a nadie ni se guarda ninguna conversación.
      </p>
      {dirty && (
        <div style={{ marginBottom: 12 }}>
          <Callout tone="info">
            La vista previa ya tiene en cuenta los cambios que aún no has guardado, para que puedas probarlos antes. Recuerda pulsar «Guardar personalidad» para que KAI los use con tus leads.
            {skipped > 0 && ` Hay ${skipped === 1 ? 'un campo con errores que no se ha' : `${skipped} campos con errores que no se han`} tenido en cuenta.`}
          </Callout>
        </div>
      )}
      <div className="setter-preview-input">
        <Field label="Mensaje del lead" htmlFor={inputId}>
          <Input
            id={inputId}
            value={message}
            maxLength={500}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                run();
              }
            }}
          />
        </Field>
        <Button variant="primary" icon={Sparkles} loading={busy} onClick={run}>
          {result ? 'Generar otra' : 'Generar respuesta'}
        </Button>
      </div>
      <div className="mt-16" aria-live="polite">
        {busy && (
          <div className="row muted small">
            <Spinner size={16} /> KAI está escribiendo…
          </div>
        )}
        {!busy && !result && <p className="subtle small">Aquí aparecerá la respuesta de ejemplo.</p>}
        {!busy && result && (
          <div className="col gap-12">
            <div className="phone setter-chat">
              <div className="msg-row in">
                <div className="bubble">{result.leadMessage}</div>
                <div className="msg-meta">Carlos (lead de ejemplo)</div>
              </div>
              {bubbles.length > 0 ? (
                <div className="msg-row out kai">
                  {bubbles.map((b, i) => (
                    <div key={i} className="bubble" style={i > 0 ? { marginTop: 4 } : undefined}>
                      {b}
                    </div>
                  ))}
                  <div className="msg-meta">{assistantName.trim() || 'KAI'}</div>
                </div>
              ) : (
                <p className="subtle small" style={{ alignSelf: 'center' }}>
                  Sin respuesta
                </p>
              )}
            </div>
            {bubbles.length === 0 && (
              <Callout tone="warning">
                KAI no ha podido generar una respuesta que supere su control de calidad con esta configuración. En una conversación real, te pasaría la conversación a ti.
                {result.issues.length > 0 && (
                  <ul className="small" style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                    {result.issues.map((issue, idx) => (
                      <li key={idx}>{issue}</li>
                    ))}
                  </ul>
                )}
              </Callout>
            )}
            <div className="row wrap xs subtle" style={{ gap: 6 }}>
              <span>Motor usado:</span>
              {result.engine === 'llm' ? (
                <span className="badge badge-accent">Inteligencia artificial{ai.mainModel ? ` · ${ai.mainModel}` : ''}</span>
              ) : (
                <span className="badge">Reglas internas (modo simulación)</span>
              )}
              <span className="badge">{usedDraft ? 'Con tus cambios sin guardar' : 'Con la configuración guardada'}</span>
            </div>
            {result.engine === 'rules' && <p className="subtle xs">Sin inteligencia artificial externa, KAI responde con frases predefinidas: las respuestas reales serán más naturales y se adaptarán mejor a tu tono.</p>}
          </div>
        )}
      </div>
    </Card>
  );
}

// ───────────── Pestaña ─────────────
export default function PersonalityTab({ settings, canEdit, onDirtyChange }: TabProps) {
  const qc = useQueryClient();
  const toast = useToast();
  const ids = {
    name: useId(),
    exWa: useId(),
    exIg: useId(),
    exOther: useId(),
    extra: useId(),
    delayMin: useId(),
    delayMax: useId(),
    wordsUse: useId(),
    wordsAvoid: useId(),
  };
  const { draft, setDraft, dirty, reset, markSaved } = useDraft(toDraft(settings.aiSettings));
  useReportDirty(onDirtyChange, dirty);
  const errors = validate(draft);
  const firstError = Object.values(errors)[0] ?? null;
  const set = <K extends keyof PersonalityDraft>(key: K, value: PersonalityDraft[K]) => setDraft((d) => ({ ...d, [key]: value }));
  const setTone = (patch: Partial<AiTone>) => setDraft((d) => ({ ...d, tone: { ...d.tone, ...patch } }));
  const trainerName = settings.trainer.displayName?.trim() || 'tu nombre';
  const assistant = draft.assistantName.trim() || 'KAI';

  const save = useMutation({
    mutationFn: async () => {
      const payload: PersonalityDraft = { ...draft, assistantName: draft.assistantName.trim() };
      await api.put('/settings/ai', payload);
      return payload;
    },
    onSuccess: (payload) => {
      markSaved(payload);
      toast('Personalidad guardada');
      void qc.invalidateQueries({ queryKey: ['settings'] });
    },
    onError: (e) => toast(errorText(e), 'error'),
  });

  /** Cambios sin guardar que se envían a la vista previa (se omiten los campos con errores). */
  const previewOverrides = Object.fromEntries(
    (Object.keys(draft) as (keyof PersonalityDraft)[]).filter((k) => !errors[k]).map((k) => [k, k === 'assistantName' ? draft.assistantName.trim() : draft[k]]),
  ) as Partial<PersonalityDraft>;
  const skippedFields = Object.keys(errors).length;

  return (
    <>
      <p className="setter-lead">
        Define cómo se presenta KAI y cómo escribe. Cuanto más se parezca a tu forma de hablar, más natural resultará la conversación para tus leads.
      </p>
      <div className="grid-split">
        <div className="col gap-16">
          <AutopilotCard enabled={settings.aiSettings.autopilotEnabled} canEdit={canEdit} />

          <Card title="Identidad" icon={UserRound}>
            <div className="col gap-16">
              <Field label="Nombre del asistente" htmlFor={ids.name} error={errors.assistantName} hint="Es el nombre con el que KAI se presenta. Puede ser «KAI» o el que prefieras.">
                <Input id={ids.name} value={draft.assistantName} maxLength={LIMITS.name} placeholder="Ej.: KAI" aria-invalid={Boolean(errors.assistantName)} onChange={(e) => set('assistantName', e.target.value)} />
              </Field>
              <OptionCards
                label="¿En nombre de quién escribe?"
                value={draft.persona}
                onChange={(persona) => set('persona', persona)}
                options={[
                  {
                    value: 'team_member',
                    title: 'Como asistente de tu equipo',
                    icon: Users,
                    description: `KAI se presenta como ${assistant}, el asistente virtual de tu equipo, y habla de ti en tercera persona («${trainerName} te lo explicará en la llamada»).`,
                  },
                  {
                    value: 'trainer',
                    title: 'En tu nombre',
                    icon: UserRound,
                    description: 'KAI escribe en tu nombre y con tu estilo, como tu asistente de mensajes. Nunca dirá que es tú en persona.',
                  },
                ]}
              />
            </div>
          </Card>

          <Card title="Transparencia" icon={ShieldCheck}>
            <div className="col gap-16">
              <Callout tone="info">
                El Reglamento europeo de Inteligencia Artificial exige informar a las personas de que están hablando con un sistema automatizado (salvo que resulte evidente). Por eso te recomendamos que KAI lo indique desde su primer mensaje.
              </Callout>
              <OptionCards
                label="¿Cuándo dice KAI que es un asistente automatizado?"
                value={draft.disclosureMode}
                onChange={(disclosureMode) => set('disclosureMode', disclosureMode)}
                options={[
                  {
                    value: 'first_message',
                    title: 'En el primer mensaje',
                    badge: 'Recomendado',
                    description: `Se presenta con naturalidad desde el principio. Por ejemplo: «Soy ${assistant}, el asistente virtual del equipo de ${trainerName}».`,
                  },
                  {
                    value: 'on_request',
                    title: 'Solo si se lo preguntan',
                    description: 'KAI no lo menciona por iniciativa propia, pero lo reconoce en cuanto el lead pregunta.',
                  },
                ]}
              />
              {draft.disclosureMode === 'on_request' && (
                <Callout tone="warning">
                  Con esta opción, asegúrate de informar por otra vía de que las respuestas son automáticas (por ejemplo, en tu perfil o en tus anuncios). Si tienes dudas, consúltalo con tu asesor legal.
                </Callout>
              )}
              <p className="subtle small">En cualquier caso, si un lead pregunta si está hablando con un bot, KAI nunca lo negará y le ofrecerá hablar contigo.</p>
            </div>
          </Card>

          <Card title="Tono" icon={SlidersHorizontal}>
            <div className="col gap-16">
              {TONE_SLIDERS.map((s) => (
                <ToneSlider key={s.key} label={s.label} hint={s.hint} scale={s.scale} value={draft.tone[s.key]} onChange={(v) => setTone({ [s.key]: v })} />
              ))}
              <div className="grid-3">
                <ChoiceGroup
                  label="Emojis"
                  value={draft.tone.emojiUsage}
                  onChange={(emojiUsage) => setTone({ emojiUsage })}
                  options={[
                    { value: 'none', label: 'Ninguno' },
                    { value: 'low', label: 'Pocos' },
                    { value: 'medium', label: 'Algunos' },
                    { value: 'high', label: 'Muchos' },
                  ]}
                />
                <ChoiceGroup
                  label="Longitud de los mensajes"
                  hint="En WhatsApp e Instagram suelen funcionar mejor los mensajes cortos."
                  value={draft.tone.messageLength}
                  onChange={(messageLength) => setTone({ messageLength })}
                  options={[
                    { value: 'short', label: 'Cortos' },
                    { value: 'medium', label: 'Medios' },
                    { value: 'long', label: 'Largos' },
                  ]}
                />
                <ChoiceGroup
                  label="Trato"
                  hint="Cómo se dirige KAI al lead."
                  value={draft.tone.addressing}
                  onChange={(addressing) => setTone({ addressing })}
                  options={[
                    { value: 'tu', label: 'De tú' },
                    { value: 'usted', label: 'De usted' },
                  ]}
                />
              </div>
            </div>
          </Card>

          <Card title="Vocabulario" icon={ListChecks}>
            <div className="grid-2">
              <div className="field" role="group" aria-labelledby={ids.wordsUse}>
                <span className="label" id={ids.wordsUse}>
                  Palabras o expresiones que sueles usar
                </span>
                <TagInput value={draft.wordsToUse} onChange={(v) => set('wordsToUse', v)} placeholder="Ej.: a tu ritmo" />
                {errors.wordsToUse ? <span className="error-text">{errors.wordsToUse}</span> : <span className="hint">Escribe y pulsa Enter para añadir cada una. KAI las usará cuando encajen.</span>}
              </div>
              <div className="field" role="group" aria-labelledby={ids.wordsAvoid}>
                <span className="label" id={ids.wordsAvoid}>
                  Palabras que nunca usarías
                </span>
                <TagInput value={draft.wordsToAvoid} onChange={(v) => set('wordsToAvoid', v)} placeholder="Ej.: dieta milagro" />
                {errors.wordsToAvoid ? <span className="error-text">{errors.wordsToAvoid}</span> : <span className="hint">KAI las evitará siempre.</span>}
              </div>
            </div>
          </Card>

          <Card title="Ejemplos de cómo escribes" icon={MessageSquareText}>
            <p className="muted small" style={{ marginBottom: 12 }}>
              Pega algunos mensajes reales que hayas enviado tú a posibles clientes. KAI los usa para imitar tu forma de escribir (no los copia tal cual). Quita los datos personales de otras personas antes de pegarlos.
            </p>
            <div className="col gap-16">
              <div className="grid-2">
                <Field
                  label={
                    <span className="row gap-4">
                      <WhatsAppIcon /> Mensajes de WhatsApp
                    </span>
                  }
                  htmlFor={ids.exWa}
                  error={errors.examplesWhatsapp}
                >
                  <Textarea id={ids.exWa} rows={6} value={draft.examplesWhatsapp} maxLength={LIMITS.examples} placeholder={'Ej.:\n¡Hola, Marta! Gracias por escribirme. Cuéntame, ¿qué te gustaría conseguir?'} onChange={(e) => set('examplesWhatsapp', e.target.value)} />
                  <CharCount value={draft.examplesWhatsapp} max={LIMITS.examples} />
                </Field>
                <Field
                  label={
                    <span className="row gap-4">
                      <InstagramIcon /> Mensajes de Instagram
                    </span>
                  }
                  htmlFor={ids.exIg}
                  error={errors.examplesInstagram}
                >
                  <Textarea id={ids.exIg} rows={6} value={draft.examplesInstagram} maxLength={LIMITS.examples} placeholder={'Ej.:\n¡Hola! Vi que te interesó la publicación sobre entrenar en casa. ¿Qué es lo que más te cuesta ahora mismo?'} onChange={(e) => set('examplesInstagram', e.target.value)} />
                  <CharCount value={draft.examplesInstagram} max={LIMITS.examples} />
                </Field>
              </div>
              <Field label="Otros ejemplos (opcional)" htmlFor={ids.exOther} error={errors.examplesOther} hint="Conversaciones de otros canales o respuestas que te gusten especialmente.">
                <Textarea id={ids.exOther} rows={4} value={draft.examplesOther} maxLength={LIMITS.examples} onChange={(e) => set('examplesOther', e.target.value)} />
                <CharCount value={draft.examplesOther} max={LIMITS.examples} />
              </Field>
            </div>
          </Card>

          <Card title="Indicaciones adicionales (opcional)" icon={Lightbulb}>
            <Field
              label="¿Algo más que KAI deba tener en cuenta?"
              htmlFor={ids.extra}
              error={errors.extraInstructions}
              hint="Escríbelo con tus palabras, como se lo explicarías a una persona de tu equipo. Ej.: «Si preguntan por sesiones presenciales, explica que solo trabajo online»."
            >
              <Textarea id={ids.extra} rows={4} value={draft.extraInstructions} maxLength={LIMITS.extra} onChange={(e) => set('extraInstructions', e.target.value)} />
              <CharCount value={draft.extraInstructions} max={LIMITS.extra} />
            </Field>
          </Card>

          <Card title="Ritmo de respuesta" icon={Timer}>
            <p className="muted small" style={{ marginBottom: 12 }}>
              Para que la conversación resulte natural, KAI no contesta en el mismo segundo: espera un tiempo al azar entre el mínimo y el máximo. Si el lead envía varios mensajes seguidos, KAI los responde juntos.
            </p>
            <div className="grid-2">
              <Field label="Espera mínima" htmlFor={ids.delayMin} error={errors.replyDelayMinSeconds}>
                <NumInput id={ids.delayMin} value={draft.replyDelayMinSeconds} min={0} max={LIMITS.delay} suffix={`segundos · ${humanSeconds(draft.replyDelayMinSeconds)}`} invalid={Boolean(errors.replyDelayMinSeconds)} onChange={(v) => set('replyDelayMinSeconds', v)} />
              </Field>
              <Field label="Espera máxima" htmlFor={ids.delayMax} error={errors.replyDelayMaxSeconds}>
                <NumInput id={ids.delayMax} value={draft.replyDelayMaxSeconds} min={0} max={LIMITS.delay} suffix={`segundos · ${humanSeconds(draft.replyDelayMaxSeconds)}`} invalid={Boolean(errors.replyDelayMaxSeconds)} onChange={(v) => set('replyDelayMaxSeconds', v)} />
              </Field>
            </div>
            <p className="subtle xs mt-8">Valores por defecto: entre 20 y 70 segundos.</p>
          </Card>
        </div>

        <PreviewCard ai={settings.ai} assistantName={draft.assistantName} dirty={dirty} overrides={previewOverrides} skipped={skippedFields} />
      </div>

      <SaveBar dirty={dirty} saving={save.isPending} canEdit={canEdit} error={firstError} onDiscard={reset} onSave={() => save.mutate()} saveLabel="Guardar personalidad" />
    </>
  );
}
