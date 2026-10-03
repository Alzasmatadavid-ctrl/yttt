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
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) throw new GraphApiError(res.status, json);
  return json as T;
}

/** Verifica la cabecera X-Hub-Signature-256 que Meta envía en cada webhook. */
export function verifyMetaSignature(rawBody: string | undefined, header: string | undefined): boolean {
  if (!env.META_APP_SECRET || !rawBody || !header?.startsWith('sha256=')) return false;
  const expected = `sha256=${hmacSha256Hex(env.META_APP_SECRET, rawBody)}`;
  return safeEqual(expected, header);
}
