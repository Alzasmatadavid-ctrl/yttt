import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parse } from '../lib/http.js';
import { badRequest, limitReached } from '../lib/errors.js';
import { requireTenant } from '../auth/guards.js';
import { getLimits } from '../plans/plans.service.js';
import { getAnalytics, getDashboard } from './analytics.service.js';

const MAX_CUSTOM_DAYS = 366;

export async function analyticsRoutes(app: FastifyInstance) {
  app.get('/dashboard', async (request) => {
    const ctx = await requireTenant(request, 'leads:read');
    const limits = await getLimits(ctx.businessId);
    return getDashboard(ctx.businessId, { advanced: limits.advancedAnalytics });
  });

  app.get('/analytics', async (request) => {
    const ctx = await requireTenant(request, 'analytics:read');
    const q = parse(
      z.object({
        period: z.enum(['today', '7d', '30d', '90d', 'custom']).default('30d'),
        from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      }),
      request.query,
    );
    const limits = await getLimits(ctx.businessId);
    if ((q.period === 'custom' || q.period === '90d') && !limits.advancedAnalytics) {
      throw limitReached('Los periodos personalizados y de 90 días están incluidos en los planes con analítica avanzada.');
    }
    if (q.period === 'custom') {
      if (!q.from || !q.to) throw badRequest('Indica las fechas de inicio y fin.');
      const days = (Date.parse(q.to) - Date.parse(q.from)) / 86_400_000;
      if (!Number.isFinite(days) || days < 0) throw badRequest('La fecha de inicio debe ser anterior a la de fin.');
      if (days > MAX_CUSTOM_DAYS) throw badRequest('El periodo máximo es de un año.');
    }
    return getAnalytics(ctx.businessId, q.period, { from: q.from, to: q.to }, { advanced: limits.advancedAnalytics });
  });
}
