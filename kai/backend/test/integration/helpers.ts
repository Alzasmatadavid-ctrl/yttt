/**
 * Utilidades para los tests de integración de la API.
 *
 * - Base de datos PGlite en memoria (cada archivo de test se ejecuta en su propio proceso,
 *   así que cada archivo tiene su propia base de datos limpia).
 * - La aplicación Fastify real (`buildApp`) probada con `app.inject()`: sin red ni puertos.
 * - Un cliente HTTP que conserva la cookie de sesión `kai_session` y añade la cabecera CSRF.
 * - Cada cliente usa su propia IP simulada para no chocar con los límites de peticiones por IP
 *   (registro/login: 10 por minuto; global: 300 por minuto).
 */
import { DateTime } from 'luxon';
import { eq } from 'drizzle-orm';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import { buildApp } from '../../src/app.js';
import { bootstrapData } from '../../src/database/bootstrap.js';
import { closeDatabase, getDb, initDatabase } from '../../src/database/client.js';
import { businesses, plans, users } from '../../src/database/schema.js';

export const SESSION_COOKIE = 'kai_session';
export const DEFAULT_PASSWORD = 'Kaizen12345';

/** Arranca base de datos en memoria + datos mínimos + aplicación lista para `inject`. */
export async function setupTestApp(): Promise<FastifyInstance> {
  await initDatabase({ memory: true });
  await bootstrapData();
  const app = await buildApp();
  await app.ready();
  return app;
}

export async function teardownTestApp(app: FastifyInstance | undefined) {
  if (app) await app.close();
  await closeDatabase();
}

let ipCounter = 0;
/** IP simulada distinta en cada llamada (10.x.y.z). */
export function nextIp(): string {
  ipCounter++;
  return `10.${(ipCounter >> 16) & 255}.${(ipCounter >> 8) & 255}.${ipCounter & 255}`;
}

let emailCounter = 0;
export function uniqueEmail(prefix = 'entrenador'): string {
  emailCounter++;
  return `${prefix}.${process.pid}.${emailCounter}.${Date.now()}@example.com`;
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface RequestOptions {
  payload?: unknown;
  headers?: Record<string, string>;
  /** false = no enviar la cabecera anti-CSRF `x-requested-with: kai`. */
  csrf?: boolean;
  query?: Record<string, string>;
}

/** Extrae el valor de `kai_session` de las cabeceras Set-Cookie (null si se borra, undefined si no aparece). */
export function sessionFromSetCookie(res: LightMyRequestResponse): string | null | undefined {
  const raw = res.headers['set-cookie'];
  if (!raw) return undefined;
  const list = Array.isArray(raw) ? raw : [String(raw)];
  for (const c of list) {
    const [pair, ...attrs] = c.split(';');
    const eqIdx = pair.indexOf('=');
    const name = pair.slice(0, eqIdx).trim();
    if (name !== SESSION_COOKIE) continue;
    const value = pair.slice(eqIdx + 1).trim();
    const expired = attrs.some((a) => {
      const [k, v] = a.split('=');
      if (k.trim().toLowerCase() === 'max-age') return Number(v) <= 0;
      if (k.trim().toLowerCase() === 'expires') return Date.parse(v) <= Date.now();
      return false;
    });
    return value && !expired ? value : null;
  }
  return undefined;
}

/**
 * Cliente de la API para un “navegador”: guarda la cookie de sesión entre peticiones
 * y envía siempre `x-requested-with: kai` (salvo que se pida lo contrario).
 */
export class ApiClient {
  session: string | null = null;

  constructor(
    readonly app: FastifyInstance,
    readonly ip: string = nextIp(),
  ) {}

  async request(method: Method, url: string, opts: RequestOptions = {}): Promise<LightMyRequestResponse> {
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    if (opts.csrf !== false) headers['x-requested-with'] = 'kai';
    if (this.session) headers.cookie = `${SESSION_COOKIE}=${this.session}`;
    const inject: InjectOptions = { method, url, headers, remoteAddress: this.ip, query: opts.query };
    if (opts.payload !== undefined) inject.payload = opts.payload as InjectOptions['payload'];
    const res = await this.app.inject(inject);
    const cookie = sessionFromSetCookie(res);
    if (cookie !== undefined) this.session = cookie;
    return res;
  }

  get(url: string, opts?: RequestOptions) {
    return this.request('GET', url, opts);
  }
  post(url: string, payload?: unknown, opts: RequestOptions = {}) {
    return this.request('POST', url, { ...opts, payload: payload ?? {} });
  }
  put(url: string, payload?: unknown, opts: RequestOptions = {}) {
    return this.request('PUT', url, { ...opts, payload: payload ?? {} });
  }
  patch(url: string, payload?: unknown, opts: RequestOptions = {}) {
    return this.request('PATCH', url, { ...opts, payload: payload ?? {} });
  }
  delete(url: string, opts?: RequestOptions) {
    return this.request('DELETE', url, opts);
  }

  /** Copia del cliente con otra IP pero la misma sesión (útil para esquivar límites por IP). */
  withNewIp(): ApiClient {
    const c = new ApiClient(this.app);
    c.session = this.session;
    return c;
  }
}

export interface Trainer {
  client: ApiClient;
  businessId: string;
  userId: string;
  email: string;
  password: string;
  name: string;
  businessName: string;
}

/** Registra un entrenador nuevo (POST /api/auth/register) con una IP propia y devuelve su sesión. */
export async function registerTrainer(
  app: FastifyInstance,
  input: { email?: string; name?: string; businessName?: string; password?: string; timezone?: string } = {},
): Promise<Trainer> {
  const client = new ApiClient(app);
  const email = input.email ?? uniqueEmail();
  const password = input.password ?? DEFAULT_PASSWORD;
  const name = input.name ?? 'Laura Gómez';
  const businessName = input.businessName ?? `Negocio ${email.split('@')[0]}`;
  const res = await client.post('/api/auth/register', { name, email, password, businessName, ...(input.timezone ? { timezone: input.timezone } : {}) });
  if (res.statusCode !== 200) throw new Error(`Registro fallido (${res.statusCode}): ${res.body}`);
  const businessId = (res.json() as { businessId: string }).businessId;
  const [user] = await getDb().select({ id: users.id }).from(users).where(eq(users.email, email.toLowerCase())).limit(1);
  return { client, businessId, userId: user.id, email: email.toLowerCase(), password, name, businessName };
}

/** Cambia el plan de un negocio directamente en la base de datos (starter | pro | agency). */
export async function setPlan(businessId: string, key: 'starter' | 'pro' | 'agency') {
  const [plan] = await getDb().select().from(plans).where(eq(plans.key, key)).limit(1);
  await getDb().update(businesses).set({ planId: plan.id }).where(eq(businesses.id, businessId));
}

/** Convierte a un usuario en administrador de la plataforma (platformRole = 'admin'). */
export async function makePlatformAdmin(userId: string) {
  await getDb().update(users).set({ platformRole: 'admin' }).where(eq(users.id, userId));
}

/** Disponibilidad “siempre abierta”: todos los días de 00:00 a 24:00, sin antelación mínima. */
export const ALWAYS_OPEN_AVAILABILITY = {
  weekly: Object.fromEntries(['1', '2', '3', '4', '5', '6', '7'].map((d) => [d, [{ start: '00:00', end: '24:00' }]])),
  slotMinutes: 30,
  bufferMinutes: 0,
  minNoticeMinutes: 0,
  maxDaysAhead: 14,
  blackoutDates: [] as string[],
};

export async function openAgenda(client: ApiClient) {
  const res = await client.put('/api/agenda/availability', ALWAYS_OPEN_AVAILABILITY);
  if (res.statusCode !== 200) throw new Error(`No se pudo guardar la disponibilidad (${res.statusCode}): ${res.body}`);
}

/** Rango amplio para GET /api/agenda/appointments. */
export function wideRange() {
  return { from: new Date(Date.now() - 2 * 86_400_000).toISOString(), to: new Date(Date.now() + 30 * 86_400_000).toISOString() };
}

/** Siguiente fecha (en Madrid) a una hora concreta, al menos mañana: evita solapes con “ahora”. */
export function futureLocal(daysAhead: number, hour: number, minute = 0, tz = 'Europe/Madrid'): Date {
  return DateTime.now().setZone(tz).plus({ days: daysAhead }).set({ hour, minute, second: 0, millisecond: 0 }).toJSDate();
}

/** Número de signos de interrogación de cierre en un texto. */
export const questionCount = (text: string) => (text.match(/\?/g) ?? []).length;

export const json = <T = Record<string, any>>(res: LightMyRequestResponse) => res.json() as T; // eslint-disable-line @typescript-eslint/no-explicit-any
