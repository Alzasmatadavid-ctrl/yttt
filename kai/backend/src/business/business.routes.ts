import type { FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { requireTenant } from '../auth/guards.js';
import { setActiveBusiness } from '../auth/sessions.js';
import { audit } from '../audit/audit.service.js';
import { getDb } from '../database/client.js';
import { businesses, memberships, users } from '../database/schema.js';
import { limitReached } from '../lib/errors.js';
import { parse, timezoneSchema } from '../lib/http.js';
import { getLimits } from '../plans/plans.service.js';
import { createBusiness } from './business.service.js';

/** Negocios adicionales (plan Agency o cualquier plan con `maxBusinesses` > 1). */
export async function businessRoutes(app: FastifyInstance) {
  app.post('/businesses', async (request) => {
    const ctx = await requireTenant(request, 'billing:manage');
    const body = parse(z.object({ name: z.string().trim().min(2, 'Indica el nombre del negocio').max(120), timezone: timezoneSchema.optional() }), request.body);
    const db = getDb();
    const limits = await getLimits(ctx.businessId);
    const owned = await db
      .select({ id: memberships.businessId })
      .from(memberships)
      .where(and(eq(memberships.userId, ctx.userId), eq(memberships.role, 'trainer')));
    if (limits.maxBusinesses !== null && owned.length >= limits.maxBusinesses) {
      throw limitReached(
        limits.maxBusinesses === 1
          ? 'Tu plan incluye un solo negocio. Mejora tu plan para gestionar varios.'
          : `Tu plan permite ${limits.maxBusinesses} negocios y ya los tienes todos. Mejora tu plan para añadir más.`,
      );
    }
    const [parent] = await db.select().from(businesses).where(eq(businesses.id, ctx.businessId)).limit(1);
    const [user] = await db.select({ name: users.name }).from(users).where(eq(users.id, ctx.userId)).limit(1);
    const created = await createBusiness({ name: body.name, ownerUserId: ctx.userId, ownerName: user?.name ?? '', timezone: body.timezone ?? parent.timezone });
    // El nuevo negocio comparte el plan y el estado de suscripción de la cuenta desde la que se crea.
    await db
      .update(businesses)
      .set({ planId: parent.planId, subscriptionStatus: parent.subscriptionStatus, trialEndsAt: parent.trialEndsAt, currency: parent.currency })
      .where(eq(businesses.id, created.id));
    if (request.sessionToken) await setActiveBusiness(request.sessionToken, created.id);
    await audit({ businessId: created.id, actorType: 'user', actorUserId: ctx.userId, action: 'business.created', entityType: 'business', entityId: created.id, metadata: { fromBusinessId: ctx.businessId } });
    return { business: { id: created.id, name: created.name } };
  });
}
