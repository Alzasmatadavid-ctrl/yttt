import { getDb } from '../database/client.js';
import { auditLogs, errorLogs } from '../database/schema.js';
import { errorMessage } from '../lib/errors.js';
import { logger } from '../lib/logger.js';

export type ActorType = 'user' | 'kai' | 'system' | 'integration' | 'admin';

export interface AuditEntry {
  businessId?: string | null;
  actorType: ActorType;
  actorUserId?: string | null;
  action: string;
  entityType?: string;
  entityId?: string;
  metadata?: Record<string, unknown>;
  ip?: string | null;
}

/**
 * Registro de auditoría: quién hizo qué y cuándo (persona, KAI, sistema o integración).
 * Nunca lanza excepción: un fallo de auditoría no debe romper la operación principal.
 */
export async function audit(entry: AuditEntry): Promise<void> {
  try {
    await getDb()
      .insert(auditLogs)
      .values({
        businessId: entry.businessId ?? null,
        actorType: entry.actorType,
        actorUserId: entry.actorUserId ?? null,
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId,
        metadata: entry.metadata ?? {},
        ip: entry.ip ?? null,
      });
  } catch (err) {
    logger.error('audit.write_failed', { action: entry.action, error: errorMessage(err) });
  }
}

export async function logError(
  source: string,
  err: unknown,
  context: Record<string, unknown> = {},
  businessId?: string | null,
  level: 'error' | 'warn' = 'error',
): Promise<void> {
  const message = errorMessage(err);
  logger[level](`${source}: ${message}`, { businessId, ...context });
  try {
    await getDb()
      .insert(errorLogs)
      .values({
        businessId: businessId ?? null,
        level,
        source,
        message: message.slice(0, 2000),
        stack: err instanceof Error ? (err.stack ?? null)?.slice(0, 8000) : null,
        context,
      });
  } catch (writeErr) {
    logger.error('error_log.write_failed', { source, error: errorMessage(writeErr) });
  }
}
