import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { requireTenant } from '../auth/guards.js';
import { setActiveBusiness } from '../auth/sessions.js';
import { audit } from '../audit/audit.service.js';
import { getDb } from '../database/client.js';
import { businesses, users } from '../database/schema.js';
import { limitReached } from '../lib/errors.js';
import { parse, timezoneSchema } from '../lib/http.js';
import { getLimits } from '../plans/plans.service.js';
import { accountOf, countAccountBusinesses, createBusiness } from './business.service.js';

/** Negocios adicionales (plan Agency o cualquier plan con `maxBusinesses` > 1). */
export async function businessRoutes(app: FastifyInstance) {
  app.post('/businesses', async (request) => {
    const ctx = await requireTenant(request, 'billing:manage');
    const body = parse(z.object({ name: z.string().trim().min(2, 'Indica el nombre del negocio').max(120), timezone: timezoneSchema.optional() }), request.body);
    const db = getDb();
    const limits = await getLimits(ctx.businessId);
    const [parent] = await db.select().from(businesses).where(eq(businesses.id, ctx.businessId)).limit(1);
    // El límite es de la cuenta (el negocio principal y los creados desde él), no de cada persona: si se contaran
    // los negocios de quien lo pide, cada miembro invitado como entrenador podría crear otros tantos con el plan
    // y la suscripción de la cuenta.
    const accountId = accountOf(parent);
    if (limits.maxBusinesses !== null && (await countAccountBusinesses(accountId)) >= limits.maxBusinesses) {
      throw limitReached(
        limits.maxBusinesses === 1
          ? 'Tu plan incluye un solo negocio. Mejora tu plan para gestionar varios.'
          : `Tu plan permite ${limits.maxBusinesses} negocios y ya los tienes todos. Mejora tu plan para añadir más.`,
      );
    }
    const [user] = await db.select({ name: users.name }).from(users).where(eq(users.id, ctx.userId)).limit(1);
    const created = await createBusiness({ name: body.name, ownerUserId: ctx.userId, ownerName: user?.name ?? '', timezone: body.timezone ?? parent.timezone });
    // El nuevo negocio pertenece a la misma cuenta y comparte su plan y su estado de suscripción.
    await db
      .update(businesses)
      .set({ accountBusinessId: accountId, planId: parent.planId, subscriptionStatus: parent.subscriptionStatus, trialEndsAt: parent.trialEndsAt, currency: parent.currency })
      .where(eq(businesses.id, created.id));
    if (request.sessionToken) await setActiveBusiness(request.sessionToken, created.id);
    await audit({ businessId: created.id, actorType: 'user', actorUserId: ctx.userId, action: 'business.created', entityType: 'business', entityId: created.id, metadata: { fromBusinessId: ctx.businessId } });
    return { business: { id: created.id, name: created.name } };
  });
}
