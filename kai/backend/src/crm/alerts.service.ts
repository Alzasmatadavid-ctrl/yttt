import { and, desc, eq } from 'drizzle-orm';
import { getDb } from '../database/client.js';
import { alerts, leads } from '../database/schema.js';
import { notFound } from '../lib/errors.js';

type AlertType = (typeof alerts.$inferInsert)['type'];

export interface CreateAlertInput {
  businessId: string;
  type: AlertType;
  title: string;
  body?: string;
  severity?: 'info' | 'warning' | 'critical';
  leadId?: string | null;
  conversationId?: string | null;
  appointmentId?: string | null;
  /**
   * No crear otro si ya hay uno abierto del mismo tipo y con el mismo título (y del mismo lead/cita, si los hay).
   * Con lead o cita, sin esta opción basta con el mismo tipo: un aviso distinto del mismo tipo (p. ej. «Mensaje no
   * enviado» y «Un lead ha pedido no recibir más mensajes») quedaría oculto detrás del otro.
   */
  dedupeByTitle?: boolean;
}

/** Crea un aviso para el entrenador. Evita duplicados abiertos del mismo tipo para el mismo lead/cita. */
export async function createAlert(input: CreateAlertInput) {
  const db = getDb();
  if (input.leadId) {
    // Los leads del simulador no generan avisos (no ensucian el panel real).
    const [lead] = await db.select({ isTest: leads.isTest }).from(leads).where(and(eq(leads.businessId, input.businessId), eq(leads.id, input.leadId))).limit(1);
    if (lead?.isTest) return null;
  }
  const conds = [eq(alerts.businessId, input.businessId), eq(alerts.type, input.type), eq(alerts.status, 'open')];
  if (input.leadId) conds.push(eq(alerts.leadId, input.leadId));
  if (input.appointmentId) conds.push(eq(alerts.appointmentId, input.appointmentId));
  if (input.dedupeByTitle) conds.push(eq(alerts.title, input.title));
  if (input.leadId || input.appointmentId || input.dedupeByTitle) {
    const [existing] = await db.select().from(alerts).where(and(...conds)).limit(1);
    if (existing) return existing;
  }
  const [row] = await db
    .insert(alerts)
    .values({
      businessId: input.businessId,
      type: input.type,
      title: input.title,
      body: input.body ?? '',
      severity: input.severity ?? 'warning',
      leadId: input.leadId ?? null,
      conversationId: input.conversationId ?? null,
      appointmentId: input.appointmentId ?? null,
    })
    .returning();
  return row;
}

export async function listOpenAlerts(businessId: string, limit = 50) {
  return getDb()
    .select({ alert: alerts, leadName: leads.name })
    .from(alerts)
    .leftJoin(leads, and(eq(leads.id, alerts.leadId), eq(leads.businessId, businessId)))
    .where(and(eq(alerts.businessId, businessId), eq(alerts.status, 'open')))
    .orderBy(desc(alerts.createdAt))
    .limit(limit);
}

export async function resolveAlert(businessId: string, alertId: string, status: 'resolved' | 'dismissed' = 'resolved') {
  const [row] = await getDb()
    .update(alerts)
    .set({ status, resolvedAt: new Date() })
    .where(and(eq(alerts.businessId, businessId), eq(alerts.id, alertId)))
    .returning();
  if (!row) throw notFound('Aviso no encontrado.');
  return row;
}

export async function resolveAlertsFor(businessId: string, filter: { leadId?: string; appointmentId?: string; type?: AlertType }) {
  const conds = [eq(alerts.businessId, businessId), eq(alerts.status, 'open')];
  if (filter.leadId) conds.push(eq(alerts.leadId, filter.leadId));
  if (filter.appointmentId) conds.push(eq(alerts.appointmentId, filter.appointmentId));
  if (filter.type) conds.push(eq(alerts.type, filter.type));
  await getDb().update(alerts).set({ status: 'resolved', resolvedAt: new Date() }).where(and(...conds));
}
