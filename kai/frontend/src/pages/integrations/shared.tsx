/* Piezas comunes de la página de Integraciones: tipos de la respuesta, copiar al portapapeles, estados y guías desplegables. */
import { useEffect, useId, useState, type ReactNode } from 'react';
import { Check, ChevronDown, Copy, ExternalLink, type LucideIcon } from 'lucide-react';
import type { ChannelConfig } from '@shared';
import { Button, Input, useToast } from '../../components/ui';
import type { CalendarConnection, ChannelConnection } from '../../lib/types';

// ───────────── Tipos (respuesta de GET /api/integrations) ─────────────

export type ChannelRow = ChannelConnection & { createdAt?: string; updatedAt?: string };
export type CalendarRow = CalendarConnection & { createdAt?: string; updatedAt?: string; lastSyncAt?: string | null };

export interface IntegrationsResponse {
  server: { ai: 'anthropic' | 'simulated'; meta: boolean; google: boolean; email: boolean };
  ai: { mode: 'llm' | 'simulated'; provider: string; mainModel: string; fastModel: string };
  channels: ChannelRow[];
  calendars: CalendarRow[];
  endpoints: {
    metaWebhookUrl: string;
    metaVerifyTokenConfigured: boolean;
    leadsWebhookUrl: string;
    publicFormUrl: string;
    publicKey: string;
  };
}

/** Clave compartida con el onboarding (pasos de conexión). */
export const INTEGRATIONS_KEY = ['integrations'] as const;

export type ConnState = 'connected' | 'error' | 'none';

/** Estado agregado de una o varias conexiones. */
export function connState(rows: { status: 'connected' | 'error' | 'disconnected' }[]): ConnState {
  if (rows.some((r) => r.status === 'error')) return 'error';
  if (rows.some((r) => r.status === 'connected')) return 'connected';
  return 'none';
}

export function ConnBadge({ state }: { state: ConnState }) {
  if (state === 'connected') return <span className="badge badge-dot badge-success">Conectado</span>;
  if (state === 'error') return <span className="badge badge-dot badge-danger">Con errores</span>;
  return <span className="badge badge-dot">Sin conectar</span>;
}

/**
 * Deja solo las claves de configuración que acepta el servidor (y sin valores vacíos),
 * para no perder nada al guardar y no enviar campos que rechazaría.
 */
export function cleanConfig(config: ChannelConfig): ChannelConfig {
  const out: ChannelConfig = {};
  if (config.templates) {
    const t: NonNullable<ChannelConfig['templates']> = {};
    for (const key of ['firstContact', 'followUp', 'reminder', 'noShow'] as const) {
      const ref = config.templates[key];
      if (ref?.name?.trim() && ref.language?.trim()) t[key] = { name: ref.name.trim(), language: ref.language.trim() };
    }
    out.templates = t;
  }
  if (config.apiHost) out.apiHost = config.apiHost;
  if (config.phoneNumber) out.phoneNumber = config.phoneNumber.slice(0, 40);
  if (config.wabaId) out.wabaId = config.wabaId.slice(0, 64);
  if (config.pageId) out.pageId = config.pageId.slice(0, 64);
  if (config.formIds) out.formIds = config.formIds.filter(Boolean).slice(0, 50);
  if (config.firstContactChannel) out.firstContactChannel = config.firstContactChannel;
  return out;
}

// ───────────── Copiar al portapapeles ─────────────

function legacyCopy(text: string): boolean {
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  area.remove();
  return ok;
}

/** Copia un texto y avisa con un toast. Devuelve si se ha podido copiar. */
export function useCopy() {
  const toast = useToast();
  return async (text: string, what = 'Copiado'): Promise<boolean> => {
    let ok = false;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        ok = true;
      } else {
        ok = legacyCopy(text);
      }
    } catch {
      ok = legacyCopy(text);
    }
    if (ok) toast(`${what} al portapapeles`);
    else toast('No se ha podido copiar. Selecciona el texto y cópialo a mano.', 'error');
    return ok;
  };
}

export function CopyButton({ text, what, label = 'Copiar', size = 'sm', variant = 'secondary', iconOnly }: { text: string; what?: string; label?: string; size?: 'sm' | 'md'; variant?: 'primary' | 'secondary' | 'ghost'; iconOnly?: boolean }) {
  const copy = useCopy();
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return;
    const t = window.setTimeout(() => setDone(false), 2000);
    return () => window.clearTimeout(t);
  }, [done]);
  return (
    <Button
      size={size}
      variant={variant}
      icon={done ? Check : Copy}
      iconOnly={iconOnly}
      onClick={async () => {
        if (await copy(text, what)) setDone(true);
      }}
    >
      {done ? 'Copiado' : label}
    </Button>
  );
}

/** Campo de solo lectura con botón de copiar (direcciones, claves…). */
export function CopyField({ label, value, hint, what, mono = true }: { label: ReactNode; value: string; hint?: ReactNode; what?: string; mono?: boolean }) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <div className="intg-copy">
        <Input id={id} value={value} readOnly className={mono ? 'intg-mono' : ''} onFocus={(e) => e.currentTarget.select()} />
        <CopyButton text={value} what={what} />
      </div>
      {hint && <span className="hint">{hint}</span>}
    </div>
  );
}

// ───────────── Presentación ─────────────

/** Cabecera de una tarjeta de integración: logo, nombre, subtítulo y estado. */
export function IntegrationHead({ logo, title, subtitle, status }: { logo: ReactNode; title: ReactNode; subtitle?: ReactNode; status?: ReactNode }) {
  return (
    <div className="intg-head">
      <div className="intg-title">
        <span className="intg-logo" aria-hidden>
          {logo}
        </span>
        <div className="grow">
          <h2>{title}</h2>
          {subtitle && <p>{subtitle}</p>}
        </div>
      </div>
      {status}
    </div>
  );
}

/** Bloque desplegable con una guía paso a paso. */
export function Guide({ title = 'Cómo conseguir estos datos', icon: Icon, children, defaultOpen }: { title?: string; icon?: LucideIcon; children: ReactNode; defaultOpen?: boolean }) {
  return (
    <details className="intg-guide" open={defaultOpen}>
      <summary>
        {Icon && <Icon aria-hidden className="intg-guide-icon" />}
        <span>{title}</span>
        <ChevronDown aria-hidden className="intg-chev" />
      </summary>
      <div className="intg-guide-body">{children}</div>
    </details>
  );
}

/** Lista numerada de pasos. */
export function Steps({ children }: { children: ReactNode }) {
  return <ol className="intg-steps">{children}</ol>;
}

/** Nombre de un botón o menú de otra aplicación (para que se reconozca al leerlo). */
export function UiLabel({ children }: { children: ReactNode }) {
  return <span className="intg-ui">{children}</span>;
}

/** Enlace externo que se abre en otra pestaña. */
export function ExtLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="intg-ext">
      {children}
      <ExternalLink aria-hidden />
      <span className="sr-only"> (se abre en una pestaña nueva)</span>
    </a>
  );
}
