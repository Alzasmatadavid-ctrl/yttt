import { count, eq, or } from 'drizzle-orm';
import { getDb, type Database } from '../database/client.js';
import {
  aiSettings,
  automations,
  availabilitySettings,
  businesses,
  memberships,
  objections,
  plans,
  qualificationRules,
  trainers,
} from '../database/schema.js';
import {
  DEFAULT_AUTOMATIONS,
  DEFAULT_AVAILABILITY,
  DEFAULT_HANDOFF_RULES,
  DEFAULT_OBJECTIONS,
  DEFAULT_PLAN_KEY,
  DEFAULT_QUALIFICATION_RULES,
  TRIAL_DAYS,
} from '../config/defaults.js';
import { DEFAULT_SCORE_BANDS, DEFAULT_TONE } from '../lib/domain.js';
import { encrypt, randomToken } from '../lib/crypto.js';
import { addDays } from '../lib/time.js';
import { notFound } from '../lib/errors.js';

export interface CreateBusinessInput {
  name: string;
  ownerUserId: string;
  ownerName: string;
  timezone?: string;
  planKey?: string;
}

/**
 * Crea un negocio (tenant) con toda su configuración inicial:
 * perfil de entrenador, ajustes de KAI, cualificación, objeciones, agenda y automatizaciones.
 */
export async function createBusiness(input: CreateBusinessInput, database: Database = getDb()) {
  return database.transaction(async (tx) => {
    const [plan] = await tx
      .select()
      .from(plans)
      .where(eq(plans.key, input.planKey ?? DEFAULT_PLAN_KEY))
      .limit(1);

    const [business] = await tx
      .insert(businesses)
      .values({
        name: input.name,
        planId: plan?.id ?? null,
        timezone: input.timezone ?? 'Europe/Madrid',
        publicKey: `kai_pk_${randomToken(12)}`,
        webhookSecretEnc: encrypt(`kai_sk_${randomToken(24)}`),
        trialEndsAt: addDays(new Date(), TRIAL_DAYS),
      })
      .returning();

    await tx.insert(memberships).values({ businessId: business.id, userId: input.ownerUserId, role: 'trainer' });
    await tx.insert(trainers).values({ businessId: business.id, userId: input.ownerUserId, displayName: input.ownerName });
    await tx.insert(aiSettings).values({
      businessId: business.id,
      tone: DEFAULT_TONE,
      scoreBands: DEFAULT_SCORE_BANDS,
      handoffRules: DEFAULT_HANDOFF_RULES,
    });
    await tx.insert(qualificationRules).values(
      DEFAULT_QUALIFICATION_RULES.map((r, i) => ({
        businessId: business.id,
        key: r.key,
        label: r.label,
        description: r.description,
        question: r.question,
        weight: r.weight,
        required: r.required,
        sortOrder: i,
        disqualifyWhen: r.disqualifyWhen ?? '',
      })),
    );
    await tx.insert(objections).values(
      DEFAULT_OBJECTIONS.map((o, i) => ({
        businessId: business.id,
        key: o.key,
        label: o.label,
        triggers: o.triggers,
        strategy: o.strategy,
        exampleResponse: o.exampleResponse,
        sortOrder: i,
      })),
    );
    await tx.insert(availabilitySettings).values({ businessId: business.id, weekly: DEFAULT_AVAILABILITY });
    await tx.insert(automations).values(
      DEFAULT_AUTOMATIONS.map((a) => ({ businessId: business.id, type: a.type, name: a.name, config: a.config })),
    );
    return business;
  });
}

export async function getBusiness(businessId: string) {
  const [b] = await getDb().select().from(businesses).where(eq(businesses.id, businessId)).limit(1);
  if (!b) throw notFound('Negocio no encontrado.');
  return b;
}

/** Negocio principal de la cuenta a la que pertenece un negocio. */
export const accountOf = (b: { id: string; accountBusinessId: string | null }) => b.accountBusinessId ?? b.id;

/** Negocios de una cuenta: el principal y los adicionales creados desde ella. */
export async function countAccountBusinesses(accountId: string): Promise<number> {
  const [row] = await getDb()
    .select({ n: count() })
    .from(businesses)
    .where(or(eq(businesses.id, accountId), eq(businesses.accountBusinessId, accountId)));
  return Number(row?.n ?? 0);
}
