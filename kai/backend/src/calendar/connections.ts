import { and, eq, ne } from 'drizzle-orm';
import { getDb } from '../database/client.js';
import { calendarConnections } from '../database/schema.js';
import { decryptJson, encryptJson } from '../lib/crypto.js';
import { audit, logError } from '../audit/audit.service.js';
import { refreshGoogleToken, type GoogleTokens } from './providers/google.js';
import { calendlyDeleteWebhook } from './providers/calendly.js';

export type CalendarConnection = typeof calendarConnections.$inferSelect;

export interface CalendlyCredentials {
  token: string;
  webhookUri?: string;
  signingKey?: string;
}

export function publicCalendarConnection(c: CalendarConnection) {
  const { credentialsEnc: _omit, ...rest } = c;
  return rest;
}

export async function getCalendarConnection(businessId: string, provider?: 'google' | 'calendly') {
  const conds = [eq(calendarConnections.businessId, businessId), ne(calendarConnections.status, 'disconnected')];
  if (provider) conds.push(eq(calendarConnections.provider, provider));
  const [row] = await getDb()
    .select()
    .from(calendarConnections)
    .where(and(...conds))
    .limit(1);
  return row ?? null;
}

export async function listCalendarConnections(businessId: string) {
  const rows = await getDb()
    .select()
    .from(calendarConnections)
    .where(and(eq(calendarConnections.businessId, businessId), ne(calendarConnections.status, 'disconnected')));
  return rows.map(publicCalendarConnection);
}

/** Devuelve un access token válido de Google, renovándolo si ha caducado. */
export async function googleAccessToken(conn: CalendarConnection): Promise<string> {
  let tokens = decryptJson<GoogleTokens>(conn.credentialsEnc);
  if (tokens.expiresAt - Date.now() < 2 * 60_000) {
    tokens = await refreshGoogleToken(tokens);
    await getDb()
      .update(calendarConnections)
      .set({ credentialsEnc: encryptJson(tokens), tokenExpiresAt: new Date(tokens.expiresAt), status: 'connected', lastError: null, updatedAt: new Date() })
      .where(eq(calendarConnections.id, conn.id));
  }
  return tokens.accessToken;
}

/**
 * Borra en Calendly el webhook de una conexión que se desconecta o se sustituye (reconexión, cambio a Google).
 * Si no, Calendly rechazaría uno nuevo con la misma URL y el viejo seguiría firmando con una clave que ya no
 * se guarda. Un fallo (token revocado, Calendly caído) solo se registra: no impide el cambio.
 */
export async function releaseCalendlyWebhook(conn: CalendarConnection) {
  if (conn.provider !== 'calendly') return;
  try {
    const creds = decryptJson<CalendlyCredentials>(conn.credentialsEnc);
    if (creds.webhookUri) await calendlyDeleteWebhook(creds.token, creds.webhookUri);
  } catch (err) {
    await logError('calendar.calendly.delete_webhook', err, { connectionId: conn.id }, conn.businessId, 'warn');
  }
}

export async function saveCalendarConnection(
  businessId: string,
  userId: string | null,
  input: {
    provider: 'google' | 'calendly';
    credentials: GoogleTokens | CalendlyCredentials;
    accountEmail?: string | null;
    calendarId?: string | null;
    schedulingUrl?: string | null;
    config?: Record<string, unknown>;
    tokenExpiresAt?: Date | null;
  },
) {
  const db = getDb();
  // Solo un calendario activo a la vez: conectar uno desconecta el otro (y Calendly deja de avisar a KAI).
  const replaced = await db
    .select()
    .from(calendarConnections)
    .where(and(eq(calendarConnections.businessId, businessId), ne(calendarConnections.provider, input.provider), ne(calendarConnections.status, 'disconnected')));
  for (const old of replaced) await releaseCalendlyWebhook(old);
  await db
    .update(calendarConnections)
    .set({ status: 'disconnected', updatedAt: new Date() })
    .where(and(eq(calendarConnections.businessId, businessId), ne(calendarConnections.provider, input.provider)));
  const values = {
    businessId,
    provider: input.provider,
    status: 'connected' as const,
    credentialsEnc: encryptJson(input.credentials),
    accountEmail: input.accountEmail ?? null,
    calendarId: input.calendarId ?? null,
    schedulingUrl: input.schedulingUrl ?? null,
    config: input.config ?? {},
    tokenExpiresAt: input.tokenExpiresAt ?? null,
    lastError: null,
    updatedAt: new Date(),
  };
  const [row] = await db
    .insert(calendarConnections)
    .values(values)
    .onConflictDoUpdate({ target: [calendarConnections.businessId, calendarConnections.provider], set: values })
    .returning();
  await audit({ businessId, actorType: 'user', actorUserId: userId, action: 'calendar.connected', entityType: 'calendar_connection', entityId: row.id, metadata: { provider: input.provider } });
  return row;
}

export async function updateCalendarConnection(id: string, patch: Partial<typeof calendarConnections.$inferInsert>) {
  await getDb()
    .update(calendarConnections)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(calendarConnections.id, id));
}

export async function markCalendarError(id: string, error: string) {
  await updateCalendarConnection(id, { status: 'error', lastError: error.slice(0, 500) });
}
