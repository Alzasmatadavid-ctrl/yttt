import { and, count, eq, ne, sql } from 'drizzle-orm';
import { getDb } from '../database/client.js';
import { businesses, channelConnections, invitations, memberships, plans, usageCounters } from '../database/schema.js';
import type { PlanLimits, UsageMetric } from '../lib/domain.js';
import { notFound } from '../lib/errors.js';
import { usagePeriod } from '../lib/time.js';

/**
 * Planes y límites. Los límites se leen SIEMPRE de la tabla `plans` (editable en /admin).
 */
export async function getBusinessPlan(businessId: string) {
  const db = getDb();
  const [row] = await db
    .select({ plan: plans, business: businesses })
    .from(businesses)
    .leftJoin(plans, eq(plans.id, businesses.planId))
    .where(eq(businesses.id, businessId))
    .limit(1);
  if (!row) throw notFound('Negocio no encontrado.');
  return row.plan;
}

export async function getLimits(businessId: string): Promise<PlanLimits> {
  const plan = await getBusinessPlan(businessId);
  // Sin plan asignado: límites conservadores para no bloquear, pero sin ilimitados.
  return (
    plan?.limits ?? {
      maxLeadsPerMonth: 50,
      maxAiMessagesPerMonth: 500,
      maxTeamMembers: 1,
      maxChannels: 1,
      maxBusinesses: 1,
      copilot: false,
      advancedAnalytics: false,
    }
  );
}

export async function incrementUsage(businessId: string, metric: UsageMetric, by = 1): Promise<number> {
  const period = usagePeriod();
  const [row] = await getDb()
    .insert(usageCounters)
    .values({ businessId, period, metric, count: by })
    .onConflictDoUpdate({
      target: [usageCounters.businessId, usageCounters.period, usageCounters.metric],
      set: { count: sql`${usageCounters.count} + ${by}` },
    })
    .returning({ count: usageCounters.count });
  return row?.count ?? by;
}

export async function getUsage(businessId: string, period = usagePeriod()): Promise<Record<UsageMetric, number>> {
  const rows = await getDb()
    .select()
    .from(usageCounters)
    .where(and(eq(usageCounters.businessId, businessId), eq(usageCounters.period, period)));
  const out: Record<UsageMetric, number> = { leads: 0, ai_messages: 0, copilot_queries: 0 };
  for (const r of rows) out[r.metric as UsageMetric] = r.count;
  return out;
}

const METRIC_LIMIT: Record<UsageMetric, keyof PlanLimits> = {
  leads: 'maxLeadsPerMonth',
  ai_messages: 'maxAiMessagesPerMonth',
  copilot_queries: 'maxAiMessagesPerMonth',
};

export async function checkUsageLimit(businessId: string, metric: UsageMetric) {
  const [limits, usage] = await Promise.all([getLimits(businessId), getUsage(businessId)]);
  const limit = limits[METRIC_LIMIT[metric]] as number | null;
  const used = metric === 'copilot_queries' ? usage.ai_messages + usage.copilot_queries : usage[metric];
  return { allowed: limit === null || used < limit, used, limit };
}

export async function countSeats(businessId: string): Promise<number> {
  const db = getDb();
  const [m] = await db.select({ n: count() }).from(memberships).where(eq(memberships.businessId, businessId));
  const [i] = await db
    .select({ n: count() })
    .from(invitations)
    .where(and(eq(invitations.businessId, businessId), sql`${invitations.acceptedAt} is null and ${invitations.expiresAt} > now()`));
  return Number(m?.n ?? 0) + Number(i?.n ?? 0);
}

export async function countChannels(businessId: string): Promise<number> {
  const [r] = await getDb()
    .select({ n: count() })
    .from(channelConnections)
    .where(and(eq(channelConnections.businessId, businessId), ne(channelConnections.status, 'disconnected')));
  return Number(r?.n ?? 0);
}

export async function listPublicPlans() {
  return getDb()
    .select({
      key: plans.key,
      name: plans.name,
      description: plans.description,
      priceMonthlyCents: plans.priceMonthlyCents,
      currency: plans.currency,
      limits: plans.limits,
    })
    .from(plans)
    .where(and(eq(plans.isActive, true), eq(plans.isPublic, true)))
    .orderBy(plans.sortOrder);
}
