import { eq } from 'drizzle-orm';
import { getDb } from './client.js';
import { plans, users } from './schema.js';
import { DEFAULT_PLANS } from '../config/defaults.js';
import { env } from '../config/env.js';
import { hashPassword } from '../lib/crypto.js';
import { logger } from '../lib/logger.js';

/**
 * Datos mínimos imprescindibles: planes por defecto y cuenta de administración del SaaS.
 *
 * La cuenta de administración SOLO se crea aquí (nunca desde el registro público), y solo si
 * hay ADMIN_EMAIL y ADMIN_PASSWORD. Si ya existe una cuenta normal con ese email, no se le da
 * el rol de administrador salvo que se pida expresamente con ADMIN_PROMOTE_EXISTING=true:
 * así nadie puede registrarse antes con ese email y quedarse con el panel /admin.
 */
export async function bootstrapData() {
  const db = getDb();
  for (const p of DEFAULT_PLANS) {
    await db
      .insert(plans)
      .values({ key: p.key, name: p.name, description: p.description, priceMonthlyCents: p.priceMonthlyCents, limits: p.limits, sortOrder: p.sortOrder })
      .onConflictDoNothing({ target: plans.key });
  }
  await ensureAdminAccount();
}

export async function ensureAdminAccount(): Promise<'none' | 'exists' | 'created' | 'promoted' | 'not_promoted' | 'missing_password'> {
  if (!env.ADMIN_EMAIL) return 'none';
  const db = getDb();
  const email = env.ADMIN_EMAIL.trim().toLowerCase();
  const [existing] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  if (existing) {
    if (existing.platformRole === 'admin') return 'exists';
    if (env.ADMIN_PROMOTE_EXISTING) {
      await db.update(users).set({ platformRole: 'admin', updatedAt: new Date() }).where(eq(users.id, existing.id));
      logger.info('bootstrap.admin_promoted', { email });
      return 'promoted';
    }
    logger.warn('bootstrap.admin_not_promoted', {
      email,
      hint: 'Ya existe una cuenta normal con ADMIN_EMAIL. Si es tuya y quieres que sea la de administración, arranca una vez con ADMIN_PROMOTE_EXISTING=true.',
    });
    return 'not_promoted';
  }
  if (!env.ADMIN_PASSWORD) {
    logger.warn('bootstrap.admin_missing_password', { email, hint: 'Define ADMIN_PASSWORD para crear la cuenta de administración.' });
    return 'missing_password';
  }
  await db.insert(users).values({ email, name: 'Administrador', passwordHash: await hashPassword(env.ADMIN_PASSWORD), platformRole: 'admin' }).onConflictDoNothing();
  logger.info('bootstrap.admin_created', { email });
  return 'created';
}
