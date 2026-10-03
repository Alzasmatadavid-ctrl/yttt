import { eq } from 'drizzle-orm';
import { getDb } from './client.js';
import { plans, users } from './schema.js';
import { DEFAULT_PLANS } from '../config/defaults.js';
import { env } from '../config/env.js';
import { hashPassword } from '../lib/crypto.js';
import { logger } from '../lib/logger.js';

/** Datos mínimos imprescindibles: planes por defecto y cuenta de administración del SaaS. */
export async function bootstrapData() {
  const db = getDb();
  for (const p of DEFAULT_PLANS) {
    await db
      .insert(plans)
      .values({ key: p.key, name: p.name, description: p.description, priceMonthlyCents: p.priceMonthlyCents, limits: p.limits, sortOrder: p.sortOrder })
      .onConflictDoNothing({ target: plans.key });
  }
  if (env.ADMIN_EMAIL) {
    const email = env.ADMIN_EMAIL.trim().toLowerCase();
    const [existing] = await db.select().from(users).where(eq(users.email, email)).limit(1);
    if (existing && existing.platformRole !== 'admin') {
      await db.update(users).set({ platformRole: 'admin' }).where(eq(users.id, existing.id));
      logger.info('bootstrap.admin_promoted', { email });
    } else if (!existing && env.ADMIN_PASSWORD) {
      await db.insert(users).values({ email, name: 'Administrador', passwordHash: await hashPassword(env.ADMIN_PASSWORD), platformRole: 'admin' });
      logger.info('bootstrap.admin_created', { email });
    }
  }
}
