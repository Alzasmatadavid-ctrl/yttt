/**
 * Límites de plan que afectan a la interfaz (negocios adicionales, analítica avanzada)
 * y recomendaciones “Lo que KAI ha aprendido” calculadas con datos reales.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { buildApp } from '../../src/app.js';
import { bootstrapData } from '../../src/database/bootstrap.js';
import { closeDatabase, getDb, initDatabase } from '../../src/database/client.js';
import { appointments, businesses, conversations, leads, plans } from '../../src/database/schema.js';
import { getAnalytics } from '../../src/analytics/analytics.service.js';

let app: FastifyInstance;

async function register(email: string, businessName: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    headers: { 'x-requested-with': 'kai' },
    payload: { name: 'Entrenador Test', email, password: 'Kaizen12345', businessName },
  });
  expect(res.statusCode).toBe(200);
  const cookie = String(res.headers['set-cookie']).split(';')[0];
  return { cookie, businessId: (res.json() as { businessId: string }).businessId };
}

const req = (cookie: string) => ({
  get: (url: string) => app.inject({ method: 'GET', url, headers: { cookie } }),
  post: (url: string, payload: unknown) => app.inject({ method: 'POST', url, payload: payload as object, headers: { cookie, 'x-requested-with': 'kai' } }),
});

async function setPlan(businessId: string, key: string) {
  const [plan] = await getDb().select().from(plans).where(eq(plans.key, key)).limit(1);
  await getDb().update(businesses).set({ planId: plan.id }).where(eq(businesses.id, businessId));
}

beforeAll(async () => {
  await initDatabase({ memory: true });
  await bootstrapData();
  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await closeDatabase();
});

describe('negocios adicionales', () => {
  it('el plan Starter no permite crear un segundo negocio', async () => {
    const { cookie } = await register('starter@example.com', 'Negocio Starter');
    const me = await req(cookie).get('/api/auth/me');
    expect(me.json().businesses[0].maxBusinesses).toBe(1);
    const res = await req(cookie).post('/api/businesses', { name: 'Otro negocio' });
    expect(res.statusCode).toBe(402);
    expect(res.json().error).toBe('limit_reached');
  });

  it('el plan Agency crea el negocio con el mismo plan y lo deja activo', async () => {
    const { cookie, businessId } = await register('agency@example.com', 'Agencia Uno');
    await setPlan(businessId, 'agency');
    const res = await req(cookie).post('/api/businesses', { name: 'Agencia Dos', timezone: 'Europe/Madrid' });
    expect(res.statusCode).toBe(200);
    const newId = res.json().business.id as string;

    const me = (await req(cookie).get('/api/auth/me')).json();
    expect(me.businesses).toHaveLength(2);
    expect(me.activeBusinessId).toBe(newId);
    const created = me.businesses.find((b: { businessId: string }) => b.businessId === newId);
    expect(created.role).toBe('trainer');
    expect(created.onboardingCompletedAt).toBeNull();
    expect(created.planName).toBe('KAI Agency');

    const [original] = await getDb().select().from(businesses).where(eq(businesses.id, businessId));
    const [copy] = await getDb().select().from(businesses).where(eq(businesses.id, newId));
    expect(copy.planId).toBe(original.planId);
  });

  it('rechaza zonas horarias inválidas', async () => {
    const { cookie, businessId } = await register('tz@example.com', 'Negocio TZ');
    await setPlan(businessId, 'agency');
    const res = await req(cookie).post('/api/businesses', { name: 'Negocio raro', timezone: 'Marte/Olympus' });
    expect(res.statusCode).toBe(400);
  });
});

describe('analítica avanzada', () => {
  it('sin analítica avanzada: periodo personalizado bloqueado y sin recomendaciones', async () => {
    const { cookie } = await register('basic@example.com', 'Negocio Básico');
    const custom = await req(cookie).get('/api/analytics?period=custom&from=2026-01-01&to=2026-01-31');
    expect(custom.statusCode).toBe(402);
    const normal = await req(cookie).get('/api/analytics?period=30d');
    expect(normal.statusCode).toBe(200);
    expect(normal.json().insightsLocked).toBe(true);
    expect(normal.json().insights).toEqual([]);
    const dash = await req(cookie).get('/api/dashboard');
    expect(dash.json().insightsLocked).toBe(true);

    const copilot = await req(cookie).post('/api/copilot/ask', { question: '¿Qué puedo mejorar según mis datos?' });
    expect(copilot.statusCode).toBe(200);
    expect(JSON.stringify(copilot.json())).toContain('analítica avanzada');
  });

  it('con analítica avanzada: valida el rango personalizado', async () => {
    const { cookie, businessId } = await register('pro-range@example.com', 'Negocio Pro');
    await setPlan(businessId, 'pro');
    expect((await req(cookie).get('/api/analytics?period=custom&from=2026-03-01&to=2026-02-01')).statusCode).toBe(400);
    expect((await req(cookie).get('/api/analytics?period=custom&from=2024-01-01&to=2026-02-01')).statusCode).toBe(400);
    const ok = await req(cookie).get('/api/analytics?period=custom&from=2026-01-01&to=2026-01-31');
    expect(ok.statusCode).toBe(200);
    expect(ok.json().insightsLocked).toBe(false);
  });
});

describe('Lo que KAI ha aprendido', () => {
  it('no saca conclusiones sin datos suficientes', async () => {
    const { businessId } = await register('empty@example.com', 'Negocio Vacío');
    const a = await getAnalytics(businessId, '30d', undefined, { advanced: true });
    expect(a.insights).toEqual([]);
  });

  it('detecta el mejor origen, los no-shows y la objeción más frecuente con datos reales', async () => {
    const { businessId } = await register('insights@example.com', 'Negocio Datos');
    const db = getDb();
    const now = Date.now();
    const at = (hoursAgo: number) => new Date(now - hoursAgo * 3_600_000);

    // 6 leads de Instagram (5 cualificados) y 6 de anuncios (1 cualificado).
    const rows = [
      ...Array.from({ length: 6 }, (_, i) => ({ source: 'instagram' as const, qualified: i < 5 })),
      ...Array.from({ length: 6 }, (_, i) => ({ source: 'meta_ads' as const, qualified: i < 1 })),
    ];
    const inserted = await db
      .insert(leads)
      .values(
        rows.map((r, i) => ({
          businessId,
          name: `Lead ${i}`,
          source: r.source,
          status: r.qualified ? ('qualified' as const) : ('conversing' as const),
          qualifiedAt: r.qualified ? at(10) : null,
          lastOutboundAt: at(20),
          lastInboundAt: at(19),
          createdAt: at(24),
        })),
      )
      .returning();

    // 4 llamadas: 2 realizadas y 2 no-shows (50 %).
    await db.insert(appointments).values(
      inserted.slice(0, 4).map((l, i) => ({
        businessId,
        leadId: l.id,
        title: 'Llamada',
        startsAt: at(5),
        endsAt: at(4.5),
        status: i < 2 ? ('completed' as const) : ('no_show' as const),
      })),
    );

    // Objeciones tratadas en conversaciones.
    await db.insert(conversations).values([
      { businessId, leadId: inserted[0].id, channel: 'web', state: { objectionsHandled: ['think_about_it', 'expensive'] } },
      { businessId, leadId: inserted[1].id, channel: 'web', state: { objectionsHandled: ['think_about_it'] } },
      { businessId, leadId: inserted[2].id, channel: 'web', state: { objectionsHandled: ['think_about_it'] } },
    ]);

    const a = await getAnalytics(businessId, '30d', undefined, { advanced: true });
    const keys = a.insights.map((i) => i.key);
    expect(keys).toContain('best_source');
    expect(a.insights.find((i) => i.key === 'best_source')?.title).toContain('Instagram');
    expect(keys).toContain('no_shows');
    expect(a.insights.find((i) => i.key === 'no_shows')?.title).toContain('50%');
    const objection = a.insights.find((i) => i.key === 'top_objection');
    expect(objection).toBeTruthy();
    expect(objection?.detail).toContain('3 veces');
    // Todas las acciones apuntan a pantallas que existen.
    for (const i of a.insights) if (i.action) expect(i.action.to).toMatch(/^\/app\//);
  });
});
