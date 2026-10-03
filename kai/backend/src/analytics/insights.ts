/**
 * “Lo que KAI ha aprendido”: recomendaciones calculadas SOLO con datos reales del negocio.
 *
 * Cada regla exige un mínimo de datos para no sacar conclusiones de 2 leads. Si no hay datos
 * suficientes, no se muestra nada (nunca se rellenan huecos con frases genéricas).
 */
import { and, eq, gte, lt, sql } from 'drizzle-orm';
import { getDb } from '../database/client.js';
import { automations, conversations, followUps, leads, messages, objections } from '../database/schema.js';
import { leadSourceLabel, type LeadSource } from '../lib/domain.js';
import type { getFunnel, getSourceBreakdown } from './analytics.service.js';

export interface Insight {
  key: string;
  tone: 'positive' | 'warning' | 'info';
  title: string;
  detail: string;
  action?: { label: string; to: string };
}

type Funnel = Awaited<ReturnType<typeof getFunnel>>;
type Sources = Awaited<ReturnType<typeof getSourceBreakdown>>;

const MIN_SAMPLE = 5;
const pct = (num: number, den: number) => (den > 0 ? Math.round((num / den) * 100) : 0);

function humanDuration(seconds: number): string {
  if (seconds < 90) return `${Math.max(1, Math.round(seconds))} s`;
  if (seconds < 5400) return `${Math.round(seconds / 60)} min`;
  return `${Math.round((seconds / 3600) * 10) / 10} h`;
}

export async function getInsights(businessId: string, range: { from: Date; to: Date }, funnel: Funnel, sources: Sources): Promise<Insight[]> {
  const db = getDb();
  const out: Insight[] = [];

  // 1. Mejor origen de leads (por tasa de cualificación).
  const eligible = sources.filter((s) => s.leads >= MIN_SAMPLE);
  if (eligible.length >= 2) {
    const ranked = [...eligible].sort((a, b) => b.qualified / b.leads - a.qualified / a.leads);
    const best = ranked[0];
    const worst = ranked[ranked.length - 1];
    const bestRate = pct(best.qualified, best.leads);
    const worstRate = pct(worst.qualified, worst.leads);
    if (bestRate - worstRate >= 10) {
      out.push({
        key: 'best_source',
        tone: 'positive',
        title: `${leadSourceLabel(best.source as LeadSource)} es tu mejor origen de leads`,
        detail: `El ${bestRate}% de sus leads se cualifican, frente al ${worstRate}% de ${leadSourceLabel(worst.source as LeadSource)}. Puede tener sentido dedicarle más esfuerzo.`,
        action: { label: 'Ver analítica', to: '/app/analitica' },
      });
    }
  }

  // 2. Dónde se pierden los leads (la etapa más débil del embudo con muestra suficiente).
  const contacted = Math.max(funnel.contacted, funnel.responded);
  const stages = [
    {
      key: 'drop_response',
      base: contacted,
      rate: pct(funnel.responded, contacted),
      threshold: 40,
      title: 'Muchos leads no responden al primer mensaje',
      detail: (r: number) => `Solo responde el ${r}% de los leads contactados. Prueba un primer mensaje más corto y personal, y responde lo antes posible.`,
      action: { label: 'Ajustar personalidad', to: '/app/setter?tab=personalidad' },
    },
    {
      key: 'drop_qualification',
      base: funnel.responded,
      rate: pct(funnel.qualified, funnel.responded),
      threshold: 30,
      title: 'Pocos de los que responden llegan a cualificarse',
      detail: (r: number) => `El ${r}% de quienes responden se cualifica. Revisa tus preguntas de cualificación o si tus anuncios atraen al cliente que buscas.`,
      action: { label: 'Revisar cualificación', to: '/app/setter?tab=cualificacion' },
    },
    {
      key: 'drop_booking',
      base: funnel.qualified,
      rate: pct(funnel.booked, funnel.qualified),
      threshold: 40,
      title: 'Leads cualificados que no llegan a agendar',
      detail: (r: number) => `Solo el ${r}% de los leads cualificados reserva la llamada. Revisa cómo se presenta la llamada y las respuestas a objeciones.`,
      action: { label: 'Revisar la llamada', to: '/app/setter?tab=llamada' },
    },
  ];
  const weak = stages.filter((s) => s.base >= MIN_SAMPLE && s.rate < s.threshold).sort((a, b) => a.rate / a.threshold - b.rate / b.threshold)[0];
  if (weak) out.push({ key: weak.key, tone: 'warning', title: weak.title, detail: weak.detail(weak.rate), action: weak.action });

  // 3. No-shows.
  const calls = funnel.attended + funnel.noShows;
  if (calls >= 4) {
    const noShowRate = pct(funnel.noShows, calls);
    if (noShowRate >= 25) {
      const [reminders] = await db
        .select({ enabled: automations.enabled })
        .from(automations)
        .where(and(eq(automations.businessId, businessId), eq(automations.type, 'appointment_reminders')))
        .limit(1);
      out.push({
        key: 'no_shows',
        tone: 'warning',
        title: `El ${noShowRate}% de las llamadas acaban en no-show`,
        detail:
          reminders && !reminders.enabled
            ? 'Tienes los recordatorios desactivados. Activarlos suele reducir las ausencias.'
            : 'Recordar el motivo de la llamada en la confirmación y ofrecer horarios cercanos suele reducir las ausencias.',
        action: { label: reminders && !reminders.enabled ? 'Activar recordatorios' : 'Ver seguimientos', to: '/app/setter?tab=seguimientos' },
      });
    } else if (calls >= 8 && noShowRate <= 10) {
      out.push({ key: 'attendance_good', tone: 'positive', title: `Asistencia excelente: ${100 - noShowRate}%`, detail: 'Casi todos los leads que agendan se presentan a la llamada.' });
    }
  }

  // 4. Velocidad de respuesta.
  const [resp] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(leads)
    .where(and(eq(leads.businessId, businessId), eq(leads.isTest, false), gte(leads.createdAt, range.from), lt(leads.createdAt, range.to), sql`${leads.firstResponseSeconds} is not null`));
  if ((resp?.n ?? 0) >= MIN_SAMPLE && funnel.avgFirstResponseSeconds > 0) {
    if (funnel.avgFirstResponseSeconds > 900) {
      out.push({
        key: 'slow_response',
        tone: 'warning',
        title: `Tiempo medio de primera respuesta: ${humanDuration(funnel.avgFirstResponseSeconds)}`,
        detail: 'Cuanto antes se responde, más leads contestan. Comprueba que KAI está activo y que los canales están conectados.',
        action: { label: 'Ver integraciones', to: '/app/integraciones' },
      });
    } else if (funnel.avgFirstResponseSeconds <= 180) {
      out.push({
        key: 'fast_response',
        tone: 'positive',
        title: `Respondes en ${humanDuration(funnel.avgFirstResponseSeconds)} de media`,
        detail: 'Tus leads reciben respuesta mientras todavía están pensando en ti.',
      });
    }
  }

  // 5. Objeciones más frecuentes.
  const objectionResult = await db.execute(sql`
    select o.key as key, count(*)::int as count
    from ${conversations} c, jsonb_array_elements_text(coalesce(c.state->'objectionsHandled', '[]'::jsonb)) as o(key)
    where c.business_id = ${businessId} and c.updated_at >= ${range.from} and c.updated_at < ${range.to}
    group by o.key
    order by count(*) desc
    limit 3
  `);
  const objectionRows = (objectionResult as unknown as { rows: { key: string; count: number }[] }).rows.map((r) => ({ key: r.key, count: Number(r.count) }));
  const totalObjections = objectionRows.reduce((s, r) => s + r.count, 0);
  if (totalObjections >= 3) {
    const labels = await db
      .select({ key: objections.key, label: objections.label })
      .from(objections)
      .where(eq(objections.businessId, businessId));
    const labelOf = (k: string) => labels.find((l) => l.key === k)?.label ?? k;
    const top = objectionRows[0];
    const rest = objectionRows.slice(1).map((r) => `“${labelOf(r.key)}” (${r.count})`);
    out.push({
      key: 'top_objection',
      tone: 'info',
      title: `La objeción más frecuente: “${labelOf(top.key)}”`,
      detail: `Ha aparecido ${top.count} ${top.count === 1 ? 'vez' : 'veces'}${rest.length ? `; le siguen ${rest.join(' y ')}` : ''}. Revisa cómo responde KAI y si tu web o tus anuncios pueden resolverla antes.`,
      action: { label: 'Editar objeciones', to: '/app/setter?tab=objeciones' },
    });
  }

  // 6. Eficacia de los seguimientos.
  const [fu] = await db
    .select({
      sent: sql<number>`count(*)::int`,
      revived: sql<number>`count(*) filter (where exists (select 1 from ${messages} m where m.conversation_id = ${followUps.conversationId} and m.direction = 'inbound' and m.created_at > ${followUps.sentAt}))::int`,
    })
    .from(followUps)
    .where(and(eq(followUps.businessId, businessId), eq(followUps.status, 'sent'), gte(followUps.sentAt, range.from), lt(followUps.sentAt, range.to)));
  if ((fu?.sent ?? 0) >= MIN_SAMPLE) {
    const rate = pct(fu.revived, fu.sent);
    out.push({
      key: 'followups',
      tone: rate >= 20 ? 'positive' : 'info',
      title: `Los seguimientos recuperan al ${rate}% de los leads`,
      detail: `${fu.revived} de ${fu.sent} seguimientos consiguieron que el lead volviera a responder.`,
      action: { label: 'Ajustar seguimientos', to: '/app/setter?tab=seguimientos' },
    });
  }

  return out;
}
