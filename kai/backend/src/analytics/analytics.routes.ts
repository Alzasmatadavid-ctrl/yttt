import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parse } from '../lib/http.js';
import { requireTenant } from '../auth/guards.js';
import { getAnalytics, getDashboard } from './analytics.service.js';

export async function analyticsRoutes(app: FastifyInstance) {
  app.get('/dashboard', async (request) => {
    const ctx = await requireTenant(request, 'leads:read');
    return getDashboard(ctx.businessId);
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
    return getAnalytics(ctx.businessId, q.period, { from: q.from, to: q.to });
  });
}
