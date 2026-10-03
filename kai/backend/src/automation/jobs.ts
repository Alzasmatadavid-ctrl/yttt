import { and, eq, inArray, lt, sql } from 'drizzle-orm';
import { getDb } from '../database/client.js';
import { scheduledJobs } from '../database/schema.js';

/**
 * Cola de trabajos persistente en PostgreSQL.
 * - Sobrevive a reinicios (los trabajos están en la base de datos).
 * - Varios procesos pueden consumirla a la vez gracias a `FOR UPDATE SKIP LOCKED`.
 * - `dedupeKey` evita duplicados (p. ej. una única respuesta pendiente por conversación).
 */
export type JobType =
  | 'kai_reply'
  | 'followup'
  | 'appointment_confirmation'
  | 'appointment_reminder'
  | 'post_call'
  | 'no_show_message'
  | 'first_contact'
  | 'analytics_rollup'
  | 'maintenance';

export type Job = typeof scheduledJobs.$inferSelect;

export interface ScheduleJobInput {
  type: JobType;
  runAt: Date;
  businessId?: string | null;
  payload?: Record<string, unknown>;
  dedupeKey?: string;
  maxAttempts?: number;
}

export async function scheduleJob(input: ScheduleJobInput): Promise<Job> {
  const db = getDb();
  if (input.dedupeKey) {
    const [existing] = await db
      .select()
      .from(scheduledJobs)
      .where(and(eq(scheduledJobs.dedupeKey, input.dedupeKey), eq(scheduledJobs.status, 'pending')))
      .limit(1);
    if (existing) return existing;
  }
  try {
    const [job] = await db
      .insert(scheduledJobs)
      .values({
        type: input.type,
        runAt: input.runAt,
        businessId: input.businessId ?? null,
        payload: input.payload ?? {},
        dedupeKey: input.dedupeKey ?? null,
        maxAttempts: input.maxAttempts ?? 3,
      })
      .returning();
    return job;
  } catch (err) {
    // Carrera con otro proceso que insertó el mismo dedupeKey: devolvemos el existente.
    if (input.dedupeKey) {
      const [existing] = await db
        .select()
        .from(scheduledJobs)
        .where(and(eq(scheduledJobs.dedupeKey, input.dedupeKey), eq(scheduledJobs.status, 'pending')))
        .limit(1);
      if (existing) return existing;
    }
    throw err;
  }
}

/** Crea el trabajo o, si ya hay uno pendiente con la misma clave, lo reprograma (debounce). */
export async function scheduleOrReschedule(input: ScheduleJobInput & { dedupeKey: string }): Promise<Job> {
  const db = getDb();
  const [existing] = await db
    .select()
    .from(scheduledJobs)
    .where(and(eq(scheduledJobs.dedupeKey, input.dedupeKey), eq(scheduledJobs.status, 'pending')))
    .limit(1);
  if (existing) {
    const [updated] = await db
      .update(scheduledJobs)
      .set({ runAt: input.runAt, payload: { ...existing.payload, ...(input.payload ?? {}) } })
      .where(eq(scheduledJobs.id, existing.id))
      .returning();
    return updated ?? existing;
  }
  return scheduleJob(input);
}

export async function cancelJob(jobId: string) {
  await getDb()
    .update(scheduledJobs)
    .set({ status: 'cancelled', finishedAt: new Date() })
    .where(and(eq(scheduledJobs.id, jobId), eq(scheduledJobs.status, 'pending')));
}

export async function cancelJobsByDedupePrefix(prefix: string) {
  await getDb()
    .update(scheduledJobs)
    .set({ status: 'cancelled', finishedAt: new Date() })
    .where(and(eq(scheduledJobs.status, 'pending'), sql`${scheduledJobs.dedupeKey} like ${prefix + '%'}`));
}

/** Reclama hasta `limit` trabajos vencidos de forma atómica. */
export async function claimDueJobs(limit = 10): Promise<Job[]> {
  const db = getDb();
  const result = await db.execute(sql`
    update ${scheduledJobs} set status = 'running', locked_at = now(), attempts = attempts + 1
    where id in (
      select id from ${scheduledJobs}
      where status = 'pending' and run_at <= now()
      order by run_at asc
      limit ${limit}
      for update skip locked
    )
    returning id
  `);
  const ids = (result as unknown as { rows: { id: string }[] }).rows.map((r) => r.id);
  if (ids.length === 0) return [];
  return db.select().from(scheduledJobs).where(inArray(scheduledJobs.id, ids));
}

export async function completeJob(jobId: string) {
  await getDb().update(scheduledJobs).set({ status: 'done', finishedAt: new Date(), lastError: null }).where(eq(scheduledJobs.id, jobId));
}

export async function failJob(job: Job, error: string) {
  const db = getDb();
  if (job.attempts < job.maxAttempts) {
    // Reintento con espera exponencial: 1 min, 4 min, 9 min…
    const delayMs = job.attempts * job.attempts * 60_000;
    await db
      .update(scheduledJobs)
      .set({ status: 'pending', runAt: new Date(Date.now() + delayMs), lastError: error.slice(0, 2000), lockedAt: null })
      .where(eq(scheduledJobs.id, job.id));
  } else {
    await db
      .update(scheduledJobs)
      .set({ status: 'failed', finishedAt: new Date(), lastError: error.slice(0, 2000) })
      .where(eq(scheduledJobs.id, job.id));
  }
}

/** Libera trabajos bloqueados por un proceso que murió a mitad. */
export async function releaseStaleJobs(staleMinutes = 10) {
  await getDb()
    .update(scheduledJobs)
    .set({ status: 'pending', lockedAt: null })
    .where(and(eq(scheduledJobs.status, 'running'), lt(scheduledJobs.lockedAt, new Date(Date.now() - staleMinutes * 60_000))));
}
