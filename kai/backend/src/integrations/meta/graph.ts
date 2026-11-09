import { env } from '../../config/env.js';
import { hmacSha256Hex, safeEqual } from '../../lib/crypto.js';

/**
 * Cliente mínimo de la Graph API de Meta (WhatsApp Cloud API, Instagram Messaging, Lead Ads).
 * Documentación oficial: https://developers.facebook.com/docs/graph-api
 */
export class GraphApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: unknown,
  ) {
    const msg = (body as { error?: { message?: string } })?.error?.message ?? `HTTP ${status}`;
    super(`Meta Graph API: ${msg}`);
    this.name = 'GraphApiError';
  }

  /** Código de error de Meta (190 = token inválido o caducado). */
  get code(): number | undefined {
    return (this.body as { error?: { code?: number } })?.error?.code;
  }

  /** Subcódigo de error de Meta (precisa el motivo, p. ej. 2018278 = fuera de la ventana de mensajería). */
  get subcode(): number | undefined {
    return (this.body as { error?: { error_subcode?: number } })?.error?.error_subcode;
  }

  get isAuthError(): boolean {
    return this.status === 401 || this.status === 403 || this.code === 190 || this.code === 102;
  }
}

export async function graphRequest<T>(
  host: 'graph.facebook.com' | 'graph.instagram.com',
  path: string,
  token: string,
  init: { method?: 'GET' | 'POST' | 'DELETE'; body?: unknown; query?: Record<string, string> } = {},
): Promise<T> {
  const url = new URL(`https://${host}/${env.META_GRAPH_VERSION}/${path.replace(/^\//, '')}`);
  for (const [k, v] of Object.entries(init.query ?? {})) url.searchParams.set(k, v);
  const res = await fetch(url, {
    method: init.method ?? 'GET',
    headers: { Authorization: `Bearer ${token}`, ...(init.body ? { 'Content-Type': 'application/json' } : {}) },
    body: init.body ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  let json: unknown = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch (err) {
    // Páginas de error HTML de un proxy de Meta (502, 503…): se trata como error HTTP normal.
    if (!res.ok) throw new GraphApiError(res.status, { error: { message: text.slice(0, 300) } });
    throw err;
  }
  if (!res.ok) throw new GraphApiError(res.status, json);
  return json as T;
}

/** Verifica la cabecera X-Hub-Signature-256 que Meta envía en cada webhook. */
export function verifyMetaSignature(rawBody: string | undefined, header: string | undefined): boolean {
  if (!env.META_APP_SECRET || !rawBody || !header?.startsWith('sha256=')) return false;
  const expected = `sha256=${hmacSha256Hex(env.META_APP_SECRET, rawBody)}`;
  return safeEqual(expected, header);
}

// ───────────── Errores comprensibles para el entrenador ─────────────

const RATE_LIMIT_CODES = new Set([4, 17, 32, 613, 80007, 130429, 131048, 131056]);
const TEMPORARY_CODES = new Set([1, 2, 131000, 131016]);
const WINDOW_SUBCODES = new Set([2018278, 2534022]);

/**
 * Traduce los códigos de error más habituales de la Graph API (WhatsApp, Instagram, Lead Ads) a un
 * mensaje en español que diga qué ha pasado y qué hacer. Devuelve null si el código no es conocido.
 * El texto original de Meta se conserva en los registros de errores (error_logs).
 */
export function friendlyMetaCode(code: number | undefined, subcode: number | undefined, channelLabel = 'Meta', httpStatus?: number): string | null {
  if (code === 190 || code === 102 || code === 463 || code === 467)
    return `El acceso a ${channelLabel} ha caducado o ya no es válido. Vuelve a conectar la cuenta en Integraciones (pega un token nuevo).`;
  if (code === 131047 || (code === 10 && subcode !== undefined && WINDOW_SUBCODES.has(subcode)))
    return `Han pasado más de 24 h desde el último mensaje del lead y ${channelLabel} no deja escribirle libremente. En WhatsApp hay que usar una plantilla aprobada (configúrala en Integraciones); en Instagram, espera a que el lead vuelva a escribir.`;
  if (code === 551) return 'Esta persona no está disponible en Instagram ahora mismo (puede haber bloqueado la cuenta o desactivado su perfil).';
  if (code === 131026) return 'No se ha podido entregar: ese número no tiene WhatsApp o no puede recibir mensajes. Comprueba el teléfono del lead.';
  if (code === 131030) return 'Tu número de WhatsApp está en modo de prueba y solo puede escribir a los números añadidos en Meta. Añade este número en Meta o pasa la cuenta a producción.';
  if (code === 132000 || code === 132001 || code === 132005 || code === 132007 || code === 132012 || code === 132015 || code === 132016)
    return 'La plantilla de WhatsApp no existe, no está aprobada o no coincide con el idioma o los datos configurados. Revísala en Integraciones.';
  if (code === 131049) return 'Meta no ha entregado el mensaje para no saturar al usuario con mensajes de empresas. Prueba más tarde o espera a que el lead escriba.';
  if (code === 131031 || code === 368)
    return `Meta ha bloqueado temporalmente los envíos de tu cuenta de ${channelLabel} (normalmente por sus políticas). Revisa el estado de la cuenta en Meta Business Suite.`;
  if (code === 131051) return 'Ese tipo de mensaje no es compatible con el canal.';
  if (code !== undefined && RATE_LIMIT_CODES.has(code))
    return `${channelLabel} está limitando los envíos de tu cuenta (demasiados mensajes en poco tiempo). Espera unos minutos e inténtalo de nuevo.`;
  if (code === 10 || code === 200 || code === 3 || (code !== undefined && code >= 200 && code < 300))
    return `A la conexión de ${channelLabel} le falta un permiso para hacer esto. Revisa en Meta los permisos de la app y vuelve a conectar la cuenta en Integraciones.`;
  if (code === 100)
    return `${channelLabel} ha rechazado la petición por un dato no válido (por ejemplo, el identificador de la cuenta o el destinatario). Revisa la conexión en Integraciones.`;
  if ((code !== undefined && TEMPORARY_CODES.has(code)) || (httpStatus !== undefined && httpStatus >= 500))
    return `${channelLabel} ha tenido un problema temporal. Inténtalo de nuevo en unos minutos.`;
  return null;
}

/**
 * Mensaje en español para un fallo al hablar con Meta (envíos, comprobación de cuentas, Lead Ads).
 * Los errores propios de KAI (ya en español) se devuelven tal cual.
 */
export function friendlyMetaError(err: unknown, channelLabel = 'Meta'): string {
  if (err instanceof GraphApiError) {
    return (
      friendlyMetaCode(err.code, err.subcode, channelLabel, err.status) ??
      `${channelLabel} ha rechazado la petición${err.code !== undefined ? ` (código ${err.code})` : ''}. Si se repite, revisa la conexión en Integraciones.`
    );
  }
  const e = err as { name?: string; message?: string; cause?: { code?: string } } | null;
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError') return `${channelLabel} ha tardado demasiado en responder. Inténtalo de nuevo en unos minutos.`;
  if (e?.name === 'TypeError' && /fetch failed/i.test(e.message ?? ''))
    return `No se ha podido conectar con ${channelLabel}. Inténtalo de nuevo en unos minutos.`;
  if (err instanceof SyntaxError) return `${channelLabel} ha devuelto una respuesta que no se ha podido leer. Inténtalo de nuevo en unos minutos.`;
  return e?.message || 'Error desconocido al conectar con Meta.';
}
