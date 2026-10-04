/* Piezas comunes de Ajustes: tipos de las respuestas de la API, borradores con “cambios sin guardar” y barra de guardado. */
import { useCallback, useState, type ReactNode } from 'react';
import { RotateCcw, Save } from 'lucide-react';
import type { BusinessRole, PlanLimits, UsageMetric } from '@shared';
import { Button } from '../../components/ui';
import type { Plan } from '../../lib/types';
import { parseEurosToCents as parseAmount } from '../../lib/format';

// ───────────── Tipos (reflejan settings.routes.ts) ─────────────

/** GET /api/team → members[] */
export interface TeamMember {
  userId: string;
  name: string;
  email: string;
  role: BusinessRole;
  joinedAt: string;
  lastLoginAt: string | null;
}

/** GET /api/team → invitations[] (solo pendientes y sin caducar) */
export interface TeamInvitation {
  id: string;
  email: string;
  role: BusinessRole;
  expiresAt: string;
  acceptedAt: string | null;
}

export interface TeamResponse {
  members: TeamMember[];
  invitations: TeamInvitation[];
}

/** POST /api/team/invite */
export interface InviteResponse {
  invitation: { id: string; email: string; role: BusinessRole; expiresAt: string };
  link: string;
  emailed: boolean;
}

export type SubscriptionStatus = 'trialing' | 'active' | 'past_due' | 'canceled';

/** GET /api/settings/plan */
export interface PlanResponse {
  plan: Plan | null;
  subscriptionStatus?: SubscriptionStatus;
  trialEndsAt?: string | null;
  limits: PlanLimits;
  usage: Record<UsageMetric, number>;
  seats: number;
  channels: number;
  availablePlans: Plan[];
}

/** Clave de React Query del plan y el uso (cuelga de ['settings'], así que se invalida también al invalidar los ajustes). */
export const PLAN_QUERY_KEY = ['settings', 'plan'] as const;
export const TEAM_QUERY_KEY = ['team'] as const;

/** Propiedades comunes de las pestañas de Ajustes. */
export interface SettingsTabProps {
  /** true si la persona puede cambiar los ajustes del negocio (rol Entrenador). */
  canEdit: boolean;
}

// ───────────── Roles ─────────────

export const ROLE_INFO: Record<BusinessRole, { title: string; summary: string; can: string[]; cannot: string[] }> = {
  trainer: {
    title: 'Entrenador',
    summary: 'Acceso completo al negocio. Pensado para la persona titular o un socio de máxima confianza.',
    can: [
      'Todo lo que puede hacer un miembro del equipo',
      'Cambiar la configuración: datos del negocio, setter, agenda y seguimientos',
      'Conectar canales y calendario (integraciones)',
      'Invitar o quitar personas del equipo y cambiar sus roles',
      'Gestionar el plan y añadir negocios',
      'Eliminar leads',
    ],
    cannot: [],
  },
  team_member: {
    title: 'Miembro del equipo',
    summary: 'Para quien te ayuda en el día a día con los leads y las conversaciones.',
    can: ['Ver y gestionar leads', 'Responder conversaciones', 'Agendar llamadas', 'Consultar la analítica', 'Usar KAI Copilot', 'Ver la configuración (sin cambiarla)'],
    cannot: ['Cambiar la configuración', 'Conectar o desconectar integraciones', 'Gestionar el equipo', 'Gestionar el plan y la facturación', 'Eliminar leads'],
  },
};

// ───────────── Borradores ─────────────

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Borrador editable de una parte de los ajustes.
 * - Si llegan datos nuevos del servidor y NO hay cambios pendientes, el borrador se actualiza solo.
 * - Si hay cambios pendientes, se conservan (no se pisa lo que la persona está escribiendo).
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

/** Pie de una tarjeta editable: estado del guardado + Descartar / Guardar. */
export function SaveRow({
  dirty,
  saving,
  canEdit,
  error,
  onSave,
  onDiscard,
  saveLabel = 'Guardar cambios',
}: {
  dirty: boolean;
  saving: boolean;
  canEdit: boolean;
  error?: string | null;
  onSave: () => void;
  onDiscard: () => void;
  saveLabel?: string;
}) {
  return (
    <div className="settings-actions">
      <div className="grow small" aria-live="polite">
        {!canEdit ? (
          <span className="muted">Solo la persona con rol Entrenador puede cambiar estos datos.</span>
        ) : dirty && error ? (
          <span className="error-text">{error}</span>
        ) : dirty ? (
          <span className="row" style={{ gap: 8 }}>
            <span className="settings-dot" aria-hidden />
            <strong>Tienes cambios sin guardar</strong>
          </span>
        ) : (
          <span className="subtle">Todo está guardado.</span>
        )}
      </div>
      {canEdit && dirty && (
        <Button variant="ghost" size="sm" icon={RotateCcw} onClick={onDiscard} disabled={saving}>
          Descartar
        </Button>
      )}
      {canEdit && (
        <Button variant="primary" size="sm" icon={Save} loading={saving} disabled={!dirty || Boolean(error)} onClick={onSave}>
          {saveLabel}
        </Button>
      )}
    </div>
  );
}

/** Contador de caracteres para textos largos. */
export function CharCount({ value, max }: { value: string; max: number }) {
  const n = value.length;
  return (
    <span className={`xs tnum ${n > max ? 'error-text' : 'subtle'}`} style={{ alignSelf: 'flex-end' }} aria-label={`${n} de ${max} caracteres`}>
      {n.toLocaleString('es-ES')}/{max.toLocaleString('es-ES')}
    </span>
  );
}

/** Pie de un campo de texto largo: explicación a la izquierda y contador de caracteres a la derecha. */
export function FieldFoot({ hint, value, max }: { hint: ReactNode; value: string; max: number }) {
  return (
    <div className="settings-field-foot">
      <span className="hint">{hint}</span>
      <CharCount value={value} max={max} />
    </div>
  );
}

// ───────────── Importes ─────────────

/** Céntimos → texto editable (“300”, “149,90”), en la moneda del negocio. */
export function centsToInput(cents: number | null | undefined): string {
  const c = Math.max(0, Math.round(cents ?? 0));
  return c % 100 === 0 ? String(c / 100) : (c / 100).toFixed(2).replace('.', ',');
}

/**
 * Importe escrito → céntimos. Acepta “300”, “300,5”, “1.250,90” o “1250.90” (con o sin símbolo de moneda: “300 €”, “$300”).
 * Devuelve null si no es un importe válido. Vacío = 0 (en Ajustes, un importe vacío significa «nada»).
 * Usa la conversión común de la app (lib/format) para que un mismo texto valga lo mismo en todas las pantallas.
 */
export function parseEurosToCents(raw: string): number | null {
  if (!raw.replace(/[\s\p{Sc}]/gu, '')) return 0;
  return parseAmount(raw);
}

// ───────────── Fechas ─────────────

export function longDate(value: string | Date | null | undefined): string {
  if (!value) return '—';
  return new Date(value).toLocaleDateString('es-ES', { day: 'numeric', month: 'long', year: 'numeric' });
}

/** Días naturales que faltan hasta una fecha (negativo si ya pasó). */
export function daysUntil(value: string | Date): number {
  return Math.ceil((new Date(value).getTime() - Date.now()) / 86_400_000);
}
