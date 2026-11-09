import { and, eq, gt, lt } from 'drizzle-orm';
import { getDb } from '../database/client.js';
import { sessions, users } from '../database/schema.js';
import { randomToken, sha256 } from '../lib/crypto.js';
import { env } from '../config/env.js';

export const SESSION_COOKIE = 'kai_session';
export const SESSION_TTL_DAYS = 30;
const TOUCH_INTERVAL_MS = 10 * 60_000;

export function sessionCookieOptions() {
  const secure = env.APP_URL.startsWith('https://');
  return {
    path: '/',
    httpOnly: true,
    sameSite: 'lax' as const,
    secure,
    maxAge: SESSION_TTL_DAYS * 24 * 3600,
  };
}

export async function createSession(userId: string, activeBusinessId: string | null, meta: { ip?: string; userAgent?: string }) {
  const token = randomToken(32);
  const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 24 * 3600_000);
  await getDb()
    .insert(sessions)
    .values({
      id: sha256(token),
      userId,
      activeBusinessId,
      ip: meta.ip?.slice(0, 64),
      userAgent: meta.userAgent?.slice(0, 255),
      expiresAt,
    });
  return { token, expiresAt };
}

export async function resolveSession(token: string | undefined) {
  if (!token || token.length < 20 || token.length > 100) return null;
  const db = getDb();
  const id = sha256(token);
  const [row] = await db
    .select({ session: sessions, user: users })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.id, id), gt(sessions.expiresAt, new Date())))
    .limit(1);
  if (!row || !row.user.isActive) return null;
  if (Date.now() - row.session.lastSeenAt.getTime() > TOUCH_INTERVAL_MS) {
    // Sesión deslizante: se renueva con el uso.
    const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 24 * 3600_000);
    await db.update(sessions).set({ lastSeenAt: new Date(), expiresAt }).where(eq(sessions.id, id));
  }
  return row;
}

export async function setActiveBusiness(token: string, businessId: string) {
  await getDb().update(sessions).set({ activeBusinessId: businessId }).where(eq(sessions.id, sha256(token)));
}

export async function destroySession(token: string) {
  await getDb().delete(sessions).where(eq(sessions.id, sha256(token)));
}

export async function destroyUserSessions(userId: string, exceptToken?: string) {
  const db = getDb();
  const rows = await db.select({ id: sessions.id }).from(sessions).where(eq(sessions.userId, userId));
  const keep = exceptToken ? sha256(exceptToken) : null;
  for (const r of rows) if (r.id !== keep) await db.delete(sessions).where(eq(sessions.id, r.id));
}

export async function purgeExpiredSessions() {
  await getDb().delete(sessions).where(lt(sessions.expiresAt, new Date()));
}
