/**
 * Google Calendar — API REST oficial (v3) y OAuth 2.0.
 * - OAuth: https://developers.google.com/identity/protocols/oauth2/web-server
 * - FreeBusy: POST https://www.googleapis.com/calendar/v3/freeBusy
 * - Eventos: POST https://www.googleapis.com/calendar/v3/calendars/{calendarId}/events
 */
import { env, publicApiUrl } from '../../config/env.js';
import type { Interval } from '../availability.js';

export const GOOGLE_SCOPES = ['https://www.googleapis.com/auth/calendar.events', 'https://www.googleapis.com/auth/calendar.readonly', 'openid', 'email'];

export interface GoogleTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // epoch ms
}

export const googleRedirectUri = () => `${publicApiUrl()}/api/integrations/google/callback`;

export function googleAuthUrl(state: string): string {
  if (!env.GOOGLE_CLIENT_ID) throw new Error('Google Calendar no está configurado (GOOGLE_CLIENT_ID).');
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.searchParams.set('client_id', env.GOOGLE_CLIENT_ID);
  url.searchParams.set('redirect_uri', googleRedirectUri());
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', GOOGLE_SCOPES.join(' '));
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  url.searchParams.set('include_granted_scopes', 'true');
  url.searchParams.set('state', state);
  return url.toString();
}

async function tokenRequest(params: Record<string, string>) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID ?? '', client_secret: env.GOOGLE_CLIENT_SECRET ?? '', ...params }),
    signal: AbortSignal.timeout(15_000),
  });
  const json = (await res.json()) as { access_token?: string; refresh_token?: string; expires_in?: number; id_token?: string; error?: string; error_description?: string };
  if (!res.ok || !json.access_token) throw new Error(`Google OAuth: ${json.error_description ?? json.error ?? res.status}`);
  return json;
}

export async function exchangeGoogleCode(code: string): Promise<GoogleTokens & { email: string | null }> {
  const json = await tokenRequest({ code, grant_type: 'authorization_code', redirect_uri: googleRedirectUri() });
  if (!json.refresh_token) throw new Error('Google no devolvió un refresh token. Vuelve a conectar aceptando todos los permisos.');
  let email: string | null = null;
  if (json.id_token) {
    try {
      const payload = JSON.parse(Buffer.from(json.id_token.split('.')[1], 'base64url').toString('utf8')) as { email?: string };
      email = payload.email ?? null;
    } catch {
      email = null;
    }
  }
  return { accessToken: json.access_token!, refreshToken: json.refresh_token, expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000, email };
}

export async function refreshGoogleToken(tokens: GoogleTokens): Promise<GoogleTokens> {
  const json = await tokenRequest({ refresh_token: tokens.refreshToken, grant_type: 'refresh_token' });
  return { accessToken: json.access_token!, refreshToken: json.refresh_token ?? tokens.refreshToken, expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000 };
}

async function gcal<T>(token: string, path: string, init: { method?: string; body?: unknown; query?: Record<string, string> } = {}): Promise<T> {
  const url = new URL(`https://www.googleapis.com/calendar/v3/${path}`);
  for (const [k, v] of Object.entries(init.query ?? {})) url.searchParams.set(k, v);
  const res = await fetch(url, {
    method: init.method ?? 'GET',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: init.body ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 204) return {} as T;
  const json = (await res.json()) as T & { error?: { message?: string } };
  if (!res.ok) throw new Error(`Google Calendar ${res.status}: ${json.error?.message ?? 'error'}`);
  return json;
}

export async function googleFreeBusy(token: string, calendarId: string, range: { from: Date; to: Date }, timezone: string): Promise<Interval[]> {
  const json = await gcal<{ calendars: Record<string, { busy?: { start: string; end: string }[]; errors?: unknown[] }> }>(token, 'freeBusy', {
    method: 'POST',
    body: { timeMin: range.from.toISOString(), timeMax: range.to.toISOString(), timeZone: timezone, items: [{ id: calendarId }] },
  });
  const cal = json.calendars?.[calendarId];
  if (cal?.errors?.length) throw new Error('Google Calendar no permite leer la disponibilidad de este calendario.');
  return (cal?.busy ?? []).map((b) => ({ start: new Date(b.start), end: new Date(b.end) }));
}

export async function googleCreateEvent(
  token: string,
  calendarId: string,
  ev: { summary: string; description: string; start: Date; end: Date; timezone: string; attendeeEmail?: string | null; requestId: string },
): Promise<{ id: string; meetUrl: string | null; htmlLink: string | null }> {
  const json = await gcal<{ id: string; hangoutLink?: string; htmlLink?: string; conferenceData?: { entryPoints?: { entryPointType: string; uri: string }[] } }>(
    token,
    `calendars/${encodeURIComponent(calendarId)}/events`,
    {
      method: 'POST',
      query: { conferenceDataVersion: '1', sendUpdates: ev.attendeeEmail ? 'all' : 'none' },
      body: {
        summary: ev.summary,
        description: ev.description,
        start: { dateTime: ev.start.toISOString(), timeZone: ev.timezone },
        end: { dateTime: ev.end.toISOString(), timeZone: ev.timezone },
        attendees: ev.attendeeEmail ? [{ email: ev.attendeeEmail }] : undefined,
        conferenceData: { createRequest: { requestId: ev.requestId, conferenceSolutionKey: { type: 'hangoutsMeet' } } },
        reminders: { useDefault: true },
      },
    },
  );
  const video = json.conferenceData?.entryPoints?.find((e) => e.entryPointType === 'video')?.uri ?? json.hangoutLink ?? null;
  return { id: json.id, meetUrl: video, htmlLink: json.htmlLink ?? null };
}

export async function googleDeleteEvent(token: string, calendarId: string, eventId: string) {
  await gcal(token, `calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`, { method: 'DELETE', query: { sendUpdates: 'all' } });
}
