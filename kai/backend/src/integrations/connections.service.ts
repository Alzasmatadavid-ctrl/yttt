import { and, eq, ne } from 'drizzle-orm';
import { getDb } from '../database/client.js';
import { channelConnections } from '../database/schema.js';
import { decryptJson, encryptJson } from '../lib/crypto.js';
import type { ChannelConfig } from '../lib/domain.js';
import { badRequest, notFound } from '../lib/errors.js';
import { audit } from '../audit/audit.service.js';
import { countChannels, getLimits } from '../plans/plans.service.js';
import type { ChannelCredentials } from './channels/types.js';

export type ChannelConnection = typeof channelConnections.$inferSelect;
export type ConnectionChannel = ChannelConnection['channel'];

/** Vista segura (sin credenciales) para enviar al frontend. */
export function publicConnection(c: ChannelConnection) {
  const { credentialsEnc: _omit, ...rest } = c;
  return rest;
}

export function connectionCredentials(c: ChannelConnection): ChannelCredentials | null {
  try {
    return decryptJson<ChannelCredentials>(c.credentialsEnc);
  } catch {
    return null;
  }
}

export async function listConnections(businessId: string) {
  const rows = await getDb()
    .select()
    .from(channelConnections)
    .where(and(eq(channelConnections.businessId, businessId), ne(channelConnections.status, 'disconnected')));
  return rows.map(publicConnection);
}

export async function getActiveConnection(businessId: string, channel: ConnectionChannel, connectionId?: string | null) {
  const conds = [eq(channelConnections.businessId, businessId), eq(channelConnections.channel, channel), ne(channelConnections.status, 'disconnected')];
  if (connectionId) conds.push(eq(channelConnections.id, connectionId));
  const [row] = await getDb()
    .select()
    .from(channelConnections)
    .where(and(...conds))
    .limit(1);
  return row ?? null;
}

/** Enruta un webhook al negocio correcto a partir del identificador de la cuenta externa. */
export async function findConnectionByExternalId(channel: ConnectionChannel, externalAccountId: string) {
  const [row] = await getDb()
    .select()
    .from(channelConnections)
    .where(and(eq(channelConnections.channel, channel), eq(channelConnections.externalAccountId, externalAccountId), ne(channelConnections.status, 'disconnected')))
    .limit(1);
  return row ?? null;
}

export async function upsertConnection(
  businessId: string,
  userId: string,
  input: { channel: ConnectionChannel; externalAccountId: string; displayName: string; accessToken: string; config: ChannelConfig },
) {
  const db = getDb();
  const [taken] = await db
    .select()
    .from(channelConnections)
    .where(and(eq(channelConnections.channel, input.channel), eq(channelConnections.externalAccountId, input.externalAccountId)))
    .limit(1);
  if (taken && taken.businessId !== businessId && taken.status !== 'disconnected')
    throw badRequest('Esta cuenta ya está conectada a otro negocio de KAI.');

  if (!taken || taken.businessId !== businessId || taken.status === 'disconnected') {
    const limits = await getLimits(businessId);
    if (limits.maxChannels !== null && (await countChannels(businessId)) >= limits.maxChannels)
      throw badRequest(`Tu plan permite ${limits.maxChannels} canal(es) conectados.`);
  }

  const values = {
    businessId,
    channel: input.channel,
    externalAccountId: input.externalAccountId,
    displayName: input.displayName,
    credentialsEnc: encryptJson({ accessToken: input.accessToken } satisfies ChannelCredentials),
    config: input.config,
    status: 'connected' as const,
    lastError: null,
    updatedAt: new Date(),
  };
  const [row] = taken
    ? await db.update(channelConnections).set(values).where(eq(channelConnections.id, taken.id)).returning()
    : await db.insert(channelConnections).values(values).returning();
  await audit({ businessId, actorType: 'user', actorUserId: userId, action: 'integration.connected', entityType: 'channel_connection', entityId: row.id, metadata: { channel: input.channel } });
  return publicConnection(row);
}

export async function updateConnectionConfig(businessId: string, userId: string, id: string, config: ChannelConfig, displayName?: string) {
  const [row] = await getDb()
    .update(channelConnections)
    .set({ config, ...(displayName ? { displayName } : {}), updatedAt: new Date() })
    .where(and(eq(channelConnections.businessId, businessId), eq(channelConnections.id, id)))
    .returning();
  if (!row) throw notFound('Conexión no encontrada.');
  await audit({ businessId, actorType: 'user', actorUserId: userId, action: 'integration.updated', entityType: 'channel_connection', entityId: id });
  return publicConnection(row);
}

export async function disconnectConnection(businessId: string, userId: string, id: string) {
  const [row] = await getDb()
    .update(channelConnections)
    .set({ status: 'disconnected', updatedAt: new Date() })
    .where(and(eq(channelConnections.businessId, businessId), eq(channelConnections.id, id)))
    .returning();
  if (!row) throw notFound('Conexión no encontrada.');
  await audit({ businessId, actorType: 'user', actorUserId: userId, action: 'integration.disconnected', entityType: 'channel_connection', entityId: id, metadata: { channel: row.channel } });
}

export async function markConnectionError(id: string, error: string) {
  await getDb().update(channelConnections).set({ status: 'error', lastError: error.slice(0, 500), updatedAt: new Date() }).where(eq(channelConnections.id, id));
}

export async function touchConnection(id: string) {
  await getDb().update(channelConnections).set({ lastEventAt: new Date() }).where(eq(channelConnections.id, id));
}
