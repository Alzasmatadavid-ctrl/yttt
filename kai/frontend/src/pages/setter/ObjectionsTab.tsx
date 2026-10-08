/* Pestaña «Objeciones»: biblioteca de objeciones y cómo las trata KAI. */
import { useId, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { BookOpen, ChevronDown, ChevronUp, HeartHandshake, Plus, Trash2 } from 'lucide-react';
import { api, errorText } from '../../lib/api';
import { Button, Card, EmptyState, Field, Input, Switch, TagInput, Textarea, useToast } from '../../components/ui';
import type { Objection } from '../../lib/types';
import { CharCount, SaveBar, uniqueKey, useDraft, useReportDirty, type TabProps } from './setter-shared';

interface ObjectionDraft {
  uid: string;
  key: string;
  label: string;
  triggers: string[];
  strategy: string;
  exampleResponse: string;
  enabled: boolean;
}
type ObjectionErrors = Partial<Record<'label' | 'triggers' | 'strategy' | 'exampleResponse', string>>;

const MAX_OBJECTIONS = 40;

const STEPS = [
  { title: 'Validar', text: 'Reconoce lo que siente el lead, sin discutir ni quitarle importancia.' },
  { title: 'Entender', text: 'Averigua qué hay de verdad detrás de la objeción.' },
  { title: 'Profundizar', text: 'Hace una sola pregunta para concretar (con qué lo compara, qué le preocupa…).' },
  { title: 'Responder', text: 'Contesta con información real de tu servicio, sin inventar ni prometer resultados.' },
  { title: 'Avanzar', text: 'Propone el siguiente paso con naturalidad, sin presionar.' },
];

const toDraft = (list: Objection[]): ObjectionDraft[] =>
  list.map((o) => ({ uid: o.key, key: o.key, label: o.label, triggers: o.triggers ?? [], strategy: o.strategy ?? '', exampleResponse: o.exampleResponse ?? '', enabled: o.enabled }));

function validateObjection(o: ObjectionDraft): ObjectionErrors {
  const e: ObjectionErrors = {};
  const label = o.label.trim();
  if (label.length < 2) e.label = 'Escribe un nombre de al menos 2 caracteres.';
  else if (label.length > 80) e.label = 'Máximo 80 caracteres.';
  if (o.triggers.length > 20) e.triggers = 'Máximo 20 frases.';
  else if (o.triggers.some((t) => t.length < 2 || t.length > 60)) e.triggers = 'Cada frase debe tener entre 2 y 60 caracteres.';
  if (o.strategy.trim().length > 1500) e.strategy = 'Máximo 1500 caracteres.';
  if (o.exampleResponse.trim().length > 700) e.exampleResponse = 'Máximo 700 caracteres.';
  return e;
}

function ObjectionItem({
  item,
  open,
  errors,
  onToggle,
  onChange,
  onRemove,
}: {
  item: ObjectionDraft;
  open: boolean;
  errors: ObjectionErrors;
  onToggle: () => void;
  onChange: (patch: Partial<ObjectionDraft>) => void;
  onRemove: () => void;
}) {
  const ids = { label: useId(), triggers: useId(), strategy: useId(), example: useId(), body: useId() };
  const name = item.label.trim() || 'Objeción sin nombre';
  const hasErrors = Object.keys(errors).length > 0;
  return (
    <div className={`setter-item ${open ? 'is-open' : ''} ${item.enabled ? '' : 'is-off'}`}>
      <div className="setter-item-head">
        <div className="setter-item-main">
          <div className="row wrap" style={{ gap: 6 }}>
            <strong className="setter-item-title">{name}</strong>
            {!item.key && <span className="badge badge-violet">Nueva</span>}
            {!item.enabled && <span className="badge">Desactivada</span>}
            {hasErrors && <span className="badge badge-danger">Revisar</span>}
          </div>
          <div className="subtle small ellipsis">{item.triggers.length ? `Se activa con: ${item.triggers.map((t) => `«${t}»`).join(', ')}` : 'Sin frases de activación'}</div>
        </div>
        <div className="setter-actions">
          <Switch checked={item.enabled} onChange={(enabled) => onChange({ enabled })} label={<span className="sr-only">{`«${name}» activa`}</span>} />
          <Button size="sm" icon={open ? ChevronUp : ChevronDown} aria-expanded={open} aria-controls={ids.body} onClick={onToggle}>
            {open ? 'Cerrar' : 'Editar'}
          </Button>
          <Button size="sm" variant="ghost" iconOnly icon={Trash2} onClick={onRemove}>
            {`Eliminar «${name}»`}
          </Button>
        </div>
      </div>
      {open && (
        <div className="setter-item-body" id={ids.body}>
          <Field label="Nombre de la objeción" htmlFor={ids.label} error={errors.label}>
            <Input id={ids.label} value={item.label} maxLength={80} placeholder="Ej.: Es caro" onChange={(e) => onChange({ label: e.target.value })} />
          </Field>
          <div className="field" role="group" aria-labelledby={ids.triggers}>
            <span className="label" id={ids.triggers}>
              Frases que la activan
            </span>
            <TagInput value={item.triggers} onChange={(triggers) => onChange({ triggers })} placeholder="Ej.: se me va de precio" />
            {errors.triggers ? (
              <span className="error-text">{errors.triggers}</span>
            ) : (
              <span className="hint">Expresiones típicas que usan tus leads. Son orientativas: KAI también reconoce la objeción si la dicen con otras palabras.</span>
            )}
          </div>
          <Field label="Cómo quieres que la trate" htmlFor={ids.strategy} error={errors.strategy} hint="Explica tu enfoque con tus palabras: qué preguntar, qué recordar y qué no hacer nunca.">
            <Textarea id={ids.strategy} rows={4} value={item.strategy} maxLength={1500} onChange={(e) => onChange({ strategy: e.target.value })} />
            <CharCount value={item.strategy} max={1500} />
          </Field>
          <Field label="Respuesta de ejemplo (opcional)" htmlFor={ids.example} error={errors.exampleResponse} hint="Cómo lo dirías tú. KAI se inspira en ella pero no la copia literal.">
            <Textarea id={ids.example} rows={3} value={item.exampleResponse} maxLength={700} onChange={(e) => onChange({ exampleResponse: e.target.value })} />
            <CharCount value={item.exampleResponse} max={700} />
          </Field>
        </div>
      )}
    </div>
  );
}

export default function ObjectionsTab({ settings, canEdit, onDirtyChange }: TabProps) {
  const qc = useQueryClient();
  const toast = useToast();
  const { draft, setDraft, dirty, reset, markSaved } = useDraft(toDraft(settings.objections));
  useReportDirty(onDirtyChange, dirty);
  const [openIds, setOpenIds] = useState<Set<string>>(new Set());

  const errorsById = Object.fromEntries(draft.map((o) => [o.uid, validateObjection(o)])) as Record<string, ObjectionErrors>;
  const invalid = draft.find((o) => Object.keys(errorsById[o.uid]).length > 0);
  const error =
    draft.length > MAX_OBJECTIONS
      ? `Puedes tener como máximo ${MAX_OBJECTIONS} objeciones.`
      : invalid
        ? `Revisa «${invalid.label.trim() || 'la objeción sin nombre'}»: ${Object.values(errorsById[invalid.uid])[0]}`
        : null;

  const update = (uid: string, patch: Partial<ObjectionDraft>) => setDraft((list) => list.map((o) => (o.uid === uid ? { ...o, ...patch } : o)));
  const toggleOpen = (uid: string) =>
    setOpenIds((s) => {
      const n = new Set(s);
      if (n.has(uid)) n.delete(uid);
      else n.add(uid);
      return n;
    });
  const add = () => {
    const uid = `new-${Date.now()}`;
    setDraft((list) => [...list, { uid, key: '', label: '', triggers: [], strategy: '', exampleResponse: '', enabled: true }]);
    setOpenIds((s) => new Set(s).add(uid));
  };

  const save = useMutation({
    mutationFn: async () => {
      const taken = new Set(draft.filter((o) => o.key).map((o) => o.key));
      const withKeys = draft.map((o) => {
        const base = { ...o, label: o.label.trim(), strategy: o.strategy.trim(), exampleResponse: o.exampleResponse.trim() };
        if (base.key) return base;
        const key = uniqueKey(base.label, taken, 'obj');
        taken.add(key);
        return { ...base, key, uid: key };
      });
      await api.put('/settings/objections', { objections: withKeys.map(({ uid: _uid, ...o }) => o) });
      return withKeys;
    },
    onSuccess: (saved) => {
      setOpenIds((s) => {
        // Mantiene abiertas las objeciones nuevas con su identificador definitivo.
        const n = new Set<string>();
        draft.forEach((o, i) => s.has(o.uid) && n.add(saved[i].uid));
        return n;
      });
      markSaved(saved);
      toast('Objeciones guardadas');
      void qc.invalidateQueries({ queryKey: ['settings'] });
    },
    onError: (e) => toast(errorText(e), 'error'),
  });

  const enabledCount = draft.filter((o) => o.enabled).length;

  return (
    <>
      <p className="setter-lead">
        Una objeción es una duda o freno que pone el lead antes de dar el paso («es caro», «me lo tengo que pensar»…). Aquí decides cómo quieres que KAI responda a cada una.
      </p>

      <Card title="Cómo trata KAI una objeción" icon={HeartHandshake}>
        <div className="grid-5">
          {STEPS.map((s, i) => (
            <div key={s.title} className="setter-step">
              <span className="setter-step-n" aria-hidden>
                {i + 1}
              </span>
              <strong>{s.title}</strong>
              <span className="muted small">{s.text}</span>
            </div>
          ))}
        </div>
        <p className="subtle xs mt-12">KAI nunca presiona, no da ultimátums y no rebaja el precio por su cuenta. Tu estrategia de cada objeción se aplica dentro de estos cinco pasos.</p>
      </Card>

      <Card
        title={`Biblioteca de objeciones (${enabledCount} activas)`}
        icon={BookOpen}
        actions={
          <Button size="sm" icon={Plus} onClick={add} disabled={draft.length >= MAX_OBJECTIONS}>
            Añadir objeción
          </Button>
        }
      >
        {draft.length === 0 ? (
          <EmptyState
            icon={BookOpen}
            title="No hay objeciones configuradas"
            description="Sin biblioteca, KAI tratará las dudas de forma general siguiendo los cinco pasos. Añade las objeciones que más escuchas para que responda a tu manera."
            action={
              <Button variant="primary" icon={Plus} onClick={add}>
                Añadir objeción
              </Button>
            }
          />
        ) : (
          <div className="setter-list">
            {draft.map((o) => (
              <ObjectionItem
                key={o.uid}
                item={o}
                open={openIds.has(o.uid)}
                errors={errorsById[o.uid]}
                onToggle={() => toggleOpen(o.uid)}
                onChange={(patch) => update(o.uid, patch)}
                onRemove={() => setDraft((list) => list.filter((x) => x.uid !== o.uid))}
              />
            ))}
          </div>
        )}
        {draft.length > 0 && <p className="subtle xs mt-12">Los cambios (también las eliminaciones) no se aplican hasta que pulses Guardar. Si te equivocas, pulsa Descartar.</p>}
      </Card>

      <SaveBar dirty={dirty} saving={save.isPending} canEdit={canEdit} error={error} onDiscard={reset} onSave={() => save.mutate()} saveLabel="Guardar objeciones" />
    </>
  );
}
