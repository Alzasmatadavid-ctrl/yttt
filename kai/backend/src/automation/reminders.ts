import { and, eq } from 'drizzle-orm';
import { getDb } from '../database/client.js';
import { automations, businesses } from '../database/schema.js';
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
 * Programa confirmación, recordatorios (24 h y 1 h antes) y el aviso post-llamada de una cita.
 */
export async function scheduleAppointmentJobs(
  businessId: string,
  appointment: { id: string; startsAt: Date; endsAt: Date; leadId: string },
  opts: { sendConfirmation: boolean },
) {
  const now = new Date();
  const [biz] = await getDb().select({ timezone: businesses.timezone }).from(businesses).where(eq(businesses.id, businessId)).limit(1);
  const tz = biz?.timezone ?? 'Europe/Madrid';
  const reminders = await getAutomation(businessId, 'appointment_reminders');
  const post = await getAutomation(businessId, 'post_call');
  const base = { businessId, payload: { appointmentId: appointment.id, leadId: appointment.leadId } };

  if (reminders?.enabled) {
    const cfg = reminders.config;
    if (opts.sendConfirmation && cfg.confirmation !== false) {
      await scheduleJob({ ...base, type: 'appointment_confirmation', runAt: addMinutes(now, 1), dedupeKey: `appt:${appointment.id}:confirm` });
    }
    if (cfg.reminder24h !== false) {
      let at = addHours(appointment.startsAt, -24);
      if (isWithinQuietHours(at, tz, cfg.quietHours)) {
        const shifted = shiftOutOfQuietHours(at, tz, cfg.quietHours);
        if (appointment.startsAt.getTime() - shifted.getTime() >= 3 * 3600_000) at = shifted;
      }
      if (at.getTime() > now.getTime() + 60 * 60_000) {
        await scheduleJob({ ...base, type: 'appointment_reminder', runAt: at, payload: { ...base.payload, kind: '24h' }, dedupeKey: `appt:${appointment.id}:r24` });
      }
    }
    if (cfg.reminder1h !== false) {
      const at = addHours(appointment.startsAt, -1);
      if (at.getTime() > now.getTime() + 5 * 60_000) {
        await scheduleJob({ ...base, type: 'appointment_reminder', runAt: at, payload: { ...base.payload, kind: '1h' }, dedupeKey: `appt:${appointment.id}:r1` });
      }
    }
  }
  if (post?.enabled !== false) {
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
