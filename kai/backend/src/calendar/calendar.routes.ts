import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parse, uuidParam } from '../lib/http.js';
import { requireTenant } from '../auth/guards.js';
import { getDb } from '../database/client.js';
import { availabilitySettings } from '../database/schema.js';
import { audit } from '../audit/audit.service.js';
import { humanSlotLabel } from '../lib/time.js';
import {
  bookAppointment,
  cancelAppointment,
  getAppointment,
  getAvailabilityConfig,
  getFreeSlots,
  listAppointments,
  rescheduleAppointment,
  setAppointmentOutcome,
} from './calendar.service.js';
import { listCalendarConnections } from './connections.js';

const hm = z.string().regex(/^([01]\d|2[0-4]):[0-5]\d$/, 'Formato HH:MM');
const ranges = z.array(z.object({ start: hm, end: hm }).refine((r) => r.start < r.end, 'La hora de inicio debe ser anterior a la de fin')).max(6);

export const AvailabilitySchema = z.object({
  weekly: z.object({ '1': ranges, '2': ranges, '3': ranges, '4': ranges, '5': ranges, '6': ranges, '7': ranges }),
  slotMinutes: z.number().int().min(10).max(240),
  bufferMinutes: z.number().int().min(0).max(120),
  minNoticeMinutes: z.number().int().min(0).max(7 * 24 * 60),
  maxDaysAhead: z.number().int().min(1).max(90),
  blackoutDates: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).max(366),
});

export async function calendarRoutes(app: FastifyInstance) {
  app.get('/agenda/availability', async (request) => {
    const ctx = await requireTenant(request, 'settings:read');
    const config = await getAvailabilityConfig(ctx.businessId);
    const connections = await listCalendarConnections(ctx.businessId);
    return { config, connections };
  });

  app.put('/agenda/availability', async (request) => {
    const ctx = await requireTenant(request, 'settings:write');
    const body = parse(AvailabilitySchema, request.body);
    await getDb()
      .insert(availabilitySettings)
      .values({ businessId: ctx.businessId, ...body })
      .onConflictDoUpdate({ target: availabilitySettings.businessId, set: { ...body, updatedAt: new Date() } });
    await audit({ businessId: ctx.businessId, actorType: 'user', actorUserId: ctx.userId, action: 'availability.updated' });
    return { ok: true };
  });

  /** Huecos libres reales (los mismos que vería KAI). */
  app.get('/agenda/slots', async (request) => {
    const ctx = await requireTenant(request, 'leads:read');
    const q = parse(z.object({ from: z.coerce.date().optional(), to: z.coerce.date().optional() }), request.query);
    const { slots, config, provider } = await getFreeSlots(ctx.businessId, q.from && q.to ? { from: q.from, to: q.to } : undefined);
    return {
      provider,
      timezone: config.timezone,
      slots: slots.slice(0, 200).map((s) => ({ id: s.id, start: s.start.toISOString(), end: s.end.toISOString(), label: humanSlotLabel(s.start, config.timezone) })),
    };
  });

  app.get('/agenda/appointments', async (request) => {
    const ctx = await requireTenant(request, 'leads:read');
    const q = parse(z.object({ from: z.coerce.date(), to: z.coerce.date() }), request.query);
    return { appointments: await listAppointments(ctx.businessId, { from: q.from, to: q.to }) };
  });

  app.post('/agenda/appointments', async (request) => {
    const ctx = await requireTenant(request, 'leads:write');
    const body = parse(z.object({ leadId: z.string().uuid(), start: z.coerce.date(), conversationId: z.string().uuid().nullable().optional() }), request.body);
    const appointment = await bookAppointment({
      businessId: ctx.businessId,
      leadId: body.leadId,
      conversationId: body.conversationId ?? null,
      start: body.start,
      bookedBy: 'human',
      actor: { type: 'user', userId: ctx.userId },
    });
    return { appointment };
  });

  app.get('/agenda/appointments/:id', async (request) => {
    const ctx = await requireTenant(request, 'leads:read');
    const { id } = parse(uuidParam, request.params);
    return { appointment: await getAppointment(ctx.businessId, id) };
  });

  app.post('/agenda/appointments/:id/cancel', async (request) => {
    const ctx = await requireTenant(request, 'leads:write');
    const { id } = parse(uuidParam, request.params);
    const body = parse(z.object({ reason: z.string().max(300).default('') }), request.body ?? {});
    return { appointment: await cancelAppointment(ctx.businessId, id, { type: 'user', userId: ctx.userId }, body.reason) };
  });

  app.post('/agenda/appointments/:id/reschedule', async (request) => {
    const ctx = await requireTenant(request, 'leads:write');
    const { id } = parse(uuidParam, request.params);
    const body = parse(z.object({ start: z.coerce.date() }), request.body);
    return { appointment: await rescheduleAppointment(ctx.businessId, id, body.start, { type: 'user', userId: ctx.userId }, 'human') };
  });

  app.post('/agenda/appointments/:id/outcome', async (request) => {
    const ctx = await requireTenant(request, 'leads:write');
    const { id } = parse(uuidParam, request.params);
    const body = parse(
      z.object({
        attended: z.boolean(),
        outcome: z.enum(['won', 'lost', 'follow_up']).optional(),
        notes: z.string().max(2000).optional(),
        dealValueCents: z.number().int().min(0).max(100_000_000).nullable().optional(),
      }),
      request.body,
    );
    return { appointment: await setAppointmentOutcome(ctx.businessId, id, body, { type: 'user', userId: ctx.userId }) };
  });
}

