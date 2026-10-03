/* Piezas comunes de la configuración del setter: borradores con “cambios sin guardar”, barra de guardado y controles. */
import { useCallback, useEffect, useId, useState, type ReactNode } from 'react';
import { RotateCcw, Save, type LucideIcon } from 'lucide-react';
import { Button, Input, Segmented } from '../../components/ui';
import type { SettingsResponse } from '../../lib/types';

/** Propiedades que reciben todas las pestañas. */
export interface TabProps {
  settings: SettingsResponse;
  canEdit: boolean;
  onDirtyChange: (dirty: boolean) => void;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Borrador editable de una parte de la configuración.
 * - Si llegan datos nuevos del servidor y NO hay cambios pendientes, el borrador se actualiza solo.
 * - Si hay cambios pendientes, se conservan (no se pisa lo que el entrenador está escribiendo).
 */
export function useDraft<T>(source: T) {
  const sourceKey = JSON.stringify(source);
  const [state, setState] = useState(() => ({ key: sourceKey, base: source, draft: source }));
  let current = state;
  if (state.key !== sourceKey) {
    const pending = !same(state.draft, state.base);
    current = { key: sourceKey, base: source, draft: pending ? state.draft : source };
    setState(current);
  }
  const setDraft = useCallback((update: T | ((prev: T) => T)) => {
    setState((s) => ({ ...s, draft: typeof update === 'function' ? (update as (prev: T) => T)(s.draft) : update }));
  }, []);
  const reset = useCallback(() => setState((s) => ({ ...s, draft: s.base })), []);
  /** Marca el borrador (o la versión indicada) como guardado. */
  const markSaved = useCallback((saved?: T) => setState((s) => ({ ...s, base: saved ?? s.draft, draft: saved ?? s.draft })), []);
  return { draft: current.draft, base: current.base, setDraft, reset, markSaved, dirty: !same(current.draft, current.base) };
}

/** Comunica a la página si la pestaña tiene cambios sin guardar. */
export function useReportDirty(onDirtyChange: (dirty: boolean) => void, dirty: boolean) {
  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);
}

/** Barra fija inferior con el estado de guardado y el botón Guardar de la pestaña. */
export function SaveBar({
  dirty,
  saving,
  onSave,
  onDiscard,
  canEdit,
  error,
  saveLabel = 'Guardar',
}: {
  dirty: boolean;
  saving: boolean;
  onSave: () => void;
  onDiscard: () => void;
  canEdit: boolean;
  error?: string | null;
  saveLabel?: string;
}) {
  return (
    <div className={`setter-savebar ${dirty ? 'is-dirty' : ''}`} role="region" aria-label="Guardar cambios de esta sección">
      <div className="grow small" aria-live="polite">
        {!canEdit ? (
          <span className="muted">Solo la persona titular del negocio puede guardar cambios aquí.</span>
        ) : dirty && error ? (
          <span className="error-text">{error}</span>
        ) : dirty ? (
          <span className="row gap-4" style={{ gap: 8 }}>
            <span className="setter-dot" aria-hidden />
            <strong>Tienes cambios sin guardar</strong>
          </span>
        ) : (
          <span className="subtle">Todo está guardado.</span>
        )}
      </div>
      {dirty && (
        <Button variant="ghost" size="sm" icon={RotateCcw} onClick={onDiscard} disabled={saving}>
          Descartar
        </Button>
      )}
      <Button variant="primary" size="sm" icon={Save} loading={saving} disabled={!dirty || !canEdit || Boolean(error)} onClick={onSave}>
        {saveLabel}
      </Button>
    </div>
  );
}

/** Grupo de opciones cortas (Segmented) con etiqueta accesible. */
export function ChoiceGroup<T extends string>({ label, hint, value, onChange, options }: { label: string; hint?: ReactNode; value: T; onChange: (v: T) => void; options: { value: T; label: string }[] }) {
  const id = useId();
  return (
    <div className="field">
      <span className="label" id={id}>
        {label}
      </span>
      <div role="group" aria-labelledby={id}>
        <Segmented value={value} onChange={onChange} options={options} />
      </div>
      {hint && <span className="hint">{hint}</span>}
    </div>
  );
}

/** Tarjetas de opción grandes, con explicación de cada alternativa. */
export function OptionCards<T extends string>({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: T;
  onChange: (v: T) => void;
  options: { value: T; title: string; description: ReactNode; icon?: LucideIcon; badge?: string }[];
}) {
  const id = useId();
  return (
    <div className="field">
      <span className="label" id={id}>
        {label}
      </span>
      <div className="option-grid" role="group" aria-labelledby={id} style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))' }}>
        {options.map((o) => {
          const Icon = o.icon;
          return (
            <button key={o.value} type="button" className="option" aria-pressed={value === o.value} onClick={() => onChange(o.value)}>
              {(Icon || o.badge) && (
                <span className="setter-option-head">
                  {Icon ? <Icon aria-hidden /> : <span />}
                  {o.badge && <span className="badge badge-accent">{o.badge}</span>}
                </span>
              )}
              <strong>{o.title}</strong>
              <span className="muted small">{o.description}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** Deslizador 1–5 con el valor expresado en palabras. */
export function ToneSlider({ label, hint, scale, value, onChange }: { label: string; hint: string; scale: string[]; value: number; onChange: (v: number) => void }) {
  const id = useId();
  const safe = Math.min(5, Math.max(1, Math.round(value) || 3));
  const text = scale[safe - 1];
  return (
    <div className="field">
      <div className="row-between">
        <label className="label" htmlFor={id}>
          {label}
        </label>
        <span className="setter-slider-value">{text}</span>
      </div>
      <input id={id} type="range" className="range" min={1} max={5} step={1} value={safe} aria-valuetext={text} onChange={(e) => onChange(Number(e.target.value))} />
      <div className="setter-slider-scale" aria-hidden>
        <span>{scale[0]}</span>
        <span>{scale[4]}</span>
      </div>
      <span className="hint">{hint}</span>
    </div>
  );
}

/**
 * Campo numérico que permite borrar y reescribir el número sin que salte a 0.
 * Solo comunica valores numéricos válidos; al salir del campo muestra el último valor válido.
 */
export function NumInput({
  id,
  value,
  onChange,
  min,
  max,
  step = 1,
  suffix,
  ariaLabel,
  invalid,
  width = 110,
  disabled,
}: {
  id?: string;
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  suffix?: ReactNode;
  ariaLabel?: string;
  invalid?: boolean;
  width?: number;
  disabled?: boolean;
}) {
  const [text, setText] = useState(String(value));
  const [prev, setPrev] = useState(value);
  if (value !== prev) {
    setPrev(value);
    if (Number(text.replace(',', '.')) !== value) setText(String(value));
  }
  return (
    <div className="setter-num">
      <Input
        id={id}
        type="number"
        inputMode={step < 1 ? 'decimal' : 'numeric'}
        min={min}
        max={max}
        step={step}
        value={text}
        disabled={disabled}
        aria-label={ariaLabel}
        aria-invalid={invalid || undefined}
        style={{ width }}
        onChange={(e) => {
          const raw = e.target.value;
          setText(raw);
          const n = Number(raw.replace(',', '.'));
          if (raw.trim() !== '' && Number.isFinite(n)) onChange(n);
        }}
        onBlur={() => setText(String(value))}
      />
      {suffix && <span className="setter-suffix">{suffix}</span>}
    </div>
  );
}

/** Contador de caracteres para textos con límite. */
export function CharCount({ value, max }: { value: string; max: number }) {
  return (
    <span className={`setter-counter ${value.length > max ? 'is-over' : ''}`}>
      {value.length.toLocaleString('es-ES')} / {max.toLocaleString('es-ES')}
    </span>
  );
}

// ───────────── Utilidades ─────────────

const fmt1 = (n: number) => n.toLocaleString('es-ES', { maximumFractionDigits: 1 });

/** 75 → «1 min 15 s». */
export function humanSeconds(s: number): string {
  if (!Number.isFinite(s) || s <= 0) return 'al instante';
  const m = Math.floor(s / 60);
  const r = Math.round(s % 60);
  if (m === 0) return `${r} s`;
  return r ? `${m} min ${r} s` : `${m} min`;
}

/** 0,5 → «30 min»; 4 → «4 h»; 72 → «3 días». */
export function humanHours(h: number): string {
  if (!Number.isFinite(h) || h <= 0) return '—';
  if (h < 1) return `${Math.round(h * 60)} min`;
  if (h < 24) return `${fmt1(h)} h`;
  const d = h / 24;
  return `${fmt1(d)} ${d === 1 ? 'día' : 'días'}`;
}

/** 90 → «1 h 30 min». */
export function humanMinutes(m: number): string {
  if (!Number.isFinite(m) || m <= 0) return 'al momento';
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r ? `${h} h ${r} min` : `${h} h`;
}

/** Convierte lo que escribe el entrenador («149», «149,90», «1.200») a céntimos. */
export function parseEurosToCents(raw: string): number | null {
  let s = raw.replace(/[€\s]/g, '');
  if (!s) return null;
  if (s.includes(',') && s.includes('.')) s = s.replace(/\./g, '').replace(',', '.');
  else if (s.includes(',')) s = s.replace(',', '.');
  else if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  return Math.round(Number(s) * 100);
}

/** 14990 → «149,90»; 15000 → «150». */
export function centsToText(cents: number): string {
  return cents % 100 === 0 ? String(cents / 100) : (cents / 100).toFixed(2).replace('.', ',');
}

/** Clave interna válida para el backend (minúsculas, sin espacios ni tildes, empieza por letra). */
export const KEY_PATTERN = /^[a-z][a-z0-9_]{1,40}$/;

export function slugify(text: string, maxLength = 30): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, maxLength)
    .replace(/_+$/g, '');
}

/** Genera una clave única a partir de un texto («Es caro» → «es_caro»). */
export function uniqueKey(text: string, taken: Set<string>, prefix: string): string {
  let base = slugify(text, 32);
  if (!/^[a-z]/.test(base) || base.length < 2) base = base ? `${prefix}_${base}` : prefix;
  let key = base;
  let n = 2;
  while (taken.has(key)) key = `${base}_${n++}`;
  return key;
}

export const isTime = (v: string | undefined) => Boolean(v && /^\d{2}:\d{2}$/.test(v));
