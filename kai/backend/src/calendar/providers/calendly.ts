/**
 * Calendly — API v2 oficial (https://developer.calendly.com/api-docs).
 * Flujo de KAI con Calendly:
 *  1. KAI consulta los huecos reales: GET /event_type_available_times (máx. 7 días por consulta).
 *  2. Ofrece 2–3 horarios. Cuando el lead elige, KAI le envía el enlace directo de ese hueco
 *     (`scheduling_url`) con su nombre/email precargados y un identificador en utm_content.
 *  3. Calendly avisa por webhook (invitee.created / invitee.canceled) y KAI registra la cita.
 * (Los webhooks de Calendly requieren un plan de pago de Calendly.)
 */
import { hmacSha256Hex, safeEqual } from '../../lib/crypto.js';
import type { Interval } from '../availability.js';

const BASE = 'https://api.calendly.com';

async function calendly<T>(token: string, path: string, init: { method?: string; body?: unknown; query?: Record<string, string> } = {}): Promise<T> {
  const url = new URL(path.startsWith('http') ? path : `${BASE}${path}`);
  for (const [k, v] of Object.entries(init.query ?? {})) url.searchParams.set(k, v);
  const res = await fetch(url, {
    method: init.method ?? 'GET',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: init.body ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 204) return {} as T;
  const json = (await res.json()) as T & { message?: string; title?: string };
  if (!res.ok) throw new Error(`Calendly ${res.status}: ${json.message ?? json.title ?? 'error'}`);
  return json;
}

export interface CalendlyUser {
  uri: string;
  name: string;
  email: string;
  scheduling_url: string;
  current_organization: string;
  timezone: string;
}

export async function calendlyMe(token: string): Promise<CalendlyUser> {
  const json = await calendly<{ resource: CalendlyUser }>(token, '/users/me');
  return json.resource;
}

export interface CalendlyEventType {
  uri: string;
  name: string;
  duration: number;
  scheduling_url: string;
  active: boolean;
}

export async function calendlyEventTypes(token: string, userUri: string): Promise<CalendlyEventType[]> {
  const json = await calendly<{ collection: CalendlyEventType[] }>(token, '/event_types', { query: { user: userUri, active: 'true', count: '100' } });
  return json.collection;
}

export interface CalendlyAvailableTime {
  status: string;
  start_time: string;
  invitees_remaining: number;
  scheduling_url: string;
}

/** Huecos disponibles reales del tipo de evento. Calendly limita cada consulta a 7 días. */
export async function calendlyAvailableTimes(
  token: string,
  eventTypeUri: string,
  range: { from: Date; to: Date },
  durationMinutes: number,
): Promise<(Interval & { url: string })[]> {
  const out: (Interval & { url: string })[] = [];
  let cursor = new Date(Math.max(range.from.getTime(), Date.now() + 60_000));
  while (cursor < range.to) {
    const chunkEnd = new Date(Math.min(range.to.getTime(), cursor.getTime() + 7 * 24 * 3600_000 - 60_000));
    const json = await calendly<{ collection: CalendlyAvailableTime[] }>(token, '/event_type_available_times', {
      query: { event_type: eventTypeUri, start_time: cursor.toISOString(), end_time: chunkEnd.toISOString() },
    });
    for (const t of json.collection) {
      if (t.status !== 'available') continue;
      const start = new Date(t.start_time);
      out.push({ start, end: new Date(start.getTime() + durationMinutes * 60_000), url: t.scheduling_url });
    }
    cursor = chunkEnd;
  }
  return out;
}

export function calendlyPrefilledUrl(url: string, lead: { name?: string | null; email?: string | null; leadId: string }) {
  const u = new URL(url);
  if (lead.name) u.searchParams.set('name', lead.name);
  if (lead.email) u.searchParams.set('email', lead.email);
  u.searchParams.set('utm_source', 'kai');
  u.searchParams.set('utm_content', lead.leadId);
  return u.toString();
}

export async function calendlyCreateWebhook(token: string, input: { url: string; organization: string; user: string; signingKey: string }) {
  const json = await calendly<{ resource: { uri: string } }>(token, '/webhook_subscriptions', {
    method: 'POST',
    body: {
      url: input.url,
      events: ['invitee.created', 'invitee.canceled'],
      organization: input.organization,
      user: input.user,
      scope: 'user',
      signing_key: input.signingKey,
    },
  });
  return json.resource.uri;
}

export async function calendlyDeleteWebhook(token: string, uri: string) {
  await calendly(token, uri, { method: 'DELETE' });
}

/** Verifica la cabecera `Calendly-Webhook-Signature: t=…,v1=…` (HMAC-SHA256 de `t.cuerpo`). */
export function verifyCalendlySignature(rawBody: string | undefined, header: string | undefined, signingKey: string, toleranceSec = 300): boolean {
  if (!rawBody || !header) return false;
  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=').map((x) => x.trim()) as [string, string]));
  const t = parts.t;
  const v1 = parts.v1;
  if (!t || !v1) return false;
  if (Math.abs(Date.now() / 1000 - Number(t)) > toleranceSec) return false;
  return safeEqual(hmacSha256Hex(signingKey, `${t}.${rawBody}`), v1);
}
