/* Pestaña «Servicio y precio»: servicios que ofrece el entrenador y cuándo da KAI el precio. */
import { useId, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { BadgeEuro, MessageCircleQuestion, Package, Pencil, Plus, Power, Star, Trash2 } from 'lucide-react';
import { BILLING_PERIOD_LABELS } from '@shared';
import { api, errorText } from '../../lib/api';
import { money } from '../../lib/format';
import { Button, Callout, Card, ConfirmDialog, EmptyState, Field, Input, Modal, Select, Switch, TagInput, Textarea, useToast } from '../../components/ui';
import type { AiSettings, Service } from '../../lib/types';
import { CharCount, OptionCards, SaveBar, centsToText, parseEurosToCents, useDraft, useReportDirty, type TabProps } from './setter-shared';

type BillingPeriod = Service['billingPeriod'];
type ServiceBody = Omit<Service, 'id'>;

interface ServiceForm {
  name: string;
  description: string;
  price: string;
  billingPeriod: BillingPeriod;
  durationWeeks: string;
  includes: string[];
  isPrimary: boolean;
  isActive: boolean;
}

const PERIOD_OPTIONS: { value: BillingPeriod; label: string }[] = [
  { value: 'monthly', label: 'Mensual' },
  { value: 'quarterly', label: 'Trimestral' },
  { value: 'semiannual', label: 'Semestral' },
  { value: 'annual', label: 'Anual' },
  { value: 'one_time', label: 'Pago único' },
];

const periodText = (p: BillingPeriod) => (p === 'one_time' ? '(pago único)' : BILLING_PERIOD_LABELS[p] ?? '');
const currencySymbol = (currency: string) => (currency === 'EUR' ? '€' : currency);

const emptyForm = (isFirst: boolean): ServiceForm => ({ name: '', description: '', price: '', billingPeriod: 'monthly', durationWeeks: '', includes: [], isPrimary: isFirst, isActive: true });

const toForm = (s: Service): ServiceForm => ({
  name: s.name,
  description: s.description ?? '',
  price: centsToText(s.priceCents),
  billingPeriod: s.billingPeriod,
  durationWeeks: s.durationWeeks ? String(s.durationWeeks) : '',
  includes: s.includes ?? [],
  isPrimary: s.isPrimary,
  isActive: s.isActive,
});

/** El servidor reinicia los campos que no se envían, así que siempre mandamos el servicio completo. */
const toBody = (s: Service): ServiceBody => ({
  name: s.name,
  description: s.description ?? '',
  priceCents: s.priceCents,
  currency: s.currency,
  billingPeriod: s.billingPeriod,
  durationWeeks: s.durationWeeks ?? null,
  includes: s.includes ?? [],
  isPrimary: s.isPrimary,
  isActive: s.isActive,
});

function formToBody(f: ServiceForm, currency: string): { body: ServiceBody | null; errors: Partial<Record<keyof ServiceForm, string>> } {
  const errors: Partial<Record<keyof ServiceForm, string>> = {};
  const name = f.name.trim();
  if (name.length < 2) errors.name = 'Escribe un nombre de al menos 2 caracteres.';
  else if (name.length > 120) errors.name = 'Máximo 120 caracteres.';
  if (f.description.trim().length > 1000) errors.description = 'Máximo 1000 caracteres.';
  const cents = parseEurosToCents(f.price);
  if (!f.price.trim()) errors.price = 'Indica el precio. Si es gratuito, escribe 0.';
  else if (cents === null) errors.price = 'Escribe solo el importe, por ejemplo 149 o 149,90.';
  else if (cents > 100_000_000) errors.price = 'El importe es demasiado alto.';
  let weeks: number | null = null;
  if (f.durationWeeks.trim()) {
    weeks = Number(f.durationWeeks.trim());
    if (!Number.isInteger(weeks) || weeks < 1 || weeks > 520) errors.durationWeeks = 'Escribe un número entero de semanas entre 1 y 520, o déjalo vacío.';
  }
  if (f.includes.length > 15) errors.includes = 'Máximo 15 elementos.';
  else if (f.includes.some((i) => i.length > 120)) errors.includes = 'Cada elemento puede tener como máximo 120 caracteres.';
  if (Object.keys(errors).length) return { body: null, errors };
  return {
    body: {
      name,
      description: f.description.trim(),
      priceCents: cents ?? 0,
      currency,
      billingPeriod: f.billingPeriod,
      durationWeeks: weeks,
      includes: f.includes,
      isPrimary: f.isPrimary,
      isActive: f.isActive,
    },
    errors,
  };
}

// ───────────── Formulario de servicio ─────────────
function ServiceModal({ service, isFirst, currency, onClose }: { service: Service | null; isFirst: boolean; currency: string; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const ids = { name: useId(), description: useId(), price: useId(), period: useId(), weeks: useId(), includes: useId() };
  const initial = service ? toForm(service) : emptyForm(isFirst);
  const [form, setForm] = useState<ServiceForm>(initial);
  const [submitted, setSubmitted] = useState(false);
  const { body, errors } = formToBody(form, service?.currency ?? currency);
  const changed = JSON.stringify(form) !== JSON.stringify(initial);
  const set = <K extends keyof ServiceForm>(key: K, value: ServiceForm[K]) => setForm((f) => ({ ...f, [key]: value }));
  const show = (k: keyof ServiceForm) => (submitted ? errors[k] : undefined);
  const symbol = currencySymbol(service?.currency ?? currency);

  const saveMutation = useMutation({
    mutationFn: (payload: ServiceBody) => (service ? api.patch<{ service: Service }>(`/settings/services/${service.id}`, payload) : api.post<{ service: Service }>('/settings/services', payload)),
    onSuccess: () => {
      toast(service ? 'Servicio actualizado' : 'Servicio creado');
      void qc.invalidateQueries({ queryKey: ['settings'] });
      void qc.invalidateQueries({ queryKey: ['dashboard'] });
      onClose();
    },
    onError: (e) => toast(errorText(e), 'error'),
  });
  const submit = () => {
    setSubmitted(true);
    if (body) saveMutation.mutate(body);
  };

  return (
    <Modal
      open
      wide
      onClose={onClose}
      title={service ? `Editar «${service.name}»` : 'Nuevo servicio'}
      footer={
        <>
          {changed && <span className="small row" style={{ marginRight: 'auto', gap: 8 }}><span className="setter-dot" aria-hidden />Cambios sin guardar</span>}
          <Button onClick={onClose}>Cancelar</Button>
          <Button variant="primary" loading={saveMutation.isPending} disabled={submitted && !body} onClick={submit}>
            {service ? 'Guardar cambios' : 'Crear servicio'}
          </Button>
        </>
      }
    >
      <div className="col gap-12">
        <Field label="Nombre del servicio" htmlFor={ids.name} error={show('name')}>
          <Input id={ids.name} value={form.name} maxLength={120} placeholder="Ej.: Asesoría online de 12 semanas" onChange={(e) => set('name', e.target.value)} />
        </Field>
        <Field label="Descripción (opcional)" htmlFor={ids.description} error={show('description')} hint="Explica en una o dos frases en qué consiste. KAI lo usará para describirlo.">
          <Textarea id={ids.description} rows={3} value={form.description} maxLength={1000} onChange={(e) => set('description', e.target.value)} />
          <CharCount value={form.description} max={1000} />
        </Field>
        <div className="grid-3">
          <Field label={`Precio (${symbol})`} htmlFor={ids.price} error={show('price')} hint="Por ejemplo: 149 o 149,90">
            <Input id={ids.price} inputMode="decimal" value={form.price} placeholder="149" onChange={(e) => set('price', e.target.value)} />
          </Field>
          <Field label="Periodicidad" htmlFor={ids.period}>
            <Select id={ids.period} value={form.billingPeriod} options={PERIOD_OPTIONS} onChange={(e) => set('billingPeriod', e.target.value as BillingPeriod)} />
          </Field>
          <Field label="Duración en semanas (opcional)" htmlFor={ids.weeks} error={show('durationWeeks')} hint="Déjalo vacío si no tiene una duración fija.">
            <Input id={ids.weeks} type="number" min={1} max={520} inputMode="numeric" value={form.durationWeeks} placeholder="12" onChange={(e) => set('durationWeeks', e.target.value)} />
          </Field>
        </div>
        <div className="field" role="group" aria-labelledby={ids.includes}>
          <span className="label" id={ids.includes}>
            Qué incluye (opcional)
          </span>
          <TagInput value={form.includes} onChange={(v) => set('includes', v)} placeholder="Ej.: Plan de entrenamiento personalizado" />
          {show('includes') ? <span className="error-text">{show('includes')}</span> : <span className="hint">Escribe cada elemento y pulsa Enter. Máximo 15.</span>}
        </div>
        <div>
          <div className="setter-toggle-row">
            <div>
              <strong>Servicio principal</strong>
              <p className="muted small">Es el que KAI menciona primero cuando le preguntan por precios. Solo puede haber uno.</p>
            </div>
            <Switch
              checked={form.isPrimary}
              disabled={Boolean(service?.isPrimary)}
              onChange={(v) => set('isPrimary', v)}
              label={<span className="sr-only">Servicio principal</span>}
            />
          </div>
          {service?.isPrimary && <p className="subtle xs" style={{ marginTop: -6, marginBottom: 8 }}>Para cambiar el principal, marca otro servicio como principal.</p>}
          <div className="setter-toggle-row">
            <div>
              <strong>Activo</strong>
              <p className="muted small">Si lo desactivas, KAI deja de ofrecerlo, pero lo conservas para más adelante.</p>
            </div>
            <Switch checked={form.isActive} onChange={(v) => set('isActive', v)} label={<span className="sr-only">Servicio activo</span>} />
          </div>
        </div>
        {submitted && !body && <Callout tone="danger">Revisa los campos marcados.</Callout>}
      </div>
    </Modal>
  );
}

// ───────────── Pestaña ─────────────
export default function ServicesTab({ settings, canEdit, onDirtyChange }: TabProps) {
  const qc = useQueryClient();
  const toast = useToast();
  const currency = settings.business.currency || 'EUR';
  const services = settings.services;
  const [editing, setEditing] = useState<Service | 'new' | null>(null);
  const [deleting, setDeleting] = useState<Service | null>(null);
  const { draft, setDraft, dirty, reset, markSaved } = useDraft<{ pricePolicy: AiSettings['pricePolicy'] }>({ pricePolicy: settings.aiSettings.pricePolicy });
  useReportDirty(onDirtyChange, dirty);

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['settings'] });
    void qc.invalidateQueries({ queryKey: ['dashboard'] });
  };
  const quick = useMutation({
    mutationFn: ({ service, patch }: { service: Service; patch: Partial<ServiceBody> }) => api.patch(`/settings/services/${service.id}`, { ...toBody(service), ...patch }),
    onSuccess: (_d, { patch }) => {
      toast(patch.isPrimary ? 'Servicio principal actualizado' : patch.isActive === false ? 'Servicio desactivado: KAI dejará de ofrecerlo' : 'Servicio activado');
      refresh();
    },
    onError: (e) => toast(errorText(e), 'error'),
  });
  const remove = useMutation({
    mutationFn: (s: Service) => api.del(`/settings/services/${s.id}`),
    onSuccess: () => {
      toast('Servicio eliminado');
      setDeleting(null);
      refresh();
    },
    onError: (e) => toast(errorText(e), 'error'),
  });
  const savePolicy = useMutation({
    mutationFn: () => api.put('/settings/ai', { pricePolicy: draft.pricePolicy }),
    onSuccess: () => {
      markSaved();
      toast('Política de precio guardada');
      void qc.invalidateQueries({ queryKey: ['settings'] });
    },
    onError: (e) => toast(errorText(e), 'error'),
  });

  const active = services.filter((s) => s.isActive);
  const hasPrimaryActive = active.some((s) => s.isPrimary);

  return (
    <>
      <p className="setter-lead">
        Estos son los servicios que KAI conoce. Cuando un lead pregunta qué ofreces o cuánto cuesta, KAI usa exclusivamente esta información: nunca inventa precios, descuentos ni condiciones.
      </p>

      <Card
        title="Tus servicios"
        icon={Package}
        actions={
          canEdit && (
            <Button size="sm" icon={Plus} onClick={() => setEditing('new')}>
              Añadir servicio
            </Button>
          )
        }
      >
        {services.length === 0 ? (
          <EmptyState
            icon={Package}
            title="Aún no tienes servicios"
            description="Añade al menos tu servicio principal con su precio. Mientras no haya ninguno, si un lead pregunta el precio, KAI le dirá que lo concretas tú en la llamada."
            action={
              canEdit ? (
                <Button variant="primary" icon={Plus} onClick={() => setEditing('new')}>
                  Añadir servicio
                </Button>
              ) : undefined
            }
          />
        ) : (
          <div className="col gap-12">
            {active.length === 0 && <Callout tone="warning">No tienes ningún servicio activo. Si un lead pregunta el precio, KAI le dirá que lo concretas tú en la llamada (sin inventar cifras).</Callout>}
            {active.length > 0 && !hasPrimaryActive && <Callout tone="info">Ninguno de tus servicios activos está marcado como principal. Marca uno para que KAI sepa cuál ofrecer primero.</Callout>}
            <div className="setter-list">
              {services.map((s) => (
                <div key={s.id} className={`setter-item ${s.isActive ? '' : 'is-off'}`}>
                  <div className="setter-item-head" style={{ alignItems: 'flex-start' }}>
                    <span className="setter-icon" aria-hidden>
                      <BadgeEuro />
                    </span>
                    <div className="setter-item-main">
                      <div className="row wrap" style={{ gap: 6 }}>
                        <strong className="setter-item-title">{s.name}</strong>
                        {s.isPrimary && (
                          <span className="badge badge-accent">
                            <Star aria-hidden /> Principal
                          </span>
                        )}
                        {!s.isActive && <span className="badge">Inactivo: KAI no lo ofrece</span>}
                      </div>
                      <div className="small mt-4">
                        <strong className="tnum">{money(s.priceCents, s.currency)}</strong> <span className="muted">{periodText(s.billingPeriod)}</span>
                        {s.durationWeeks ? <span className="muted"> · {s.durationWeeks} {s.durationWeeks === 1 ? 'semana' : 'semanas'}</span> : null}
                      </div>
                      {s.description && <p className="muted small mt-4">{s.description}</p>}
                      {s.includes.length > 0 && (
                        <div className="chips mt-8">
                          {s.includes.map((item) => (
                            <span key={item} className="badge">
                              {item}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                    {canEdit && (
                      <div className="setter-actions">
                        {!s.isPrimary && (
                          <Button size="sm" variant="ghost" icon={Star} disabled={quick.isPending} onClick={() => quick.mutate({ service: s, patch: { isPrimary: true, isActive: true } })}>
                            Hacer principal
                          </Button>
                        )}
                        <Button size="sm" variant="ghost" icon={Power} disabled={quick.isPending} onClick={() => quick.mutate({ service: s, patch: { isActive: !s.isActive } })}>
                          {s.isActive ? 'Desactivar' : 'Activar'}
                        </Button>
                        <Button size="sm" icon={Pencil} onClick={() => setEditing(s)}>
                          Editar
                        </Button>
                        <Button size="sm" variant="ghost" iconOnly icon={Trash2} onClick={() => setDeleting(s)}>
                          {`Eliminar «${s.name}»`}
                        </Button>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
            <p className="subtle xs">Los servicios se guardan al momento al crearlos, editarlos o eliminarlos.</p>
          </div>
        )}
      </Card>

      <Card title="¿Cuándo da KAI el precio?" icon={MessageCircleQuestion}>
        <OptionCards
          label="Política de precio"
          value={draft.pricePolicy}
          onChange={(pricePolicy) => setDraft({ pricePolicy })}
          options={[
            {
              value: 'contextualize_first',
              title: 'Primero entiende, luego da el precio',
              badge: 'Recomendado',
              description: (
                <>
                  Si un lead pregunta el precio nada más empezar, KAI primero le hace una pregunta para entender su situación y recomendarle lo adecuado. Por ejemplo: «Claro. Antes de decirte qué opción tendría sentido para ti, quiero entender un poco tu situación para no recomendarte algo que no encaje». Si vuelve a preguntar, o si KAI ya conoce lo esencial de su caso, se lo da siempre: nunca lo oculta.
                </>
              ),
            },
            {
              value: 'share_directly',
              title: 'Da el precio directamente',
              description: 'En cuanto un lead pregunta, KAI le dice el precio con claridad (importe, periodicidad y lo que incluye) y después sigue la conversación con una pregunta.',
            },
          ]}
        />
        <p className="subtle xs mt-12">En ambos casos KAI usa solo los precios de tus servicios activos y nunca ofrece descuentos por su cuenta.</p>
      </Card>

      <SaveBar dirty={dirty} saving={savePolicy.isPending} canEdit={canEdit} onDiscard={reset} onSave={() => savePolicy.mutate()} saveLabel="Guardar política de precio" />

      {editing && <ServiceModal key={editing === 'new' ? 'new' : editing.id} service={editing === 'new' ? null : editing} isFirst={services.length === 0} currency={currency} onClose={() => setEditing(null)} />}

      <ConfirmDialog
        open={Boolean(deleting)}
        title="¿Eliminar este servicio?"
        message={
          deleting ? (
            <>
              Vas a eliminar «{deleting.name}». KAI dejará de ofrecerlo y no se puede deshacer.
              {deleting.isPrimary && services.length > 1 ? ' Era tu servicio principal: después marca otro como principal.' : ''} Si solo quieres dejar de ofrecerlo por un tiempo, mejor desactívalo.
            </>
          ) : (
            ''
          )
        }
        confirmLabel="Eliminar servicio"
        danger
        loading={remove.isPending}
        onConfirm={() => deleting && remove.mutate(deleting)}
        onClose={() => setDeleting(null)}
      />
    </>
  );
}
