/* Planes de KAI: precio, límites y funciones. Los límites viven en la base de datos y se aplican al instante. */
import { useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, CreditCard, Info, Minus, Pencil, Plus, Save } from 'lucide-react';
import { BILLING_PERIOD_LABELS, formatMoney, type PlanLimits } from '@shared';
import { api, errorText } from '../../lib/api';
import { Button, Callout, Card, EmptyState, Field, Input, Modal, PageHeader, PageLoading, Switch, Textarea, useToast } from '../../components/ui';
import { ADMIN_KEYS, QueryError, num, type AdminPlan } from './admin-shared';
import '../../styles/admin.css';

/** Clave del plan que el servidor asigna a los negocios nuevos (DEFAULT_PLAN_KEY en backend/src/config/defaults.ts). */
const DEFAULT_PLAN_KEY = 'starter';

type LimitKey = 'maxLeadsPerMonth' | 'maxAiMessagesPerMonth' | 'maxTeamMembers' | 'maxChannels' | 'maxBusinesses';
type FeatureKey = 'copilot' | 'advancedAnalytics';

const LIMIT_FIELDS: { key: LimitKey; label: string; short: string; hint: string; min: number; fallback: number }[] = [
  {
    key: 'maxLeadsPerMonth',
    label: 'Leads nuevos al mes',
    short: 'Leads/mes',
    hint: 'Leads nuevos que puede recibir cada mes. Los que lleguen por encima se guardan igualmente, pero KAI no les responde y pasa la conversación al equipo.',
    min: 0,
    fallback: 100,
  },
  {
    key: 'maxAiMessagesPerMonth',
    label: 'Mensajes de KAI al mes',
    short: 'Mensajes de KAI/mes',
    hint: 'Respuestas que KAI puede enviar al mes (las consultas a Copilot también cuentan aquí). Al llegar al límite, KAI deja de responder y avisa al entrenador.',
    min: 0,
    fallback: 1000,
  },
  {
    key: 'maxTeamMembers',
    label: 'Usuarios del equipo',
    short: 'Usuarios',
    hint: 'Personas que pueden usar el negocio, incluido el propietario. Las invitaciones pendientes también cuentan. Mínimo 1.',
    min: 1,
    fallback: 1,
  },
  {
    key: 'maxChannels',
    label: 'Canales conectados',
    short: 'Canales',
    hint: 'Canales que puede tener conectados a la vez: WhatsApp, Instagram y anuncios de Meta.',
    min: 0,
    fallback: 1,
  },
  {
    key: 'maxBusinesses',
    label: 'Negocios por propietario',
    short: 'Negocios',
    hint: 'Cuántos negocios puede crear un mismo entrenador (por ejemplo, un estudio con varias sedes). Mínimo 1.',
    min: 1,
    fallback: 1,
  },
];

const FEATURE_FIELDS: { key: FeatureKey; label: string; hint: string }[] = [
  { key: 'copilot', label: 'KAI Copilot', hint: 'Asistente al que el entrenador puede preguntar por sus leads, su agenda y sus datos.' },
  { key: 'advancedAnalytics', label: 'Analítica avanzada', hint: 'Permite analizar periodos de 90 días o fechas personalizadas y ver datos más detallados.' },
];

const KEY_RE = /^[a-z][a-z0-9_-]{1,30}$/;

interface FormState {
  key: string;
  keyTouched: boolean;
  name: string;
  description: string;
  price: string;
  sortOrder: string;
  limits: Record<LimitKey, string>;
  unlimited: Record<LimitKey, boolean>;
  copilot: boolean;
  advancedAnalytics: boolean;
  isActive: boolean;
  isPublic: boolean;
}

const centsToInput = (cents: number) => (cents % 100 === 0 ? String(cents / 100) : (cents / 100).toFixed(2).replace('.', ','));

/** “29,90” o “29.90” → 2990 céntimos. */
function parseEuros(raw: string): number | null {
  const v = raw.trim().replace(/\s|€/g, '').replace(',', '.');
  if (!/^\d+(\.\d{1,2})?$/.test(v)) return null;
  return Math.round(Number(v) * 100);
}

/** “Plan Pro Estudios” → “plan-pro-estudios”. */
function slugify(name: string) {
  const s = name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^[^a-z]+/, '')
    .replace(/-+$/, '')
    .slice(0, 31);
  return s.replace(/-+$/, '');
}

function toForm(plan: AdminPlan | null, nextOrder: number): FormState {
  const limits = {} as Record<LimitKey, string>;
  const unlimited = {} as Record<LimitKey, boolean>;
  for (const f of LIMIT_FIELDS) {
    const v = plan ? plan.limits[f.key] : f.fallback;
    unlimited[f.key] = v === null;
    limits[f.key] = v === null ? '' : String(v);
  }
  return {
    key: plan?.key ?? '',
    keyTouched: !!plan,
    name: plan?.name ?? '',
    description: plan?.description ?? '',
    price: plan ? centsToInput(plan.priceMonthlyCents) : '',
    sortOrder: String(plan?.sortOrder ?? nextOrder),
    limits,
    unlimited,
    copilot: plan?.limits.copilot ?? false,
    advancedAnalytics: plan?.limits.advancedAnalytics ?? false,
    isActive: plan?.isActive ?? true,
    isPublic: plan?.isPublic ?? true,
  };
}

type Errors = Partial<Record<'key' | 'name' | 'price' | 'sortOrder' | LimitKey, string>>;

function validate(f: FormState, isNew: boolean, plans: AdminPlan[]): Errors {
  const e: Errors = {};
  if (isNew) {
    if (!KEY_RE.test(f.key)) e.key = 'Usa entre 2 y 31 caracteres: minúsculas sin acentos, números, guiones o guiones bajos, empezando por una letra.';
    else if (plans.some((p) => p.key === f.key)) e.key = 'Ya existe un plan con esta clave.';
  }
  const name = f.name.trim();
  if (name.length < 2 || name.length > 60) e.name = 'El nombre debe tener entre 2 y 60 caracteres.';
  const cents = parseEuros(f.price);
  if (cents === null) e.price = 'Escribe un importe válido, por ejemplo 49 o 49,90.';
  else if (cents > 10_000_000) e.price = 'El precio no puede superar 100.000.';
  const order = Number(f.sortOrder);
  if (!/^\d+$/.test(f.sortOrder.trim()) || order > 100) e.sortOrder = 'Un número entero entre 0 y 100.';
  for (const l of LIMIT_FIELDS) {
    if (f.unlimited[l.key]) continue;
    const raw = f.limits[l.key].trim();
    if (!/^\d+$/.test(raw)) e[l.key] = 'Escribe un número entero o marca «Ilimitado».';
    else if (Number(raw) < l.min) e[l.key] = `Como mínimo ${l.min}.`;
  }
  return e;
}

function toBody(f: FormState) {
  const limits = {
    copilot: f.copilot,
    advancedAnalytics: f.advancedAnalytics,
  } as PlanLimits;
  for (const l of LIMIT_FIELDS) limits[l.key] = f.unlimited[l.key] ? null : Number(f.limits[l.key].trim());
  return {
    name: f.name.trim(),
    description: f.description.trim(),
    priceMonthlyCents: parseEuros(f.price) ?? 0,
    sortOrder: Number(f.sortOrder.trim()),
    limits,
    isActive: f.isActive,
    isPublic: f.isPublic,
  };
}

// ───────────── Editor ─────────────

function PlanEditor({ plan, plans, onClose }: { plan: AdminPlan | null; plans: AdminPlan[]; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const isNew = !plan;
  const nextOrder = Math.min(100, Math.max(0, ...plans.map((p) => p.sortOrder)) + 1);
  const [form, setForm] = useState<FormState>(() => toForm(plan, nextOrder));
  const [submitted, setSubmitted] = useState(false);
  const errors = validate(form, isNew, plans);
  const shown: Errors = submitted ? errors : {};
  const hasErrors = Object.keys(errors).length > 0;
  const currency = plan?.currency ?? 'EUR';

  const save = useMutation({
    mutationFn: () =>
      isNew ? api.post<{ plan: AdminPlan }>('/admin/plans', { key: form.key, currency, ...toBody(form) }) : api.patch<{ plan: AdminPlan }>(`/admin/plans/${plan.id}`, toBody(form)),
    onSuccess: () => {
      toast(isNew ? 'Plan creado' : 'Plan guardado. Los nuevos límites ya se están aplicando.');
      void qc.invalidateQueries({ queryKey: ADMIN_KEYS.plans });
      void qc.invalidateQueries({ queryKey: ADMIN_KEYS.businesses });
      void qc.invalidateQueries({ queryKey: ADMIN_KEYS.businessAll });
      void qc.invalidateQueries({ queryKey: ADMIN_KEYS.overview });
      void qc.invalidateQueries({ queryKey: ADMIN_KEYS.audit });
      // Los límites (y el nombre del plan) también se ven en la app del negocio activo.
      void qc.invalidateQueries({ queryKey: ['settings'] });
      void qc.invalidateQueries({ queryKey: ['me'] });
      onClose();
    },
    onError: (e) => toast(errorText(e), 'error'),
  });

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setForm((f) => ({ ...f, [k]: v }));
  const setName = (name: string) => setForm((f) => ({ ...f, name, key: isNew && !f.keyTouched ? slugify(name) : f.key }));
  const setLimit = (k: LimitKey, v: string) => setForm((f) => ({ ...f, limits: { ...f.limits, [k]: v } }));
  const setUnlimited = (k: LimitKey, v: boolean, fallback: number) =>
    setForm((f) => ({ ...f, unlimited: { ...f.unlimited, [k]: v }, limits: { ...f.limits, [k]: !v && !f.limits[k] ? String(fallback) : f.limits[k] } }));

  const submit = () => {
    setSubmitted(true);
    if (!hasErrors) save.mutate();
  };

  return (
    <Modal
      open
      wide
      onClose={onClose}
      title={isNew ? 'Nuevo plan' : `Editar plan «${plan.name}»`}
      footer={
        <>
          {submitted && hasErrors && <span className="small" style={{ color: 'var(--danger)', marginRight: 'auto' }}>Revisa los campos marcados.</span>}
          <Button onClick={onClose}>Cancelar</Button>
          <Button variant="primary" icon={isNew ? Plus : Save} loading={save.isPending} onClick={submit}>
            {isNew ? 'Crear plan' : 'Guardar cambios'}
          </Button>
        </>
      }
    >
      <div className="adm-form-section">
        <h3 className="section-title">Datos del plan</h3>
        <div className="col gap-12">
          <div className="grid-2">
            <Field label="Nombre" htmlFor="plan-name" error={shown.name} hint="Es el nombre que ven los entrenadores.">
              <Input id="plan-name" value={form.name} maxLength={60} onChange={(e) => setName(e.target.value)} placeholder="Ej.: Pro" autoFocus={isNew} />
            </Field>
            <Field
              label="Clave interna"
              htmlFor="plan-key"
              error={shown.key}
              hint={isNew ? 'Identificador técnico del plan, en minúsculas y sin espacios. No se puede cambiar después.' : 'Identificador técnico del plan. No se puede cambiar.'}
            >
              <Input
                id="plan-key"
                value={form.key}
                maxLength={31}
                disabled={!isNew}
                onChange={(e) => setForm((f) => ({ ...f, key: e.target.value.toLowerCase().replace(/\s+/g, '-'), keyTouched: true }))}
                placeholder="ej.: pro"
                spellCheck={false}
                autoCapitalize="off"
              />
            </Field>
          </div>
          <Field label="Descripción" htmlFor="plan-description" hint={`${form.description.length}/300 · Una frase que explique para quién es este plan.`}>
            <Textarea id="plan-description" rows={2} maxLength={300} value={form.description} onChange={(e) => set('description', e.target.value)} />
          </Field>
          <div className="grid-2">
            <Field label="Precio mensual" htmlFor="plan-price" error={shown.price} hint={`En ${currency}. Pon 0 para un plan gratuito. Admite decimales con coma (49,90).`}>
              <div className="input-group">
                <Input id="plan-price" className="adm-price-input" inputMode="decimal" value={form.price} onChange={(e) => set('price', e.target.value)} placeholder="0" />
                <span className="input-suffix">{currency === 'EUR' ? '€' : currency}</span>
              </div>
            </Field>
            <Field label="Orden" htmlFor="plan-order" error={shown.sortOrder} hint="Posición en las listas de planes (de menor a mayor).">
              <Input id="plan-order" type="number" min={0} max={100} step={1} value={form.sortOrder} onChange={(e) => set('sortOrder', e.target.value)} />
            </Field>
          </div>
        </div>
      </div>

      <div className="adm-form-section">
        <h3 className="section-title">Límites</h3>
        <Callout tone="accent" icon={Info}>
          Los límites se aplican <strong>al instante</strong> a todos los negocios con este plan y nunca están fijados en el código: KAI los consulta aquí cada vez que los necesita. Reducir un límite no borra datos; solo frena lo nuevo a partir de ahora.
        </Callout>
        <div className="mt-8">
          {LIMIT_FIELDS.map((l) => {
            const id = `plan-limit-${l.key}`;
            return (
              <div key={l.key} className="adm-limit">
                <div>
                  <label htmlFor={id} className="label" style={{ color: 'var(--text)' }}>
                    {l.label}
                  </label>
                  <p className="hint mt-4">{l.hint}</p>
                </div>
                <div className="adm-limit-controls">
                  <Input
                    id={id}
                    type="number"
                    min={l.min}
                    step={1}
                    inputMode="numeric"
                    value={form.unlimited[l.key] ? '' : form.limits[l.key]}
                    placeholder={form.unlimited[l.key] ? 'Ilimitado' : undefined}
                    disabled={form.unlimited[l.key]}
                    onChange={(e) => setLimit(l.key, e.target.value)}
                    aria-invalid={!!shown[l.key]}
                    aria-describedby={shown[l.key] ? `${id}-error` : undefined}
                  />
                  <Switch checked={form.unlimited[l.key]} onChange={(v) => setUnlimited(l.key, v, l.fallback)} label={<span className="small">Ilimitado</span>} />
                  {shown[l.key] && (
                    <span id={`${id}-error`} className="error-text">
                      {shown[l.key]}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="adm-form-section">
        <h3 className="section-title">Funciones incluidas</h3>
        {FEATURE_FIELDS.map((f) => (
          <div key={f.key} className="adm-switch-row">
            <Switch checked={form[f.key]} onChange={(v) => set(f.key, v)} label={<strong>{f.label}</strong>} />
            <span className="hint">{f.hint}</span>
          </div>
        ))}
      </div>

      <div className="adm-form-section">
        <h3 className="section-title">Visibilidad</h3>
        <div className="adm-switch-row">
          <Switch checked={form.isActive} onChange={(v) => set('isActive', v)} label={<strong>Plan activo</strong>} />
          <span className="hint">Si lo desactivas, deja de ofrecerse a nuevos clientes. Los negocios que ya lo tienen lo conservan con sus límites.</span>
        </div>
        <div className="adm-switch-row">
          <Switch checked={form.isPublic} onChange={(v) => set('isPublic', v)} label={<strong>Plan público</strong>} />
          <span className="hint">Aparece en la comparativa de planes que ven los entrenadores. Desmárcalo para planes a medida que solo asignas tú desde la ficha del negocio.</span>
        </div>
        {!isNew && plan.key === DEFAULT_PLAN_KEY && (
          <div className="mt-8">
            <Callout tone="warning">Este es el plan que se asigna automáticamente a los negocios nuevos al registrarse, aunque lo desactives o lo ocultes.</Callout>
          </div>
        )}
      </div>
    </Modal>
  );
}

// ───────────── Tarjetas ─────────────

function LimitValue({ value }: { value: number | null }) {
  if (value === null) return <strong>Ilimitado</strong>;
  return <span className="tnum">{num(value)}</span>;
}

function FeatureValue({ on }: { on: boolean }) {
  return on ? (
    <span className="row" style={{ gap: 4, color: 'var(--success)' }}>
      <Check size={15} aria-hidden />
      Incluido
    </span>
  ) : (
    <span className="row subtle" style={{ gap: 4 }}>
      <Minus size={15} aria-hidden />
      No incluido
    </span>
  );
}

function PlanCard({ plan, onEdit }: { plan: AdminPlan; onEdit: () => void }) {
  return (
    <section className={`card adm-plan-card ${plan.isActive ? '' : 'is-inactive'}`} aria-label={`Plan ${plan.name}`}>
      <div className="card-header" style={{ alignItems: 'flex-start' }}>
        <div className="col" style={{ gap: 6, minWidth: 0 }}>
          <h2>{plan.name}</h2>
          <div className="row wrap" style={{ gap: 6 }}>
            <span className="code-inline">{plan.key}</span>
            {plan.isActive ? <span className="badge badge-dot badge-success">Activo</span> : <span className="badge badge-dot">Inactivo</span>}
            {plan.isPublic ? <span className="badge badge-info">Público</span> : <span className="badge">Oculto</span>}
            {plan.key === DEFAULT_PLAN_KEY && <span className="badge badge-accent" title="Se asigna automáticamente a los negocios nuevos">Por defecto</span>}
          </div>
        </div>
        <Button size="sm" icon={Pencil} onClick={onEdit} aria-label={`Editar el plan ${plan.name}`}>
          Editar
        </Button>
      </div>
      <div className="adm-plan-body">
        <div>
          <span className="adm-plan-price tnum">{plan.priceMonthlyCents > 0 ? formatMoney(plan.priceMonthlyCents, plan.currency || 'EUR') : 'Gratis'}</span>
          {plan.priceMonthlyCents > 0 && <span className="subtle small"> {BILLING_PERIOD_LABELS.monthly}</span>}
        </div>
        {plan.description ? <p className="muted small mt-4">{plan.description}</p> : <p className="subtle small mt-4">Sin descripción.</p>}
        <div className="divider" />
        <dl className="kv">
          {LIMIT_FIELDS.map((l) => (
            <KvRow key={l.key} label={l.short} value={<LimitValue value={plan.limits[l.key]} />} />
          ))}
          {FEATURE_FIELDS.map((f) => (
            <KvRow key={f.key} label={f.label} value={<FeatureValue on={plan.limits[f.key]} />} />
          ))}
          <KvRow label="Orden" value={<span className="tnum">{plan.sortOrder}</span>} />
        </dl>
      </div>
    </section>
  );
}

function KvRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </>
  );
}

// ───────────── Página ─────────────

export default function AdminPlans() {
  const q = useQuery({ queryKey: ADMIN_KEYS.plans, queryFn: () => api.get<{ plans: AdminPlan[] }>('/admin/plans') });
  const [editing, setEditing] = useState<AdminPlan | 'new' | null>(null);

  const header = (
    <PageHeader
      title="Planes"
      description="Define qué incluye cada plan y cuánto cuesta. Asigna un plan a un negocio desde su ficha en Negocios."
      actions={
        <Button variant="primary" icon={Plus} onClick={() => setEditing('new')} disabled={q.isPending || q.isError}>
          Nuevo plan
        </Button>
      }
    />
  );

  if (q.isPending) return <PageLoading />;
  if (q.isError) {
    return (
      <div className="page">
        {header}
        <div className="card">
          <QueryError error={q.error} onRetry={() => void q.refetch()} retrying={q.isFetching} />
        </div>
      </div>
    );
  }

  const plans = q.data.plans;

  return (
    <div className="page">
      {header}
      <div className="adm-stack">
        <Callout tone="info">
          Los límites de cada plan se guardan aquí y <strong>se aplican al instante</strong>: no hace falta tocar el código ni reiniciar nada. Cualquier cambio afecta de inmediato a todos los negocios que tienen ese plan. «Ilimitado» significa que no hay tope.
        </Callout>
        {plans.length === 0 ? (
          <Card>
            <EmptyState
              icon={CreditCard}
              title="Todavía no hay planes"
              description="Crea al menos un plan para poder asignarlo a los negocios."
              action={
                <Button variant="primary" icon={Plus} onClick={() => setEditing('new')}>
                  Crear el primer plan
                </Button>
              }
            />
          </Card>
        ) : (
          <div className="grid-3" style={{ alignItems: 'stretch' }}>
            {plans.map((p) => (
              <PlanCard key={p.id} plan={p} onEdit={() => setEditing(p)} />
            ))}
          </div>
        )}
      </div>
      {editing && <PlanEditor key={editing === 'new' ? 'new' : editing.id} plan={editing === 'new' ? null : editing} plans={plans} onClose={() => setEditing(null)} />}
    </div>
  );
}
