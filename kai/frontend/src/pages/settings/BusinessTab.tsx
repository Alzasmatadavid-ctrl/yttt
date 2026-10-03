/* Pestaña «Negocio»: datos del negocio (nombre, zona horaria, moneda, inversión en anuncios) y perfil profesional del entrenador. */
import { useEffect, useId, useState } from 'react';
import { Link } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Building2, CircleAlert, Dumbbell, Laptop, RefreshCw, ShieldCheck, Shuffle, UserRound, type LucideIcon } from 'lucide-react';
import { api, errorText } from '../../lib/api';
import { money } from '../../lib/format';
import { Button, Callout, Card, EmptyState, Field, Input, PageLoading, Select, Textarea, useToast } from '../../components/ui';
import type { SettingsResponse, Trainer } from '../../lib/types';
import { FieldFoot, SaveRow, centsToInput, parseEurosToCents, useDraft, type SettingsTabProps } from './settings-shared';

// ───────────── Opciones ─────────────

const TIMEZONES: { value: string; label: string }[] = [
  { value: 'Europe/Madrid', label: 'España peninsular y Baleares (Madrid)' },
  { value: 'Atlantic/Canary', label: 'Islas Canarias' },
  { value: 'America/Mexico_City', label: 'México, centro (Ciudad de México)' },
  { value: 'America/Cancun', label: 'México, Quintana Roo (Cancún)' },
  { value: 'America/Tijuana', label: 'México, Baja California (Tijuana)' },
  { value: 'America/Guatemala', label: 'Guatemala' },
  { value: 'America/El_Salvador', label: 'El Salvador' },
  { value: 'America/Tegucigalpa', label: 'Honduras (Tegucigalpa)' },
  { value: 'America/Managua', label: 'Nicaragua (Managua)' },
  { value: 'America/Costa_Rica', label: 'Costa Rica' },
  { value: 'America/Panama', label: 'Panamá' },
  { value: 'America/Havana', label: 'Cuba (La Habana)' },
  { value: 'America/Santo_Domingo', label: 'República Dominicana (Santo Domingo)' },
  { value: 'America/Puerto_Rico', label: 'Puerto Rico' },
  { value: 'America/Bogota', label: 'Colombia (Bogotá)' },
  { value: 'America/Caracas', label: 'Venezuela (Caracas)' },
  { value: 'America/Guayaquil', label: 'Ecuador (Guayaquil)' },
  { value: 'America/Lima', label: 'Perú (Lima)' },
  { value: 'America/La_Paz', label: 'Bolivia (La Paz)' },
  { value: 'America/Santiago', label: 'Chile (Santiago)' },
  { value: 'America/Asuncion', label: 'Paraguay (Asunción)' },
  { value: 'America/Argentina/Buenos_Aires', label: 'Argentina (Buenos Aires)' },
  { value: 'America/Montevideo', label: 'Uruguay (Montevideo)' },
  { value: 'Europe/Lisbon', label: 'Portugal (Lisboa)' },
  { value: 'Europe/London', label: 'Reino Unido (Londres)' },
  { value: 'America/New_York', label: 'EE. UU., costa este (Nueva York)' },
  { value: 'America/Los_Angeles', label: 'EE. UU., costa oeste (Los Ángeles)' },
];

const CURRENCIES: { value: string; label: string }[] = [
  { value: 'EUR', label: 'Euro (EUR, €)' },
  { value: 'USD', label: 'Dólar estadounidense (USD, $)' },
  { value: 'MXN', label: 'Peso mexicano (MXN)' },
  { value: 'COP', label: 'Peso colombiano (COP)' },
  { value: 'ARS', label: 'Peso argentino (ARS)' },
  { value: 'CLP', label: 'Peso chileno (CLP)' },
  { value: 'PEN', label: 'Sol peruano (PEN)' },
];

const MODALITIES: { value: Trainer['modality']; label: string; description: string; icon: LucideIcon }[] = [
  { value: 'online', label: 'Online', description: 'Entrenas a distancia: con app, videollamadas o mensajes.', icon: Laptop },
  { value: 'presencial', label: 'Presencial', description: 'Entrenas en persona: en tu centro, en un gimnasio o a domicilio.', icon: Dumbbell },
  { value: 'hibrido', label: 'Híbrido', description: 'Combinas sesiones en persona con seguimiento online.', icon: Shuffle },
];

const MAX_AD_SPEND_CENTS = 100_000_000;

/** Hora actual en una zona horaria (“14:05”), o null si la zona no es válida. */
function nowIn(timeZone: string): string | null {
  try {
    return new Intl.DateTimeFormat('es-ES', { timeZone, hour: '2-digit', minute: '2-digit' }).format(new Date());
  } catch {
    return null;
  }
}

/** Reloj que se refresca cada 30 s para mostrar la hora de la zona elegida. */
function useClockTick() {
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setTick((t) => t + 1), 30_000);
    return () => window.clearInterval(id);
  }, []);
}

// ───────────── Datos del negocio ─────────────

interface BusinessDraft {
  name: string;
  timezone: string;
  currency: string;
  adSpend: string;
}

type BusinessErrors = Partial<Record<keyof BusinessDraft, string>>;

function validateBusiness(d: BusinessDraft): BusinessErrors {
  const e: BusinessErrors = {};
  const name = d.name.trim();
  if (name.length < 2) e.name = 'Escribe un nombre de al menos 2 caracteres.';
  else if (name.length > 120) e.name = 'Máximo 120 caracteres.';
  if (!d.timezone || nowIn(d.timezone) === null) e.timezone = 'Elige una zona horaria válida.';
  if (!/^[A-Z]{3}$/.test(d.currency)) e.currency = 'Elige una moneda.';
  const cents = parseEurosToCents(d.adSpend);
  if (cents === null) e.adSpend = 'Escribe un importe válido, por ejemplo 300 o 249,90.';
  else if (cents > MAX_AD_SPEND_CENTS) e.adSpend = 'El importe máximo es 1.000.000 €.';
  return e;
}

function BusinessCard({ settings, canEdit, onDirtyChange }: { settings: SettingsResponse; canEdit: boolean; onDirtyChange: (dirty: boolean) => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const ids = { name: useId(), tz: useId(), currency: useId(), adSpend: useId() };
  useClockTick();
  const b = settings.business;
  const { draft, base, setDraft, dirty, reset, markSaved } = useDraft<BusinessDraft>({
    name: b.name ?? '',
    timezone: b.timezone || 'Europe/Madrid',
    currency: b.currency || 'EUR',
    adSpend: centsToInput(b.monthlyAdSpendCents),
  });
  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);
  const errors = validateBusiness(draft);
  const firstError = Object.values(errors)[0] ?? null;
  const set = <K extends keyof BusinessDraft>(key: K, value: BusinessDraft[K]) => setDraft((d) => ({ ...d, [key]: value }));

  const tzOptions = TIMEZONES.some((t) => t.value === draft.timezone) ? TIMEZONES : [{ value: draft.timezone, label: `${draft.timezone} (actual)` }, ...TIMEZONES];
  const currencyOptions = CURRENCIES.some((c) => c.value === draft.currency) ? CURRENCIES : [{ value: draft.currency, label: `${draft.currency} (actual)` }, ...CURRENCIES];
  const tzNow = nowIn(draft.timezone);
  const adSpendCents = parseEurosToCents(draft.adSpend);

  const save = useMutation({
    mutationFn: async () => {
      const cents = parseEurosToCents(draft.adSpend) ?? 0;
      const payload = { name: draft.name.trim(), timezone: draft.timezone, currency: draft.currency, monthlyAdSpendCents: cents };
      await api.put('/settings/business', payload);
      return { name: payload.name, timezone: payload.timezone, currency: payload.currency, adSpend: centsToInput(cents) } satisfies BusinessDraft;
    },
    onSuccess: (saved) => {
      markSaved(saved);
      toast('Datos del negocio guardados');
      // El nombre aparece en la barra lateral; la zona horaria afecta a la agenda; la inversión, al ROI.
      for (const key of ['settings', 'me', 'availability', 'slots', 'appointments', 'analytics', 'dashboard']) void qc.invalidateQueries({ queryKey: [key] });
    },
    onError: (e) => toast(errorText(e), 'error'),
  });

  return (
    <Card title="Tu negocio" icon={Building2}>
      <div className="col gap-16">
        <div className="grid-2">
          <Field label="Nombre del negocio" htmlFor={ids.name} error={errors.name} hint="Es el nombre que ves en KAI y el que aparece en las invitaciones a tu equipo.">
            <Input id={ids.name} value={draft.name} maxLength={120} disabled={!canEdit} aria-invalid={Boolean(errors.name) || undefined} placeholder="Ej.: Estudio Kaizen Madrid" onChange={(e) => set('name', e.target.value)} />
          </Field>
          <Field
            label="Zona horaria"
            htmlFor={ids.tz}
            error={errors.timezone}
            hint={`KAI la usa para proponer llamadas a tu hora y para tus horarios de disponibilidad.${tzNow ? ` Hora actual en esta zona: ${tzNow}.` : ''}`}
          >
            <Select id={ids.tz} value={draft.timezone} options={tzOptions} disabled={!canEdit} onChange={(e) => set('timezone', e.target.value)} />
          </Field>
          <Field label="Moneda" htmlFor={ids.currency} error={errors.currency} hint="Se usa para mostrar importes (como el valor del pipeline) y como moneda por defecto al crear servicios. Cambiarla no convierte los precios que ya tienes.">
            <Select id={ids.currency} value={draft.currency} options={currencyOptions} disabled={!canEdit} onChange={(e) => set('currency', e.target.value)} />
          </Field>
          <Field
            label="Inversión mensual en anuncios (en euros)"
            htmlFor={ids.adSpend}
            error={errors.adSpend}
            hint="Lo que gastas al mes en publicidad (Meta, Google…). Solo sirve para estimar tu ROI (retorno de la inversión) en Analítica. Si no haces anuncios, déjalo en 0."
          >
            <div className="input-group settings-money">
              <Input
                id={ids.adSpend}
                inputMode="decimal"
                value={draft.adSpend}
                disabled={!canEdit}
                aria-invalid={Boolean(errors.adSpend) || undefined}
                placeholder="0"
                onChange={(e) => set('adSpend', e.target.value)}
              />
              <span className="input-suffix">€ / mes</span>
            </div>
          </Field>
        </div>

        {draft.timezone !== base.timezone && !errors.timezone && (
          <Callout tone="info">
            Con la nueva zona horaria, KAI calculará los huecos para llamadas según la hora de esa zona. Las llamadas ya agendadas no cambian. Revisa tus horarios en la <Link to="/app/agenda">Agenda</Link> después de guardar.
          </Callout>
        )}
        {adSpendCents !== null && adSpendCents > 0 && !errors.adSpend && (
          <p className="subtle xs">
            Se tendrá en cuenta como {money(adSpendCents, 'EUR')} al mes en la estimación del ROI. Puedes consultarlo en <Link to="/app/analitica">Analítica</Link>.
          </p>
        )}
      </div>
      <SaveRow dirty={dirty} saving={save.isPending} canEdit={canEdit} error={firstError} onDiscard={reset} onSave={() => save.mutate()} saveLabel="Guardar negocio" />
    </Card>
  );
}

// ───────────── Perfil profesional ─────────────

const LIMITS = {
  displayName: 80,
  specialty: 200,
  idealClient: 1000,
  transformation: 1000,
  methodName: 80,
  methodDescription: 2000,
  credentials: 1000,
} as const;

type TrainerErrors = Partial<Record<keyof Trainer, string>>;

function validateTrainer(d: Trainer): TrainerErrors {
  const e: TrainerErrors = {};
  if (!d.displayName.trim()) e.displayName = 'Escribe tu nombre: KAI lo necesita para hablar de ti con los leads.';
  for (const [key, max] of Object.entries(LIMITS) as [keyof typeof LIMITS, number][]) {
    if (!e[key] && d[key].trim().length > max) e[key] = `Máximo ${max.toLocaleString('es-ES')} caracteres.`;
  }
  return e;
}

const EMPTY_TRAINER: Trainer = { displayName: '', specialty: '', idealClient: '', transformation: '', methodName: '', methodDescription: '', modality: 'online', credentials: '' };

function TrainerCard({ settings, canEdit, onDirtyChange }: { settings: SettingsResponse; canEdit: boolean; onDirtyChange: (dirty: boolean) => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const ids = {
    displayName: useId(),
    specialty: useId(),
    idealClient: useId(),
    transformation: useId(),
    methodName: useId(),
    methodDescription: useId(),
    modality: useId(),
    credentials: useId(),
  };
  const t = settings.trainer ?? EMPTY_TRAINER;
  const { draft, setDraft, dirty, reset, markSaved } = useDraft<Trainer>({
    displayName: t.displayName ?? '',
    specialty: t.specialty ?? '',
    idealClient: t.idealClient ?? '',
    transformation: t.transformation ?? '',
    methodName: t.methodName ?? '',
    methodDescription: t.methodDescription ?? '',
    modality: t.modality ?? 'online',
    credentials: t.credentials ?? '',
  });
  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);
  const errors = validateTrainer(draft);
  const firstError = Object.values(errors)[0] ?? null;
  const set = <K extends keyof Trainer>(key: K, value: Trainer[K]) => setDraft((d) => ({ ...d, [key]: value }));

  const save = useMutation({
    mutationFn: async () => {
      const payload: Trainer = {
        displayName: draft.displayName.trim(),
        specialty: draft.specialty.trim(),
        idealClient: draft.idealClient.trim(),
        transformation: draft.transformation.trim(),
        methodName: draft.methodName.trim(),
        methodDescription: draft.methodDescription.trim(),
        modality: draft.modality,
        credentials: draft.credentials.trim(),
      };
      await api.put('/settings/trainer', payload);
      return payload;
    },
    onSuccess: (saved) => {
      markSaved(saved);
      toast('Perfil profesional guardado');
      void qc.invalidateQueries({ queryKey: ['settings'] });
    },
    onError: (e) => toast(errorText(e), 'error'),
  });

  return (
    <Card title="Tu perfil profesional" icon={UserRound}>
      <p className="muted small" style={{ marginTop: -6, marginBottom: 16 }}>
        KAI usa esta información para presentarte y explicar tu servicio a los leads con tus palabras. Cuanto más concreta sea, mejor encajarán sus respuestas.
      </p>
      <div className="col gap-16">
        <div className="grid-2">
          <Field label="Tu nombre profesional" htmlFor={ids.displayName} error={errors.displayName} hint="El nombre con el que KAI te menciona ante los leads.">
            <Input id={ids.displayName} value={draft.displayName} maxLength={LIMITS.displayName} disabled={!canEdit} aria-invalid={Boolean(errors.displayName) || undefined} placeholder="Ej.: Laura Gómez" onChange={(e) => set('displayName', e.target.value)} />
          </Field>
          <Field label="Tu especialidad" htmlFor={ids.specialty} error={errors.specialty} hint="En una frase: a quién ayudas y con qué.">
            <Input
              id={ids.specialty}
              value={draft.specialty}
              maxLength={LIMITS.specialty}
              disabled={!canEdit}
              aria-invalid={Boolean(errors.specialty) || undefined}
              placeholder="Ej.: Pérdida de grasa para mujeres de 30 a 50 años"
              onChange={(e) => set('specialty', e.target.value)}
            />
          </Field>
        </div>

        <Field label="Tu cliente ideal" htmlFor={ids.idealClient} error={errors.idealClient}>
          <Textarea
            id={ids.idealClient}
            rows={3}
            value={draft.idealClient}
            maxLength={LIMITS.idealClient}
            disabled={!canEdit}
            aria-invalid={Boolean(errors.idealClient) || undefined}
            placeholder="Ej.: Mujeres de 35 a 50 años que trabajan fuera de casa y quieren perder grasa sin dietas extremas."
            onChange={(e) => set('idealClient', e.target.value)}
          />
          <FieldFoot hint="Cuanto más concreto, mejor sabrá KAI con quién merece la pena proponer una llamada." value={draft.idealClient} max={LIMITS.idealClient} />
        </Field>

        <Field label="El cambio que consiguen tus clientes" htmlFor={ids.transformation} error={errors.transformation}>
          <Textarea
            id={ids.transformation}
            rows={3}
            value={draft.transformation}
            maxLength={LIMITS.transformation}
            disabled={!canEdit}
            aria-invalid={Boolean(errors.transformation) || undefined}
            placeholder="Ej.: Que pierdan grasa de forma sostenible, ganen energía y aprendan a comer sin depender de una dieta."
            onChange={(e) => set('transformation', e.target.value)}
          />
          <FieldFoot hint="Descríbelo sin cifras garantizadas: KAI nunca promete resultados." value={draft.transformation} max={LIMITS.transformation} />
        </Field>

        <div className="grid-2">
          <Field label="Nombre de tu método (opcional)" htmlFor={ids.methodName} error={errors.methodName} hint="Si tu forma de trabajar tiene nombre propio.">
            <Input id={ids.methodName} value={draft.methodName} maxLength={LIMITS.methodName} disabled={!canEdit} aria-invalid={Boolean(errors.methodName) || undefined} placeholder="Ej.: Método Quema 360" onChange={(e) => set('methodName', e.target.value)} />
          </Field>
          <div className="field">
            <span className="label" id={ids.modality}>
              Modalidad
            </span>
            <div className="settings-modality" role="group" aria-labelledby={ids.modality}>
              {MODALITIES.map((m) => (
                <button key={m.value} type="button" className="option" aria-pressed={draft.modality === m.value} disabled={!canEdit} title={m.description} onClick={() => set('modality', m.value)}>
                  <m.icon aria-hidden />
                  <strong className="small">{m.label}</strong>
                </button>
              ))}
            </div>
            <span className="hint">{MODALITIES.find((m) => m.value === draft.modality)?.description}</span>
          </div>
        </div>

        <Field label="¿En qué consiste tu método? (opcional)" htmlFor={ids.methodDescription} error={errors.methodDescription}>
          <Textarea
            id={ids.methodDescription}
            rows={4}
            value={draft.methodDescription}
            maxLength={LIMITS.methodDescription}
            disabled={!canEdit}
            aria-invalid={Boolean(errors.methodDescription) || undefined}
            placeholder="Ej.: Entrenamiento de fuerza tres días por semana, nutrición flexible y seguimiento semanal para ajustar el plan."
            onChange={(e) => set('methodDescription', e.target.value)}
          />
          <FieldFoot hint="Explícalo como se lo contarías a un cliente en una llamada." value={draft.methodDescription} max={LIMITS.methodDescription} />
        </Field>

        <div className="settings-credentials">
          <Field
            label="Tu formación y experiencia (opcional)"
            htmlFor={ids.credentials}
            error={errors.credentials}
          >
            <Textarea
              id={ids.credentials}
              rows={3}
              value={draft.credentials}
              maxLength={LIMITS.credentials}
              disabled={!canEdit}
              aria-invalid={Boolean(errors.credentials) || undefined}
              placeholder="Ej.: Graduado en Ciencias de la Actividad Física y del Deporte. Formación en nutrición deportiva."
              onChange={(e) => set('credentials', e.target.value)}
            />
            <FieldFoot hint="Escribe solo datos reales y comprobables: titulaciones, certificaciones, años de experiencia…" value={draft.credentials} max={LIMITS.credentials} />
          </Field>
          <Callout tone="accent" icon={ShieldCheck}>
            <strong>KAI nunca se inventa tu trayectoria.</strong> Cuando quiera transmitir confianza, solo usará lo que escribas en este campo, tal cual. No añadirá títulos, años de experiencia, número de clientes ni resultados que no estén aquí.
            {!draft.credentials.trim() && ' Si lo dejas vacío, KAI no hablará de tu experiencia.'}
          </Callout>
        </div>
      </div>
      <SaveRow dirty={dirty} saving={save.isPending} canEdit={canEdit} error={firstError} onDiscard={reset} onSave={() => save.mutate()} saveLabel="Guardar perfil" />
    </Card>
  );
}

// ───────────── Pestaña ─────────────

export default function BusinessTab({ canEdit, onDirtyChange }: SettingsTabProps & { onDirtyChange: (dirty: boolean) => void }) {
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => api.get<SettingsResponse>('/settings') });
  const [businessDirty, setBusinessDirty] = useState(false);
  const [trainerDirty, setTrainerDirty] = useState(false);
  useEffect(() => onDirtyChange(businessDirty || trainerDirty), [businessDirty, trainerDirty, onDirtyChange]);

  if (settings.isPending) return <PageLoading />;
  if (settings.isError || !settings.data) {
    return (
      <div className="card">
        <EmptyState
          icon={CircleAlert}
          title="No hemos podido cargar los datos del negocio"
          description={errorText(settings.error)}
          action={
            <Button icon={RefreshCw} loading={settings.isFetching} onClick={() => void settings.refetch()}>
              Reintentar
            </Button>
          }
        />
      </div>
    );
  }

  return (
    <>
      <BusinessCard settings={settings.data} canEdit={canEdit} onDirtyChange={setBusinessDirty} />
      <TrainerCard settings={settings.data} canEdit={canEdit} onDirtyChange={setTrainerDirty} />
    </>
  );
}
