import { z } from 'zod';
import { isRemoteDatabaseUrl } from '../database/seed-safety.js';

/**
 * Configuración central de KAI.
 *
 * Todas las variables se leen del archivo `.env` (ver `.env.example` en la raíz de /kai).
 * Ninguna integración externa es obligatoria para arrancar: si falta una credencial,
 * el módulo correspondiente queda desactivado y la interfaz lo indica claramente.
 */
const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase())));

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() !== '' ? v.trim() : undefined));

/** Número entero positivo con valor por defecto (una variable vacía cuenta como no definida). */
const positiveInt = (def: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v.trim() === '' ? def : Number(v)))
    .pipe(z.number().int().min(1));

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().default(3000),
  HOST: z.string().default('0.0.0.0'),
  /**
   * Proxies de confianza delante de KAI (para saber la IP real de cada visitante).
   * Vacío = 1 en producción (Railway, Render, Caddy…) y ninguno en desarrollo.
   * Un número = cuántos proxies hay delante; también admite IPs/rangos separados por comas.
   */
  TRUST_PROXY: optionalString,

  /** URL pública donde se abre la aplicación (frontend). */
  APP_URL: z.string().url().default('http://localhost:5173'),
  /** URL pública del backend (para webhooks y callbacks OAuth). Por defecto = APP_URL. */
  API_URL: optionalString,

  /** Postgres en producción. Si se deja vacío se usa una base de datos local embebida (PGlite). */
  DATABASE_URL: optionalString,
  PGLITE_DIR: z.string().default('.data/pglite'),

  /** Clave de 32 bytes en base64 para cifrar tokens de integraciones. Obligatoria en producción. */
  ENCRYPTION_KEY: optionalString,

  // --- IA ---
  AI_PROVIDER: z.enum(['auto', 'anthropic', 'simulated']).default('auto'),
  ANTHROPIC_API_KEY: optionalString,
  AI_MODEL_MAIN: z.string().default('claude-opus-5-5'),
  AI_MODEL_FAST: z.string().default('claude-haiku-4-5'),
  AI_SETTER_EFFORT: z.enum(['low', 'medium', 'high']).default('low'),
  AI_COPILOT_EFFORT: z.enum(['low', 'medium', 'high']).default('medium'),
  AI_JUDGE_ENABLED: bool(true),
  AI_SERVER_FALLBACKS: bool(true),

  // --- Meta (WhatsApp Cloud API, Instagram Messaging, Lead Ads) ---
  META_APP_ID: optionalString,
  META_APP_SECRET: optionalString,
  META_VERIFY_TOKEN: optionalString,
  META_GRAPH_VERSION: z.string().default('v23.0'),

  // --- Google Calendar (OAuth) ---
  GOOGLE_CLIENT_ID: optionalString,
  GOOGLE_CLIENT_SECRET: optionalString,

  // --- Email (recuperación de contraseña, invitaciones) ---
  EMAIL_PROVIDER: z.enum(['console', 'resend']).default('console'),
  RESEND_API_KEY: optionalString,
  EMAIL_FROM: z.string().default('KAI <no-reply@example.com>'),

  // --- Automatizaciones ---
  RUN_WORKER: bool(true),
  WORKER_INTERVAL_MS: z.coerce.number().int().min(250).default(2000),
  CRON_SECRET: optionalString,

  // --- Administración del SaaS ---
  ADMIN_EMAIL: optionalString,
  ADMIN_PASSWORD: optionalString,
  /** Solo si se pide expresamente: convierte en administrador a una cuenta YA existente con ADMIN_EMAIL. */
  ADMIN_PROMOTE_EXISTING: bool(false),

  // --- Formularios públicos (anti-abuso) ---
  /** Leads nuevos que puede crear el formulario público de un negocio por hora y por día. */
  PUBLIC_FORM_MAX_PER_HOUR: positiveInt(30),
  PUBLIC_FORM_MAX_PER_DAY: positiveInt(200),

  // --- Pruebas de KAI (anti-abuso) ---
  /** Mensajes por minuto y negocio en el simulador y en la vista previa del Setter IA (cada uno gasta IA). */
  SIMULATOR_MAX_PER_MINUTE: positiveInt(20),

  // --- Frontend ---
  SERVE_FRONTEND: bool(false),
  FRONTEND_DIST: z.string().default('../frontend/dist'),

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

export type Env = z.infer<typeof EnvSchema>;

/**
 * ¿Es la configuración de un servidor público? APP_URL con https y un dominio que no es este ordenador,
 * o una base de datos que no está en este ordenador (ni en el docker-compose local).
 */
export function looksLikePublicServer(appUrl: string | undefined, databaseUrl: string | undefined): boolean {
  if (isRemoteDatabaseUrl(databaseUrl?.trim() || undefined)) return true;
  try {
    const url = new URL(appUrl?.trim() ?? '');
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    return url.protocol === 'https:' && !['localhost', '127.0.0.1', '::1', '0.0.0.0'].includes(host) && !host.endsWith('.localhost');
  } catch {
    return false;
  }
}

/**
 * NODE_ENV sin definir en un servidor público: se trata como producción. .env.example lo deja comentado (con Docker
 * lo fija la imagen) y con «npm start» es fácil olvidarlo; sin esto, el olvido desactivaría a la vez todas las
 * protecciones de producción: conectar canales sin verificarlos con Meta, la clave de cifrado de desarrollo (pública),
 * avisos de Meta sin firma, emails con enlaces de acceso en los registros… Para desarrollar de verdad contra una
 * base de datos remota o un dominio https, basta con poner NODE_ENV=development.
 */
export function inferredProduction(source: Record<string, string | undefined>): boolean {
  return !source.NODE_ENV?.trim() && looksLikePublicServer(source.APP_URL, source.DATABASE_URL);
}

const INFERRED_PRODUCTION_NOTE =
  'NODE_ENV no está definido, pero APP_URL usa https con un dominio público o DATABASE_URL apunta a otro servidor, así que KAI arranca en modo producción. Si de verdad es un entorno de pruebas, pon NODE_ENV=development en el .env.';

let productionWasInferred = false;

function loadEnv(): Env {
  const source = { ...process.env };
  if (inferredProduction(source)) {
    source.NODE_ENV = 'production';
    // Para que todo el proceso (y cualquier librería) vea el mismo modo.
    process.env.NODE_ENV = 'production';
    productionWasInferred = true;
  }
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const details = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Configuración inválida en .env:\n${details}`);
  }
  const env = parsed.data;
  if (env.NODE_ENV === 'production') {
    const why = productionWasInferred ? ` ${INFERRED_PRODUCTION_NOTE}` : '';
    if (!env.ENCRYPTION_KEY) throw new Error(`ENCRYPTION_KEY es obligatoria en producción (32 bytes en base64).${why}`);
    if (!env.DATABASE_URL) throw new Error(`DATABASE_URL es obligatoria en producción (PostgreSQL).${why}`);
  }
  return env;
}

export const env: Env = loadEnv();

export const publicApiUrl = () => (env.API_URL ?? env.APP_URL).replace(/\/$/, '');
export const publicAppUrl = () => env.APP_URL.replace(/\/$/, '');
export const isProduction = () => env.NODE_ENV === 'production';
export const isTest = () => env.NODE_ENV === 'test';

/** Proxies en redes privadas (Railway, Render, Docker, Caddy en la misma máquina…). */
export const PRIVATE_PROXIES = 'loopback,linklocal,uniquelocal,100.64.0.0/10';

export type TrustProxy = false | string | ((address: string, hop: number) => boolean);

/**
 * Valor de `trustProxy` para Fastify. Nunca `true`: confiar en cualquier X-Forwarded-For permitiría
 * falsificar la IP y saltarse los límites de peticiones. Opciones de TRUST_PROXY:
 *  - vacío: en producción, proxies de redes privadas (PRIVATE_PROXIES); en desarrollo, ninguno.
 *  - false/0: ninguno (KAI recibe las conexiones directamente).
 *  - true: igual que vacío en producción (proxies de redes privadas).
 *  - un número N: confiar en los N saltos más cercanos (solo si KAI no es accesible sin pasar por el proxy).
 *  - IPs o rangos separados por comas (p. ej. "10.0.0.0/8,173.245.48.0/20").
 */
export function trustProxySetting(value: string | undefined = env.TRUST_PROXY, production = isProduction()): TrustProxy {
  const v = value?.trim().toLowerCase();
  if (!v) return production ? PRIVATE_PROXIES : false;
  if (['false', 'no', 'off', '0'].includes(v)) return false;
  if (['true', 'yes', 'on'].includes(v)) return PRIVATE_PROXIES;
  if (/^\d+$/.test(v)) {
    const hops = Number(v);
    return (_address: string, hop: number) => hop < hops;
  }
  return value!.trim();
}

/** El envío real de emails está configurado (Resend con su clave). */
export const emailConfigured = () => env.EMAIL_PROVIDER === 'resend' && Boolean(env.RESEND_API_KEY);

/** Motivo por el que ADMIN_PASSWORD no vale para la cuenta más privilegiada (null si es válida). */
export function adminPasswordProblem(password: string | undefined): string | null {
  if (!password) return null;
  if (password.length < 12 || password.length > 200 || !/[a-zA-Z]/.test(password) || !/[0-9]/.test(password))
    return 'ADMIN_PASSWORD es demasiado débil: usa al menos 12 caracteres combinando letras y números. La cuenta de administración no se crea hasta que la cambies.';
  return null;
}

/** Avisos de configuración que conviene mostrar al arrancar (no impiden el arranque). */
export function startupWarnings(): string[] {
  const out: string[] = [];
  if (productionWasInferred) out.push(`${INFERRED_PRODUCTION_NOTE} Añade NODE_ENV=production al .env para que quede explícito.`);
  const adminProblem = env.ADMIN_EMAIL ? adminPasswordProblem(env.ADMIN_PASSWORD) : null;
  if (adminProblem) out.push(adminProblem);
  if (isProduction() && !emailConfigured())
    out.push('Email sin configurar (EMAIL_PROVIDER=resend y RESEND_API_KEY): no se enviarán emails de recuperación de contraseña ni invitaciones.');
  return out;
}

/** Estado de cada integración, para mostrar en la interfaz qué está configurado. */
export function integrationAvailability() {
  return {
    ai: resolveAiMode(),
    meta: Boolean(env.META_APP_SECRET && env.META_VERIFY_TOKEN),
    google: Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET),
    email: emailConfigured(),
  };
}

export function resolveAiMode(): 'anthropic' | 'simulated' {
  if (env.AI_PROVIDER === 'simulated') return 'simulated';
  if (env.AI_PROVIDER === 'anthropic') return 'anthropic';
  return env.ANTHROPIC_API_KEY ? 'anthropic' : 'simulated';
}
