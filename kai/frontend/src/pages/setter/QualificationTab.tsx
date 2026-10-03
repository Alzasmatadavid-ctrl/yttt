/* Pestaña «Cualificación»: variables que KAI averigua, su orden y su peso en la puntuación. */
import { useId, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, Calculator, ChevronDown, ChevronUp, ListChecks, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { STANDARD_QUALIFICATION_KEYS } from '@shared';
import { api, errorText } from '../../lib/api';
import { Button, Callout, Card, ConfirmDialog, Field, Input, Modal, Switch, Textarea, useToast } from '../../components/ui';
import type { QualificationRule } from '../../lib/types';
import { CharCount, KEY_PATTERN, NumInput, SaveBar, slugify, useDraft, useReportDirty, type TabProps } from './setter-shared';

type RuleDraft = Omit<QualificationRule, 'id' | 'sortOrder'>;
type RuleErrors = Partial<Record<'label' | 'description' | 'question' | 'weight' | 'disqualifyWhen', string>>;

const STANDARD = new Set<string>(STANDARD_QUALIFICATION_KEYS);
const MAX_RULES = 25;
const MAX_WEIGHT = 50;

function toDraft(rules: QualificationRule[]): RuleDraft[] {
  return [...rules]
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map(({ key, label, description, question, weight, required, enabled, disqualifyWhen }) => ({
      key,
      label,
      description: description ?? '',
      question: question ?? '',
      weight,
      required,
      enabled,
      disqualifyWhen: disqualifyWhen ?? '',
    }));
}

function validateRule(r: RuleDraft): RuleErrors {
  const e: RuleErrors = {};
  const label = r.label.trim();
  if (label.length < 2) e.label = 'El nombre debe tener al menos 2 caracteres.';
  else if (label.length > 60) e.label = 'Máximo 60 caracteres.';
  if (r.description.trim().length > 300) e.description = 'Máximo 300 caracteres.';
  if (r.question.trim().length > 300) e.question = 'Máximo 300 caracteres.';
  if (r.disqualifyWhen.trim().length > 300) e.disqualifyWhen = 'Máximo 300 caracteres.';
  if (!Number.isInteger(r.weight) || r.weight < 0 || r.weight > MAX_WEIGHT) e.weight = `El peso debe ser un número entero entre 0 y ${MAX_WEIGHT}.`;
  return e;
}

// ───────────── Alta de variable personalizada ─────────────
function CustomRuleModal({ open, onClose, taken, onAdd }: { open: boolean; onClose: () => void; taken: Set<string>; onAdd: (rule: RuleDraft) => void }) {
  const ids = { label: useId(), key: useId(), description: useId(), question: useId() };
  const [label, setLabel] = useState('');
  const [key, setKey] = useState('');
  const [keyTouched, setKeyTouched] = useState(false);
  const [description, setDescription] = useState('');
  const [question, setQuestion] = useState('');
  const [submitted, setSubmitted] = useState(false);

  const suggested = label.trim() ? `custom_${slugify(label, 30)}`.replace(/_+$/, '') : '';
  const effectiveKey = keyTouched ? key : suggested;
  const errors: Record<string, string> = {};
  if (label.trim().length < 2) errors.label = 'Escribe un nombre de al menos 2 caracteres.';
  else if (label.trim().length > 60) errors.label = 'Máximo 60 caracteres.';
  if (!KEY_PATTERN.test(effectiveKey)) errors.key = 'Usa solo minúsculas, números y guiones bajos, sin espacios ni tildes, empezando por una letra (entre 2 y 41 caracteres).';
  else if (STANDARD.has(effectiveKey)) errors.key = 'Ese identificador está reservado para una variable estándar.';
  else if (taken.has(effectiveKey)) errors.key = 'Ya existe una variable con ese identificador.';
  if (description.length > 300) errors.description = 'Máximo 300 caracteres.';
  if (question.length > 300) errors.question = 'Máximo 300 caracteres.';
  const valid = Object.keys(errors).length === 0;

  const close = () => {
    setLabel('');
    setKey('');
    setKeyTouched(false);
    setDescription('');
    setQuestion('');
    setSubmitted(false);
    onClose();
  };
  const submit = () => {
    setSubmitted(true);
    if (!valid) return;
    onAdd({ key: effectiveKey, label: label.trim(), description: description.trim(), question: question.trim(), weight: 5, required: false, enabled: true, disqualifyWhen: '' });
    close();
  };
  const show = (field: string) => (submitted || field === 'key' ? errors[field] : undefined);

  return (
    <Modal
      open={open}
      onClose={close}
      title="Nueva variable personalizada"
      footer={
        <>
          <Button onClick={close}>Cancelar</Button>
          <Button variant="primary" icon={Plus} onClick={submit} disabled={submitted && !valid}>
            Añadir variable
          </Button>
        </>
      }
    >
      <div className="col gap-12">
        <p className="muted small">Añade cualquier dato que quieras que KAI averigüe y tenga en cuenta para puntuar, por ejemplo el horario disponible para entrenar o si tiene material en casa.</p>
        <Field label="Nombre" htmlFor={ids.label} error={show('label')}>
          <Input id={ids.label} value={label} maxLength={60} placeholder="Ej.: Horario disponible" onChange={(e) => setLabel(e.target.value)} />
        </Field>
        <Field
          label="Identificador interno"
          htmlFor={ids.key}
          error={effectiveKey ? show('key') : undefined}
          hint="Lo usamos internamente para guardar el dato. Se genera solo a partir del nombre: no hace falta que lo cambies."
        >
          <Input
            id={ids.key}
            value={effectiveKey}
            maxLength={41}
            placeholder="custom_horario"
            onChange={(e) => {
              setKeyTouched(true);
              setKey(e.target.value.toLowerCase().replace(/\s+/g, '_'));
            }}
          />
        </Field>
        <Field label="Qué significa (opcional)" htmlFor={ids.description} error={show('description')} hint="KAI usa esta descripción para saber qué información buscar en la conversación.">
          <Textarea id={ids.description} rows={2} value={description} maxLength={300} placeholder="Ej.: Días y horas en los que puede entrenar." onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <Field label="Pregunta sugerida (opcional)" htmlFor={ids.question} error={show('question')}>
          <Input id={ids.question} value={question} maxLength={300} placeholder="Ej.: ¿Qué días y a qué horas te vendría mejor entrenar?" onChange={(e) => setQuestion(e.target.value)} />
        </Field>
        <p className="subtle xs">La variable se añade al final de la lista con peso 5. Podrás ajustarla antes de guardar.</p>
      </div>
    </Modal>
  );
}

// ───────────── Fila de variable ─────────────
function RuleItem({
  rule,
  index,
  total,
  open,
  share,
  errors,
  onToggle,
  onChange,
  onMove,
  onRemove,
}: {
  rule: RuleDraft;
  index: number;
  total: number;
  open: boolean;
  share: number | null;
  errors: RuleErrors;
  onToggle: () => void;
  onChange: (patch: Partial<RuleDraft>) => void;
  onMove: (dir: -1 | 1) => void;
  onRemove: () => void;
}) {
  const ids = { label: useId(), weight: useId(), description: useId(), question: useId(), disqualify: useId(), body: useId() };
  const standard = STANDARD.has(rule.key);
  const name = rule.label.trim() || 'Variable sin nombre';
  const hasErrors = Object.keys(errors).length > 0;
  return (
    <div className={`setter-item ${open ? 'is-open' : ''} ${rule.enabled ? '' : 'is-off'}`}>
      <div className="setter-item-head">
        <span className="setter-order" aria-label={`Posición ${index + 1}`}>
          {index + 1}
        </span>
        <div className="setter-item-main">
          <div className="row wrap" style={{ gap: 6 }}>
            <strong className="setter-item-title">{name}</strong>
            {standard ? <span className="badge">Estándar</span> : <span className="badge badge-violet">Personalizada</span>}
            {rule.required && rule.enabled && <span className="badge badge-warning">Obligatoria</span>}
            {!rule.enabled && <span className="badge">Desactivada</span>}
            {hasErrors && <span className="badge badge-danger">Revisar</span>}
          </div>
          <div className="subtle small ellipsis">{rule.question.trim() ? `«${rule.question.trim()}»` : rule.description || 'Sin pregunta sugerida'}</div>
        </div>
        <div className="setter-weight">{rule.enabled ? (share === null ? `Peso ${rule.weight}` : `Peso ${rule.weight} · ${share} %`) : 'No puntúa'}</div>
        <div className="setter-actions">
          <Button variant="ghost" size="sm" iconOnly icon={ArrowUp} disabled={index === 0} onClick={() => onMove(-1)}>
            {`Subir «${name}»`}
          </Button>
          <Button variant="ghost" size="sm" iconOnly icon={ArrowDown} disabled={index === total - 1} onClick={() => onMove(1)}>
            {`Bajar «${name}»`}
          </Button>
          <Button size="sm" icon={open ? ChevronUp : ChevronDown} aria-expanded={open} aria-controls={ids.body} onClick={onToggle}>
            {open ? 'Cerrar' : 'Editar'}
          </Button>
        </div>
      </div>
      {open && (
        <div className="setter-item-body" id={ids.body}>
          <div className="grid-2">
            <Field label="Nombre" htmlFor={ids.label} error={errors.label}>
              <Input id={ids.label} value={rule.label} maxLength={60} onChange={(e) => onChange({ label: e.target.value })} />
            </Field>
            <Field label={`Peso (0–${MAX_WEIGHT})`} htmlFor={ids.weight} error={errors.weight} hint="Cuánto cuenta esta variable en la puntuación del lead.">
              <div className="row" style={{ gap: 12 }}>
                <input type="range" className="range" min={0} max={MAX_WEIGHT} step={1} value={Math.min(MAX_WEIGHT, Math.max(0, rule.weight || 0))} aria-label={`Peso de «${name}»`} onChange={(e) => onChange({ weight: Number(e.target.value) })} />
                <NumInput id={ids.weight} value={rule.weight} min={0} max={MAX_WEIGHT} width={80} invalid={Boolean(errors.weight)} onChange={(v) => onChange({ weight: v })} />
              </div>
            </Field>
          </div>
          <Field label="Qué significa" htmlFor={ids.description} error={errors.description} hint="KAI usa esta descripción para saber qué información buscar en la conversación.">
            <Textarea id={ids.description} rows={2} value={rule.description} maxLength={300} onChange={(e) => onChange({ description: e.target.value })} />
          </Field>
          <Field
            label="Pregunta sugerida"
            htmlFor={ids.question}
            error={errors.question}
            hint="KAI la adapta a cada conversación, no la copia literal. Si la dejas vacía, KAI no preguntará por esto directamente, aunque lo tendrá en cuenta si el lead lo cuenta."
          >
            <Input id={ids.question} value={rule.question} maxLength={300} onChange={(e) => onChange({ question: e.target.value })} />
          </Field>
          <Field
            label="Criterio de no encaje (opcional)"
            htmlFor={ids.disqualify}
            error={errors.disqualifyWhen}
            hint="Describe cuándo un lead NO encaja por este motivo. Si se cumple, KAI se despide con amabilidad, no propone la llamada y el lead queda con una puntuación baja."
          >
            <Textarea id={ids.disqualify} rows={2} value={rule.disqualifyWhen} maxLength={300} placeholder="Ej.: Es menor de edad." onChange={(e) => onChange({ disqualifyWhen: e.target.value })} />
            <CharCount value={rule.disqualifyWhen} max={300} />
          </Field>
          <div>
            <div className="setter-toggle-row">
              <div>
                <strong>Activa</strong>
                <p className="muted small">Si la desactivas, KAI no preguntará por ella ni contará para la puntuación.</p>
              </div>
              <Switch checked={rule.enabled} onChange={(enabled) => onChange({ enabled })} label={<span className="sr-only">{`«${name}» activa`}</span>} />
            </div>
            <div className="setter-toggle-row">
              <div>
                <strong>Obligatoria</strong>
                <p className="muted small">KAI necesita conocer este dato antes de proponer la llamada por su cuenta. Si el lead pide la llamada directamente, se la ofrecerá igualmente.</p>
              </div>
              <Switch checked={rule.required} onChange={(required) => onChange({ required })} label={<span className="sr-only">{`«${name}» obligatoria`}</span>} />
            </div>
          </div>
          <div className="row-between wrap">
            {standard ? (
              <span className="subtle xs">Las variables estándar no se pueden eliminar; si no te sirve, desactívala.</span>
            ) : (
              <span className="subtle xs">
                Identificador interno: <span className="code-inline">{rule.key}</span>
              </span>
            )}
            {!standard && (
              <Button variant="danger" size="sm" icon={Trash2} onClick={onRemove}>
                Eliminar variable
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ───────────── Pestaña ─────────────
export default function QualificationTab({ settings, canEdit, onDirtyChange }: TabProps) {
  const qc = useQueryClient();
  const toast = useToast();
  const { draft, setDraft, dirty, reset, markSaved } = useDraft(toDraft(settings.qualificationRules));
  useReportDirty(onDirtyChange, dirty);
  const [openKeys, setOpenKeys] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState(false);
  const [confirmRescore, setConfirmRescore] = useState(false);

  const active = draft.filter((r) => r.enabled);
  const totalWeight = active.reduce((s, r) => s + (Number.isFinite(r.weight) ? r.weight : 0), 0);
  const requiredCount = active.filter((r) => r.required).length;
  const errorsByKey = Object.fromEntries(draft.map((r) => [r.key, validateRule(r)])) as Record<string, RuleErrors>;
  const invalidRule = draft.find((r) => Object.keys(errorsByKey[r.key]).length > 0);
  const globalError =
    draft.length === 0
      ? 'Necesitas al menos una variable.'
      : draft.length > MAX_RULES
        ? `Puedes tener como máximo ${MAX_RULES} variables.`
        : !draft.some((r) => r.enabled && r.weight > 0)
          ? 'Activa al menos una variable con peso mayor que 0.'
          : invalidRule
            ? `Revisa la variable «${invalidRule.label.trim() || invalidRule.key}»: ${Object.values(errorsByKey[invalidRule.key])[0]}`
            : null;

  const update = (key: string, patch: Partial<RuleDraft>) => setDraft((rules) => rules.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const move = (index: number, dir: -1 | 1) =>
    setDraft((rules) => {
      const next = [...rules];
      const target = index + dir;
      if (target < 0 || target >= next.length) return rules;
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  const toggleOpen = (key: string) =>
    setOpenKeys((s) => {
      const n = new Set(s);
      if (n.has(key)) n.delete(key);
      else n.add(key);
      return n;
    });

  const save = useMutation({
    mutationFn: async () => {
      const rules: RuleDraft[] = draft.map((r) => ({
        ...r,
        label: r.label.trim(),
        description: r.description.trim(),
        question: r.question.trim(),
        disqualifyWhen: r.disqualifyWhen.trim(),
      }));
      await api.put('/settings/qualification', { rules });
      return rules;
    },
    onSuccess: (rules) => {
      markSaved(rules);
      toast('Cualificación guardada. Si quieres aplicar ya los nuevos pesos a tus leads, pulsa «Recalcular puntuaciones».');
      void qc.invalidateQueries({ queryKey: ['settings'] });
    },
    onError: (e) => toast(errorText(e), 'error'),
  });

  const rescore = useMutation({
    mutationFn: () => api.post<{ ok: boolean; rescored: number }>('/settings/rescore-all'),
    onSuccess: (r) => {
      setConfirmRescore(false);
      toast(r.rescored === 0 ? 'No hay leads abiertos que recalcular.' : r.rescored === 1 ? 'Puntuación recalculada en 1 lead.' : `Puntuaciones recalculadas en ${r.rescored.toLocaleString('es-ES')} leads.`);
      for (const key of ['leads', 'lead', 'dashboard', 'inbox', 'conversation', 'analytics']) void qc.invalidateQueries({ queryKey: [key] });
    },
    onError: (e) => toast(errorText(e), 'error'),
  });

  return (
    <>
      <p className="setter-lead">
        Estas son las cosas que KAI intenta averiguar de cada lead para saber si encaja contigo. Pregunta de una en una, con naturalidad y en el orden de esta lista (no como un formulario). Con lo que va sabiendo calcula una puntuación interna de 0 a 100.
      </p>

      <Card title="Resumen" icon={Calculator}>
        <div className="setter-summary">
          <div>
            <span className="subtle small">Variables activas</span>
            <strong>
              {active.length} <span className="subtle small">de {draft.length}</span>
            </strong>
          </div>
          <div>
            <span className="subtle small">Suma de pesos</span>
            <strong>{totalWeight}</strong>
          </div>
          <div>
            <span className="subtle small">Obligatorias</span>
            <strong>{requiredCount}</strong>
          </div>
        </div>
        <p className="muted small mt-12">
          No hace falta que los pesos sumen 100: lo que importa es la proporción entre ellos. Una variable con peso 10 de un total de {totalWeight || 100} aporta hasta {totalWeight ? Math.round((10 / totalWeight) * 100) : 10} puntos de los 100 posibles.
        </p>
      </Card>

      <Card
        title="Variables de cualificación"
        icon={ListChecks}
        actions={
          <Button size="sm" icon={Plus} onClick={() => setAdding(true)} disabled={draft.length >= MAX_RULES}>
            Añadir variable personalizada
          </Button>
        }
      >
        <p className="muted small" style={{ marginBottom: 12 }}>
          Usa las flechas para cambiar el orden en el que KAI pregunta. Pulsa «Editar» para cambiar la pregunta, el peso o si es obligatoria.
        </p>
        <div className="setter-list">
          {draft.map((r, i) => (
            <RuleItem
              key={r.key}
              rule={r}
              index={i}
              total={draft.length}
              open={openKeys.has(r.key)}
              share={r.enabled && totalWeight > 0 ? Math.round((r.weight / totalWeight) * 100) : null}
              errors={errorsByKey[r.key]}
              onToggle={() => toggleOpen(r.key)}
              onChange={(patch) => update(r.key, patch)}
              onMove={(dir) => move(i, dir)}
              onRemove={() => setDraft((rules) => rules.filter((x) => x.key !== r.key))}
            />
          ))}
        </div>
      </Card>

      <Card title="Recalcular puntuaciones" icon={RefreshCw}>
        <div className="row-between wrap" style={{ alignItems: 'flex-start' }}>
          <p className="muted small grow" style={{ minWidth: 240 }}>
            Los cambios en pesos y variables se aplican a cada lead la próxima vez que escriba. Si quieres actualizar ya la puntuación de todos tus leads abiertos (no se tocan clientes ni perdidos), recalcúlalas ahora.
          </p>
          <Button icon={RefreshCw} loading={rescore.isPending} disabled={!canEdit || dirty} onClick={() => setConfirmRescore(true)}>
            Recalcular puntuaciones
          </Button>
        </div>
        {dirty && canEdit && (
          <div className="mt-12">
            <Callout tone="info">Guarda primero tus cambios para que el recálculo use los nuevos pesos.</Callout>
          </div>
        )}
      </Card>

      <SaveBar dirty={dirty} saving={save.isPending} canEdit={canEdit} error={globalError} onDiscard={reset} onSave={() => save.mutate()} saveLabel="Guardar cualificación" />

      <ConfirmDialog
        open={confirmRescore}
        title="¿Recalcular las puntuaciones?"
        message="KAI volverá a calcular la puntuación y la temperatura de todos tus leads abiertos con las variables y pesos guardados. Si alguno pasa a estar interesado o cualificado, también avanzará de etapa en tu pipeline. No se envía ningún mensaje a nadie."
        confirmLabel="Recalcular ahora"
        loading={rescore.isPending}
        onConfirm={() => rescore.mutate()}
        onClose={() => setConfirmRescore(false)}
      />

      <CustomRuleModal
        open={adding}
        onClose={() => setAdding(false)}
        taken={new Set(draft.map((r) => r.key))}
        onAdd={(rule) => {
          setDraft((rules) => [...rules, rule]);
          setOpenKeys((s) => new Set(s).add(rule.key));
        }}
      />
    </>
  );
}
