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

/** Cancela todos los trabajos pendientes de un negocio (p. ej. cuenta suspendida). */
export async function cancelJobsForBusiness(businessId: string, note: string) {
  await getDb()
    .update(scheduledJobs)
    .set({ status: 'cancelled', finishedAt: new Date(), lastError: note.slice(0, 2000) })
    .where(and(eq(scheduledJobs.businessId, businessId), eq(scheduledJobs.status, 'pending')));
}

/** Da por cancelado un trabajo que ya se había reclamado (no se ejecuta ni se reintenta). */
export async function cancelClaimedJob(jobId: string, note: string) {
  await getDb()
    .update(scheduledJobs)
    .set({ status: 'cancelled', finishedAt: new Date(), lastError: note.slice(0, 2000) })
    .where(and(eq(scheduledJobs.id, jobId), eq(scheduledJobs.status, 'running')));
}

/** ¿Hay un trabajo pendiente o en marcha con esta clave? (para no duplicar los trabajos del sistema). */
export async function hasActiveJob(dedupeKey: string): Promise<boolean> {
  const [row] = await getDb()
    .select({ id: scheduledJobs.id })
    .from(scheduledJobs)
    .where(and(eq(scheduledJobs.dedupeKey, dedupeKey), inArray(scheduledJobs.status, ['pending', 'running'])))
    .limit(1);
  return Boolean(row);
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

/**
 * Renueva el bloqueo de un trabajo justo antes de ejecutarlo. Los trabajos se reclaman en tandas y se ejecutan
 * uno a uno: sin esto, el último de una tanda lenta podría parecer “huérfano” y otro proceso lo repetiría.
 * Devuelve false si el trabajo ya no es nuestro (se liberó y lo reclamó otro proceso, o se canceló).
 */
export async function touchJob(job: Job): Promise<boolean> {
  const rows = await getDb()
    .update(scheduledJobs)
    .set({ lockedAt: new Date() })
    .where(and(eq(scheduledJobs.id, job.id), eq(scheduledJobs.status, 'running'), eq(scheduledJobs.attempts, job.attempts)))
    .returning({ id: scheduledJobs.id });
  return rows.length > 0;
}

export async function completeJob(jobId: string) {
  await getDb().update(scheduledJobs).set({ status: 'done', finishedAt: new Date(), lastError: null }).where(eq(scheduledJobs.id, jobId));
}

/** Violación de un índice único (p. ej. ya hay otro trabajo pendiente con la misma `dedupeKey`). */
function isUniqueViolation(err: unknown): boolean {
  for (let e: unknown = err, i = 0; e && i < 5; e = (e as { cause?: unknown }).cause, i++) {
    if ((e as { code?: string }).code === '23505') return true;
  }
  return false;
}

/**
 * Devuelve un trabajo a la cola. Si mientras tanto se programó otro igual (misma `dedupeKey`, p. ej. una
 * respuesta nueva de KAI para la misma conversación), el nuevo lo sustituye y este se cancela.
 */
async function requeueJob(job: Job, runAt: Date, error: string | null) {
  const db = getDb();
  try {
    await db
      .update(scheduledJobs)
      .set({ status: 'pending', runAt, lockedAt: null, ...(error !== null ? { lastError: error.slice(0, 2000) } : {}) })
      .where(and(eq(scheduledJobs.id, job.id), eq(scheduledJobs.status, 'running')));
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    await db
      .update(scheduledJobs)
      .set({ status: 'cancelled', finishedAt: new Date(), lastError: `${error ? `${error.slice(0, 1500)} · ` : ''}Sustituido por un trabajo más reciente.` })
      .where(eq(scheduledJobs.id, job.id));
  }
}

export async function failJob(job: Job, error: string) {
  if (job.attempts < job.maxAttempts) {
    // Reintento con espera exponencial: 1 min, 4 min, 9 min…
    const delayMs = job.attempts * job.attempts * 60_000;
    await requeueJob(job, new Date(Date.now() + delayMs), error);
  } else {
    await getDb()
      .update(scheduledJobs)
      .set({ status: 'failed', finishedAt: new Date(), lastError: error.slice(0, 2000) })
      .where(eq(scheduledJobs.id, job.id));
  }
}

/**
 * Libera trabajos bloqueados por un proceso que murió a mitad (caída, despliegue…).
 * - Si aún le quedan intentos, vuelve a la cola de inmediato.
 * - Si ya agotó sus intentos (p. ej. un trabajo que tumba el proceso una y otra vez), se marca como fallido
 *   en vez de repetirse sin fin.
 * Devuelve cuántos trabajos ha tocado.
 */
export async function releaseStaleJobs(staleMinutes = 10): Promise<number> {
  const db = getDb();
  const stale = await db
    .select()
    .from(scheduledJobs)
    .where(and(eq(scheduledJobs.status, 'running'), lt(scheduledJobs.lockedAt, new Date(Date.now() - staleMinutes * 60_000))))
    .limit(200);
  for (const job of stale) {
    if (job.attempts >= job.maxAttempts) {
      await db
        .update(scheduledJobs)
        .set({ status: 'failed', finishedAt: new Date(), lastError: 'El proceso se detuvo mientras se ejecutaba el trabajo y ya no quedan reintentos.' })
        .where(and(eq(scheduledJobs.id, job.id), eq(scheduledJobs.status, 'running')));
    } else {
      await requeueJob(job, new Date(), null);
    }
  }
  return stale.length;
}
