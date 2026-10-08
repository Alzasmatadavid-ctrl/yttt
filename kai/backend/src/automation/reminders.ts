import { and, eq, gt, inArray } from 'drizzle-orm';
import { getDb } from '../database/client.js';
import { appointments, automations, businesses, scheduledJobs } from '../database/schema.js';
import type { AutomationConfig, AutomationType } from '../lib/domain.js';
import { addHours, addMinutes, isWithinQuietHours, shiftOutOfQuietHours } from '../lib/time.js';
import { cancelJobsByDedupePrefix, scheduleJob } from './jobs.js';

export async function getAutomation(businessId: string, type: AutomationType): Promise<{ enabled: boolean; config: AutomationConfig } | null> {
  const [row] = await getDb()
    .select()
    .from(automations)
    .where(and(eq(automations.businessId, businessId), eq(automations.type, type)))
    .limit(1);
  return row ? { enabled: row.enabled, config: row.config } : null;
}

/**
 * ¿Se envía este mensaje de la llamada? La automatización tiene que estar activada y su opción concreta
 * (confirmación, recordatorio de 24 h o de 1 h) sin desmarcar. Se usa al programar Y al enviar: si el
 * entrenador lo desactiva después de reservar, los trabajos ya programados tampoco se envían.
 */
export function appointmentMessageEnabled(
  automation: { enabled: boolean; config: AutomationConfig } | null,
  kind: 'confirmation' | 'reminder24h' | 'reminder1h',
): boolean {
  return Boolean(automation?.enabled) && automation!.config[kind] !== false;
}

/**
 * Programa confirmación, recordatorios (24 h y 1 h antes) y el aviso post-llamada de una cita.
 */
export async function scheduleAppointmentJobs(
  businessId: string,
  appointment: { id: string; startsAt: Date; endsAt: Date; leadId: string },
  /** `postCall: false` = no programar el aviso post-llamada (ya se hizo). */
  opts: { sendConfirmation: boolean; postCall?: boolean },
) {
  const now = new Date();
  const [biz] = await getDb().select({ timezone: businesses.timezone }).from(businesses).where(eq(businesses.id, businessId)).limit(1);
  const tz = biz?.timezone ?? 'Europe/Madrid';
  const reminders = await getAutomation(businessId, 'appointment_reminders');
  const post = await getAutomation(businessId, 'post_call');
  const base = { businessId, payload: { appointmentId: appointment.id, leadId: appointment.leadId } };

  if (reminders?.enabled) {
    const cfg = reminders.config;
    if (opts.sendConfirmation && appointmentMessageEnabled(reminders, 'confirmation')) {
      await scheduleJob({ ...base, type: 'appointment_confirmation', runAt: addMinutes(now, 1), dedupeKey: `appt:${appointment.id}:confirm` });
    }
    if (appointmentMessageEnabled(reminders, 'reminder24h')) {
      let at = addHours(appointment.startsAt, -24);
      if (isWithinQuietHours(at, tz, cfg.quietHours)) {
        const shifted = shiftOutOfQuietHours(at, tz, cfg.quietHours);
        if (appointment.startsAt.getTime() - shifted.getTime() >= 3 * 3600_000) at = shifted;
      }
      if (at.getTime() > now.getTime() + 60 * 60_000) {
        await scheduleJob({ ...base, type: 'appointment_reminder', runAt: at, payload: { ...base.payload, kind: '24h' }, dedupeKey: `appt:${appointment.id}:r24` });
      }
    }
    if (appointmentMessageEnabled(reminders, 'reminder1h')) {
      const at = addHours(appointment.startsAt, -1);
      if (at.getTime() > now.getTime() + 5 * 60_000) {
        await scheduleJob({ ...base, type: 'appointment_reminder', runAt: at, payload: { ...base.payload, kind: '1h' }, dedupeKey: `appt:${appointment.id}:r1` });
      }
    }
  }
  if (post?.enabled !== false && opts.postCall !== false) {
    await scheduleJob({
      ...base,
      type: 'post_call',
      runAt: addMinutes(appointment.endsAt, post?.config.delayMinutes ?? 10),
      dedupeKey: `appt:${appointment.id}:post`,
    });
  }
}

export async function cancelAppointmentJobs(appointmentId: string) {
  await cancelJobsByDedupePrefix(`appt:${appointmentId}:`);
}

/**
 * Al reactivar una cuenta suspendida: vuelve a programar los recordatorios y el aviso post-llamada de las
 * citas que siguen en pie (al suspender se cancelaron). No se reenvía la confirmación, y lo que ya se
 * envió no se repite: los recordatorios lo comprueban antes de enviar, y el aviso post-llamada que ya se
 * hizo no se vuelve a programar (si no, reaparecería el aviso «Registra el resultado» ya descartado).
 */
export async function resumeAppointmentJobs(businessId: string): Promise<number> {
  const db = getDb();
  const since = new Date(Date.now() - 24 * 3600_000);
  const rows = await db
    .select({ id: appointments.id, startsAt: appointments.startsAt, endsAt: appointments.endsAt, leadId: appointments.leadId })
    .from(appointments)
    .where(and(eq(appointments.businessId, businessId), eq(appointments.status, 'scheduled'), gt(appointments.endsAt, since)));
  if (rows.length === 0) return 0;
  const postDone = await db
    .select({ key: scheduledJobs.dedupeKey })
    .from(scheduledJobs)
    .where(and(inArray(scheduledJobs.dedupeKey, rows.map((a) => `appt:${a.id}:post`)), inArray(scheduledJobs.status, ['running', 'done'])));
  const done = new Set(postDone.map((j) => j.key));
  for (const appt of rows) await scheduleAppointmentJobs(businessId, appt, { sendConfirmation: false, postCall: !done.has(`appt:${appt.id}:post`) });
  return rows.length;
}
