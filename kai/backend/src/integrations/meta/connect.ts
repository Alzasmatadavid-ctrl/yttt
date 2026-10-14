import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import { graphRequest } from './graph.js';

/**
 * Comprobaciones al conectar un canal de Meta. KAI usa UNA sola app de Meta (la del propietario de KAI: META_APP_ID y
 * META_APP_SECRET). Meta firma cada aviso del webhook con el secreto de la app a la que pertenece el token, así que un
 * token de otra app (p. ej. una que el entrenador se haya creado) se conectaría bien, podría enviar, pero ningún mensaje
 * de los leads llegaría a KAI. Por eso se rechaza al conectar, y se suscribe la cuenta a la app de KAI para que Meta
 * mande sus avisos (el entrenador no tiene que configurar ningún webhook).
 */

export interface TokenInfo {
  /** App de Meta a la que pertenece el token. */
  appId: string | null;
  /** Permisos con las cuentas concretas a las que dan acceso (p. ej. las cuentas de WhatsApp Business). */
  granularScopes: { scope: string; target_ids?: string[] }[];
}

/** Token de la app de KAI («id|secreto»), o null si el servidor no tiene META_APP_ID y META_APP_SECRET. */
function kaiAppAccessToken(): string | null {
  return env.META_APP_ID && env.META_APP_SECRET ? `${env.META_APP_ID}|${env.META_APP_SECRET}` : null;
}

/**
 * Datos de un token de Facebook (graph.facebook.com) según Meta (GET /debug_token). null si no se puede saber:
 * falta la configuración de la app en el servidor o Meta no responde (no se bloquea la conexión por eso).
 */
export async function inspectMetaToken(token: string): Promise<TokenInfo | null> {
  const appToken = kaiAppAccessToken();
  if (!appToken) return null;
  try {
    const r = await graphRequest<{ data?: { app_id?: string | number; granular_scopes?: TokenInfo['granularScopes'] } }>('graph.facebook.com', 'debug_token', appToken, {
      query: { input_token: token },
    });
    return { appId: r.data?.app_id != null ? String(r.data.app_id) : null, granularScopes: r.data?.granular_scopes ?? [] };
  } catch (err) {
    logger.warn('meta.debug_token_failed', { error: (err as Error).message });
    return null;
  }
}

/** Texto para el entrenador cuando el token es de otra app de Meta (null si es de la app de KAI o no se sabe). */
export function otherAppTokenMessage(info: TokenInfo | null): string | null {
  if (!info?.appId || !env.META_APP_ID || info.appId === env.META_APP_ID) return null;
  return (
    `Este token es de otra app de Meta (identificador ${info.appId}), no de la app de KAI (identificador ${env.META_APP_ID}). ` +
    'KAI solo recibe los mensajes que llegan por su app: con un token de otra app el canal parecería conectado, pero no te llegaría ningún mensaje. ' +
    'Genera el token eligiendo la app de KAI (sigue la guía de esta tarjeta o pídeselo a quien administra KAI).'
  );
}

/**
 * Cuenta de WhatsApp Business (WABA) del número: la indicada en la configuración o, si no, la que da acceso el token
 * (si da acceso a varias, la que contiene el número). null si no se puede saber.
 */
export async function whatsappBusinessAccountFor(phoneNumberId: string, token: string, info: TokenInfo | null, hint?: string): Promise<string | null> {
  if (hint && /^\d+$/.test(hint)) return hint;
  const candidates = [
    ...new Set(
      (info?.granularScopes ?? [])
        .filter((s) => s.scope === 'whatsapp_business_management' || s.scope === 'whatsapp_business_messaging')
        .flatMap((s) => s.target_ids ?? [])
        .map(String),
    ),
  ];
  if (candidates.length === 1) return candidates[0];
  for (const waba of candidates.slice(0, 10)) {
    const r = await graphRequest<{ data?: { id?: string }[] }>('graph.facebook.com', `${waba}/phone_numbers`, token, { query: { fields: 'id', limit: '100' } });
    if (r.data?.some((p) => String(p.id) === phoneNumberId)) return waba;
  }
  return null;
}

/** Suscribe la cuenta de WhatsApp Business a la app del token (la de KAI) para que Meta envíe sus mensajes al webhook. */
export async function subscribeWhatsAppAccount(wabaId: string, token: string): Promise<void> {
  await graphRequest('graph.facebook.com', `${wabaId}/subscribed_apps`, token, { method: 'POST' });
}

/** Activa los avisos de mensajes de una cuenta de Instagram conectada con «Inicio de sesión con Instagram». */
export async function subscribeInstagramAccount(token: string): Promise<void> {
  await graphRequest('graph.instagram.com', 'me/subscribed_apps', token, { method: 'POST', query: { subscribed_fields: 'messages' } });
}
