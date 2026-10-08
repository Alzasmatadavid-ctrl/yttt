/**
 * Métricas de KAI.
 * Las tasas se calculan por COHORTE: de los leads que entraron en el periodo, cuántos respondieron,
 * se cualificaron, agendaron, asistieron y se hicieron clientes. Así los porcentajes son coherentes.
 */
import { and, asc, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import { DateTime } from 'luxon';
import { getDb } from '../database/client.js';
import {
  aiSettings,
  alerts,
  analyticsDaily,
  appointments,
  businesses,
  conversations,
  followUps,
  leads,
  messages,
  plans,
  services,
} from '../database/schema.js';
import { DEFAULT_SCORE_BANDS, type LeadStatus } from '../lib/domain.js';
import { bandMin } from '../crm/scoring.js';
import { autopilotEnabled, conversationLeadJoin, leadMessageUnanswered, needsHumanReplyCondition } from '../crm/conversations.service.js';
import { getInsights } from './insights.js';

export type Period = 'today' | '7d' | '30d' | '90d' | 'custom';

export function periodRange(period: Period, timezone: string, custom?: { from?: string; to?: string }) {
  const now = DateTime.now().setZone(timezone);
  if (period === 'custom' && custom?.from && custom?.to) {
    const from = DateTime.fromISO(custom.from, { zone: timezone }).startOf('day');
    const to = DateTime.fromISO(custom.to, { zone: timezone }).endOf('day');
    if (from.isValid && to.isValid && from <= to) return { from: from.toJSDate(), to: to.toJSDate() };
  }
  const days = period === 'today' ? 0 : period === '7d' ? 6 : period === '90d' ? 89 : 29;
  return { from: now.startOf('day').minus({ days }).toJSDate(), to: now.endOf('day').toJSDate() };
}

const QUALIFIED_STATUSES: LeadStatus[] = ['qualified', 'call_proposed', 'call_booked', 'reminder_sent', 'no_show', 'client'];

/** Probabilidad orientativa de cierre por etapa (para el valor ponderado del pipeline). */
export const STAGE_WEIGHTS: Partial<Record<LeadStatus, number>> = {
  conversing: 0.05,
  interested: 0.1,
  qualified: 0.2,
  call_proposed: 0.25,
  call_booked: 0.4,
  reminder_sent: 0.45,
  no_show: 0.1,
  follow_up: 0.05,
};

const pct = (num: number, den: number) => (den > 0 ? Math.round((num / den) * 1000) / 10 : 0);

async function primaryPriceCents(businessId: string): Promise<{ price: number; currency: string }> {
  const [svc] = await getDb()
    .select({ price: services.priceCents, currency: services.currency })
    .from(services)
    .where(and(eq(services.businessId, businessId), eq(services.isActive, true)))
    .orderBy(sql`${services.isPrimary} desc`, asc(services.createdAt))
    .limit(1);
  if (svc) return { price: svc.price ?? 0, currency: svc.currency };
  // Sin servicio: los importes (valor de las ventas, inversión en anuncios) están en la moneda del negocio.
  const [biz] = await getDb().select({ currency: businesses.currency }).from(businesses).where(eq(businesses.id, businessId)).limit(1);
  return { price: 0, currency: biz?.currency ?? 'EUR' };
}

export async function getFunnel(businessId: string, range: { from: Date; to: Date }) {
  const db = getDb();
  const cohort = and(eq(leads.businessId, businessId), eq(leads.isTest, false), gte(leads.createdAt, range.from), lt(leads.createdAt, range.to));
  // “Respondió” = escribió DESPUÉS de nuestro primer mensaje entregado. Quien escribe primero por Instagram
  // o WhatsApp y luego no contesta a KAI no cuenta (antes contaba todo lead con algún mensaje entrante).
  // Los mensajes de leads de la cohorte siempre son posteriores a `range.from` (el primero saliente lo es).
  const replies = db
    .select({
      leadId: messages.leadId,
      firstOut: sql<Date | null>`min(${messages.createdAt}) filter (where ${messages.direction} = 'outbound' and ${messages.status} not in ('failed', 'skipped'))`.as(
        'first_out',
      ),
      lastIn: sql<Date | null>`max(${messages.createdAt}) filter (where ${messages.direction} = 'inbound')`.as('last_in'),
    })
    .from(messages)
    .where(and(eq(messages.businessId, businessId), gte(messages.createdAt, range.from)))
    .groupBy(messages.leadId)
    .as('replies');
  const [row] = await db
    .select({
      leads: sql<number>`count(*)::int`,
      responded: sql<number>`count(*) filter (where ${replies.firstOut} is not null and ${replies.lastIn} > ${replies.firstOut})::int`,
      contacted: sql<number>`count(*) filter (where ${leads.lastOutboundAt} is not null)::int`,
      qualified: sql<number>`count(*) filter (where ${leads.qualifiedAt} is not null or ${inArray(leads.status, QUALIFIED_STATUSES)})::int`,
      clients: sql<number>`count(*) filter (where ${leads.status} = 'client')::int`,
      lost: sql<number>`count(*) filter (where ${leads.status} = 'lost')::int`,
      avgFirstResponse: sql<number>`coalesce(avg(${leads.firstResponseSeconds}), 0)::int`,
    })
    .from(leads)
    .leftJoin(replies, eq(replies.leadId, leads.id))
    .where(cohort);
  const [appt] = await db
    .select({
      booked: sql<number>`count(distinct ${appointments.leadId})::int`,
      attended: sql<number>`count(distinct ${appointments.leadId}) filter (where ${appointments.status} = 'completed')::int`,
      noShows: sql<number>`count(distinct ${appointments.leadId}) filter (where ${appointments.status} = 'no_show')::int`,
    })
    .from(appointments)
    .innerJoin(leads, and(eq(leads.id, appointments.leadId), eq(leads.businessId, businessId)))
    .where(and(cohort, eq(appointments.businessId, businessId), sql`${appointments.status} <> 'rescheduled'`));
  const [msg] = await db
    .select({
      total: sql<number>`count(*)::int`,
      inbound: sql<number>`count(*) filter (where ${messages.direction} = 'inbound')::int`,
      kai: sql<number>`count(*) filter (where ${messages.senderType} = 'kai' and ${messages.status} = 'sent')::int`,
      human: sql<number>`count(*) filter (where ${messages.senderType} = 'human' and ${messages.status} = 'sent')::int`,
      conversations: sql<number>`count(distinct ${messages.conversationId})::int`,
    })
    .from(messages)
    .innerJoin(leads, and(eq(leads.id, messages.leadId), eq(leads.businessId, businessId)))
    .where(and(eq(messages.businessId, businessId), eq(leads.isTest, false), gte(messages.createdAt, range.from), lt(messages.createdAt, range.to)));
  const [won] = await db
    .select({
      clientsWon: sql<number>`count(*)::int`,
      revenue: sql<number>`coalesce(sum(${leads.dealValueCents}), 0)::bigint`,
      withoutValue: sql<number>`count(*) filter (where ${leads.dealValueCents} is null)::int`,
    })
    .from(leads)
    .where(and(eq(leads.businessId, businessId), eq(leads.isTest, false), gte(leads.wonAt, range.from), lt(leads.wonAt, range.to)));

  const { price, currency } = await primaryPriceCents(businessId);
  const revenueCents = Number(won?.revenue ?? 0) + Number(won?.withoutValue ?? 0) * price;
  const r = row ?? { leads: 0, responded: 0, contacted: 0, qualified: 0, clients: 0, lost: 0, avgFirstResponse: 0 };
  const a = appt ?? { booked: 0, attended: 0, noShows: 0 };
  return {
    leads: r.leads,
    contacted: r.contacted,
    responded: r.responded,
    qualified: r.qualified,
    booked: a.booked,
    attended: a.attended,
    noShows: a.noShows,
    clients: r.clients,
    lost: r.lost,
    rates: {
      response: pct(r.responded, r.leads),
      qualification: pct(r.qualified, r.leads),
      booking: pct(a.booked, r.leads),
      attendance: pct(a.attended, a.attended + a.noShows),
      conversion: pct(r.clients, r.leads),
    },
    avgFirstResponseSeconds: r.avgFirstResponse,
    messages: msg ?? { total: 0, inbound: 0, kai: 0, human: 0, conversations: 0 },
    clientsWon: won?.clientsWon ?? 0,
    revenueCents,
    currency,
  };
}

export async function getTimeseries(businessId: string, range: { from: Date; to: Date }, timezone: string) {
  const db = getDb();
  const day = sql<string>`to_char(date_trunc('day', ${leads.createdAt} at time zone ${timezone}), 'YYYY-MM-DD')`;
  const rows = await db
    .select({ day, source: leads.source, n: sql<number>`count(*)::int` })
    .from(leads)
    .where(and(eq(leads.businessId, businessId), eq(leads.isTest, false), gte(leads.createdAt, range.from), lt(leads.createdAt, range.to)))
    .groupBy(sql.raw('1'), leads.source);
  const apptDay = sql<string>`to_char(date_trunc('day', ${appointments.createdAt} at time zone ${timezone}), 'YYYY-MM-DD')`;
  const appts = await db
    .select({ day: apptDay, n: sql<number>`count(*)::int` })
    .from(appointments)
    .innerJoin(leads, and(eq(leads.id, appointments.leadId), eq(leads.businessId, businessId)))
    .where(and(eq(appointments.businessId, businessId), eq(leads.isTest, false), gte(appointments.createdAt, range.from), lt(appointments.createdAt, range.to), sql`${appointments.status} <> 'rescheduled'`))
    .groupBy(sql.raw('1'));
  const wonDay = sql<string>`to_char(date_trunc('day', ${leads.wonAt} at time zone ${timezone}), 'YYYY-MM-DD')`;
  const won = await db
    .select({ day: wonDay, n: sql<number>`count(*)::int` })
    .from(leads)
    .where(and(eq(leads.businessId, businessId), eq(leads.isTest, false), gte(leads.wonAt, range.from), lt(leads.wonAt, range.to)))
    .groupBy(sql.raw('1'));

  const days: { day: string; leads: number; bySource: Record<string, number>; booked: number; clients: number }[] = [];
  let cursor = DateTime.fromJSDate(range.from).setZone(timezone).startOf('day');
  const end = DateTime.fromJSDate(range.to).setZone(timezone);
  while (cursor <= end && days.length < 400) {
    days.push({ day: cursor.toISODate()!, leads: 0, bySource: {}, booked: 0, clients: 0 });
    cursor = cursor.plus({ days: 1 });
  }
  const byDay = new Map(days.map((d) => [d.day, d]));
  for (const r of rows) {
    const d = byDay.get(r.day);
    if (!d) continue;
    d.leads += r.n;
    d.bySource[r.source] = (d.bySource[r.source] ?? 0) + r.n;
  }
  for (const r of appts) {
    const d = byDay.get(r.day);
    if (d) d.booked += r.n;
  }
  for (const r of won) {
    const d = byDay.get(r.day);
    if (d) d.clients += r.n;
  }
  return days;
}

export async function getSourceBreakdown(businessId: string, range: { from: Date; to: Date }) {
  return getDb()
    .select({
      source: leads.source,
      leads: sql<number>`count(*)::int`,
      qualified: sql<number>`count(*) filter (where ${leads.qualifiedAt} is not null or ${inArray(leads.status, QUALIFIED_STATUSES)})::int`,
      clients: sql<number>`count(*) filter (where ${leads.status} = 'client')::int`,
    })
    .from(leads)
    .where(and(eq(leads.businessId, businessId), eq(leads.isTest, false), gte(leads.createdAt, range.from), lt(leads.createdAt, range.to)))
    .groupBy(leads.source);
}

export async function getPipelineValue(businessId: string) {
  const db = getDb();
  const { price, currency } = await primaryPriceCents(businessId);
  const rows = await db
    .select({ status: leads.status, n: sql<number>`count(*)::int` })
    .from(leads)
    .where(and(eq(leads.businessId, businessId), eq(leads.isTest, false)))
    .groupBy(leads.status);
  const byStatus = Object.fromEntries(rows.map((r) => [r.status, r.n])) as Partial<Record<LeadStatus, number>>;
  let weighted = 0;
  for (const [status, w] of Object.entries(STAGE_WEIGHTS)) weighted += (byStatus[status as LeadStatus] ?? 0) * (w ?? 0) * price;
  const hot = (byStatus.qualified ?? 0) + (byStatus.call_proposed ?? 0) + (byStatus.call_booked ?? 0) + (byStatus.reminder_sent ?? 0);
  return {
    currency,
    servicePriceCents: price,
    byStatus,
    weightedPipelineCents: Math.round(weighted),
    potentialRevenueCents: hot * price,
  };
}

/**
 * ROI estimado del periodo. `currency` es la moneda de los ingresos (la del servicio principal, ver getFunnel).
 * Nunca se suman importes en monedas distintas: si el plan de KAI se cobra en otra moneda (p. ej. EUR con un
 * negocio en MXN), su coste no entra en el cálculo, y lo mismo con la inversión en anuncios (moneda del negocio).
 */
export async function getRoi(businessId: string, range: { from: Date; to: Date }, revenueCents: number, currency: string) {
  const db = getDb();
  const [row] = await db
    .select({ planPrice: plans.priceMonthlyCents, planCurrency: plans.currency, adSpend: businesses.monthlyAdSpendCents, businessCurrency: businesses.currency })
    .from(businesses)
    .leftJoin(plans, eq(plans.id, businesses.planId))
    .where(eq(businesses.id, businessId))
    .limit(1);
  const cur = currency.toUpperCase();
  const planPrice = row?.planPrice ?? 0;
  const adSpend = row?.adSpend ?? 0;
  const planIncluded = planPrice > 0 && (row?.planCurrency ?? 'EUR').toUpperCase() === cur;
  const adIncluded = adSpend > 0 && (row?.businessCurrency ?? cur).toUpperCase() === cur;
  const days = Math.max(1, Math.round((range.to.getTime() - range.from.getTime()) / 86_400_000));
  const monthly = (planIncluded ? planPrice : 0) + (adIncluded ? adSpend : 0);
  const costCents = Math.round((monthly * days) / 30);

  const left: string[] = [];
  if (planPrice > 0 && !planIncluded) left.push(`el coste de KAI (tu plan se cobra en ${(row?.planCurrency ?? 'EUR').toUpperCase()})`);
  if (adSpend > 0 && !adIncluded) left.push(`la inversión en anuncios (está en ${(row?.businessCurrency ?? '').toUpperCase()})`);
  // Con la preposición ya contraída: «frente al coste de KAI y a la inversión…» (nunca «frente a el»).
  const counted = [planIncluded ? 'al coste de KAI' : '', adIncluded ? 'a la inversión en anuncios indicada' : ''].filter(Boolean).join(' y ');
  const note = costCents > 0
    ? `Estimación: ingresos de clientes cerrados en el periodo frente ${counted}.${left.length ? ` No incluye ${left.join(' ni ')}, porque tus importes están en ${cur} y no se mezclan monedas.` : ''}`
    : left.length
      ? `No se puede estimar el ROI: ${left.join(' y ')} y tus ingresos están en ${cur}, y no se mezclan monedas.`
      : 'Estimación: ingresos de clientes cerrados en el periodo frente al coste de KAI y la inversión en anuncios indicada.';
  return {
    costCents,
    revenueCents,
    currency: cur,
    includes: { plan: planIncluded, adSpend: adIncluded },
    roi: costCents > 0 ? Math.round(((revenueCents - costCents) / costCents) * 1000) / 10 : null,
    note,
  };
}

/** Pantalla principal: qué está pasando y qué necesita atención AHORA. */
export async function getDashboard(businessId: string, opts: { advanced: boolean } = { advanced: true }) {
  const db = getDb();
  const [biz] = await db.select().from(businesses).where(eq(businesses.id, businessId)).limit(1);
  const tz = biz?.timezone ?? 'Europe/Madrid';
  const today = periodRange('today', tz);
  const last30 = periodRange('30d', tz);
  const notTest = and(eq(leads.businessId, businessId), eq(leads.isTest, false));

  const [counts] = await db
    .select({
      newToday: sql<number>`count(*) filter (where ${leads.createdAt} >= ${today.from})::int`,
      // Leads a los que KAI o el equipo ya han escrito (no solo los que siguen en la etapa “Contactado”).
      contacted: sql<number>`count(*) filter (where ${leads.lastOutboundAt} is not null)::int`,
      active: sql<number>`count(*) filter (where ${leads.lastInteractionAt} >= now() - interval '7 days' and ${leads.status} not in ('client','lost'))::int`,
      hot: sql<number>`count(*) filter (where ${leads.temperature} in ('caliente','muy_cualificado') and ${leads.status} not in ('client','lost'))::int`,
      qualified: sql<number>`count(*) filter (where ${leads.status} in ('qualified','call_proposed'))::int`,
      noReply: sql<number>`count(*) filter (where ${leads.lastOutboundAt} is not null and (${leads.lastInboundAt} is null or ${leads.lastInboundAt} < ${leads.lastOutboundAt}) and ${leads.lastOutboundAt} < now() - interval '24 hours' and ${leads.status} not in ('client','lost'))::int`,
    })
    .from(leads)
    .where(notTest);

  const [convs] = await db
    .select({ active: sql<number>`count(*)::int` })
    .from(conversations)
    .innerJoin(leads, conversationLeadJoin)
    .where(and(eq(conversations.businessId, businessId), eq(leads.businessId, businessId), eq(leads.isTest, false), sql`${conversations.lastMessageAt} >= now() - interval '24 hours'`));

  const [fus] = await db
    .select({ pending: sql<number>`count(*)::int` })
    .from(followUps)
    .where(and(eq(followUps.businessId, businessId), eq(followUps.status, 'scheduled')));

  // Las citas del simulador (leads de prueba) no cuentan como llamadas reales.
  const callsToday = await db
    .select({ appointment: appointments, leadName: leads.name, leadScore: leads.score, goal: leads.goalSummary })
    .from(appointments)
    .innerJoin(leads, and(eq(leads.id, appointments.leadId), eq(leads.businessId, businessId)))
    .where(
      and(
        eq(appointments.businessId, businessId),
        eq(leads.isTest, false),
        eq(appointments.status, 'scheduled'),
        gte(appointments.startsAt, today.from),
        lt(appointments.startsAt, today.to),
      ),
    )
    .orderBy(asc(appointments.startsAt));
  const upcomingWhere = and(
    eq(appointments.businessId, businessId),
    eq(leads.isTest, false),
    eq(appointments.status, 'scheduled'),
    gte(appointments.startsAt, today.to),
    lt(appointments.startsAt, new Date(Date.now() + 7 * 86_400_000)),
  );
  // La lista muestra las 10 primeras; el indicador cuenta todas las de los próximos 7 días.
  const apptLeadJoin = and(eq(leads.id, appointments.leadId), eq(leads.businessId, businessId));
  const upcoming = await db
    .select({ appointment: appointments, leadName: leads.name, leadScore: leads.score, goal: leads.goalSummary })
    .from(appointments)
    .innerJoin(leads, apptLeadJoin)
    .where(upcomingWhere)
    .orderBy(asc(appointments.startsAt))
    .limit(10);
  const [upcomingCount] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(appointments)
    .innerJoin(leads, apptLeadJoin)
    .where(upcomingWhere);

  const openAlerts = await db
    .select({ alert: alerts, leadName: leads.name })
    .from(alerts)
    .leftJoin(leads, and(eq(leads.id, alerts.leadId), eq(leads.businessId, businessId)))
    .where(and(eq(alerts.businessId, businessId), eq(alerts.status, 'open')))
    .orderBy(sql`case ${alerts.severity} when 'critical' then 0 when 'warning' then 1 else 2 end`, sql`${alerts.createdAt} desc`)
    .limit(20);

  // Leads a punto de perderse: interesados o más (según las bandas de puntuación del negocio),
  // sin contestar hace 48 h y sin llamada. Los que ya esperan respuesta de una persona (escalado o mensaje sin
  // contestar) no se repiten aquí: salen en «Esperan tu respuesta» o como aviso, y es la misma tarea.
  const [settings] = await db.select({ scoreBands: aiSettings.scoreBands }).from(aiSettings).where(eq(aiSettings.businessId, businessId)).limit(1);
  const interestedMin = bandMin(settings?.scoreBands ?? DEFAULT_SCORE_BANDS, 'interesado', 51);
  const autopilotOn = await autopilotEnabled(businessId);
  const atRisk = await db
    .select({ id: leads.id, name: leads.name, score: leads.score, temperature: leads.temperature, status: leads.status, lastInboundAt: leads.lastInboundAt, lastOutboundAt: leads.lastOutboundAt, goalSummary: leads.goalSummary })
    .from(leads)
    .where(
      and(
        notTest,
        gte(leads.score, interestedMin),
        inArray(leads.status, ['conversing', 'interested', 'qualified', 'call_proposed', 'follow_up', 'no_show']),
        sql`coalesce(${leads.lastInboundAt}, ${leads.createdAt}) < now() - interval '48 hours'`,
        sql`not exists (select 1 from ${conversations} where ${conversations.leadId} = ${leads.id} and ${conversations.businessId} = ${leads.businessId} and ${needsHumanReplyCondition({ autopilotOn })})`,
      ),
    )
    .orderBy(sql`${leads.score} desc`)
    .limit(8);

  // Leads esperando respuesta de una persona: KAI escalado o en pausa, piloto automático apagado o un
  // cliente que ha escrito (la misma condición que «Pendientes» en la Bandeja).
  const waiting = await db
    .select({ conversationId: conversations.id, leadId: leads.id, name: leads.name, score: leads.score, temperature: leads.temperature, preview: conversations.lastMessagePreview, lastInboundAt: conversations.lastInboundAt, handoff: conversations.handoffActive })
    .from(conversations)
    .innerJoin(leads, conversationLeadJoin)
    .where(
      and(
        eq(conversations.businessId, businessId),
        eq(leads.businessId, businessId),
        eq(leads.isTest, false),
        needsHumanReplyCondition({ autopilotOn }),
        // Con un escalado sin mensaje nuevo del lead no hay nada que contestar aquí: ya sale como aviso.
        // Los recordatorios, confirmaciones y seguimientos automáticos no cuentan como respuesta (igual que en la Bandeja).
        leadMessageUnanswered(),
      ),
    )
    .orderBy(sql`${leads.score} desc`)
    .limit(8);

  const funnel = await getFunnel(businessId, last30);
  const value = await getPipelineValue(businessId);
  const roi = await getRoi(businessId, last30, funnel.revenueCents, funnel.currency);
  const insights = opts.advanced ? await getInsights(businessId, last30, funnel, await getSourceBreakdown(businessId, last30)) : [];

  return {
    timezone: tz,
    /** false = piloto automático apagado: KAI no contesta a nadie (la interfaz no debe decir que «se encarga»). */
    autopilotEnabled: autopilotOn,
    leads: { newToday: counts?.newToday ?? 0, contacted: counts?.contacted ?? 0, active: counts?.active ?? 0, hot: counts?.hot ?? 0, qualified: counts?.qualified ?? 0 },
    conversion: funnel.rates,
    funnel30d: funnel,
    activity: {
      activeConversations: convs?.active ?? 0,
      pendingFollowUps: fus?.pending ?? 0,
      callsToday: callsToday.length,
      upcomingCalls: upcomingCount?.n ?? 0,
      leadsWithoutReply: counts?.noReply ?? 0,
    },
    callsToday,
    upcoming,
    attention: { alerts: openAlerts, atRisk, waiting },
    value: { ...value, revenue30dCents: funnel.revenueCents, roi30d: roi },
    insights,
    insightsLocked: !opts.advanced,
  };
}

/** `advanced` = el plan incluye analítica avanzada (recomendaciones “Lo que KAI ha aprendido”). */
export async function getAnalytics(businessId: string, period: Period, custom?: { from?: string; to?: string }, opts: { advanced: boolean } = { advanced: true }) {
  const [biz] = await getDb().select({ timezone: businesses.timezone }).from(businesses).where(eq(businesses.id, businessId)).limit(1);
  const tz = biz?.timezone ?? 'Europe/Madrid';
  const range = periodRange(period, tz, custom);
  const [funnel, series, sources, value] = await Promise.all([
    getFunnel(businessId, range),
    getTimeseries(businessId, range, tz),
    getSourceBreakdown(businessId, range),
    getPipelineValue(businessId),
  ]);
  const [roi, insights] = await Promise.all([getRoi(businessId, range, funnel.revenueCents, funnel.currency), opts.advanced ? getInsights(businessId, range, funnel, sources) : Promise.resolve([])]);
  return { period, range: { from: range.from.toISOString(), to: range.to.toISOString() }, timezone: tz, funnel, series, sources, value, roi, insights, insightsLocked: !opts.advanced };
}

/** Guarda una foto diaria de métricas por negocio (histórico y panel de administración). */
export async function rollupAnalyticsForAll(day: Date) {
  const db = getDb();
  const all = await db.select({ id: businesses.id, timezone: businesses.timezone }).from(businesses);
  for (const b of all) {
    const d = DateTime.fromJSDate(day).setZone(b.timezone);
    const range = { from: d.startOf('day').toJSDate(), to: d.endOf('day').toJSDate() };
    const f = await getFunnel(b.id, range);
    const metrics: Record<string, number> = {
      leads: f.leads,
      responded: f.responded,
      qualified: f.qualified,
      booked: f.booked,
      attended: f.attended,
      noShows: f.noShows,
      clients: f.clientsWon,
      revenueCents: f.revenueCents,
      kaiMessages: f.messages.kai,
      inboundMessages: f.messages.inbound,
      avgFirstResponseSeconds: f.avgFirstResponseSeconds,
    };
    await db
      .insert(analyticsDaily)
      .values({ businessId: b.id, day: d.toISODate()!, metrics })
      .onConflictDoUpdate({ target: [analyticsDaily.businessId, analyticsDaily.day], set: { metrics } });
  }
}
