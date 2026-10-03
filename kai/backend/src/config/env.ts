import { z } from 'zod';

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

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().default(3000),
  HOST: z.string().default('0.0.0.0'),

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

  // --- Frontend ---
  SERVE_FRONTEND: bool(false),
  FRONTEND_DIST: z.string().default('../frontend/dist'),

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

export type Env = z.infer<typeof EnvSchema>;

function loadEnv(): Env {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const details = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Configuración inválida en .env:\n${details}`);
  }
  const env = parsed.data;
  if (env.NODE_ENV === 'production') {
    if (!env.ENCRYPTION_KEY) throw new Error('ENCRYPTION_KEY es obligatoria en producción (32 bytes en base64).');
    if (!env.DATABASE_URL) throw new Error('DATABASE_URL es obligatoria en producción (PostgreSQL).');
  }
  return env;
}

export const env: Env = loadEnv();

export const publicApiUrl = () => (env.API_URL ?? env.APP_URL).replace(/\/$/, '');
export const publicAppUrl = () => env.APP_URL.replace(/\/$/, '');
export const isProduction = () => env.NODE_ENV === 'production';
export const isTest = () => env.NODE_ENV === 'test';

/** Estado de cada integración, para mostrar en la interfaz qué está configurado. */
export function integrationAvailability() {
  return {
    ai: resolveAiMode(),
    meta: Boolean(env.META_APP_SECRET && env.META_VERIFY_TOKEN),
    google: Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET),
    email: env.EMAIL_PROVIDER === 'resend' ? Boolean(env.RESEND_API_KEY) : false,
  };
}

export function resolveAiMode(): 'anthropic' | 'simulated' {
  if (env.AI_PROVIDER === 'simulated') return 'simulated';
  if (env.AI_PROVIDER === 'anthropic') return 'anthropic';
  return env.ANTHROPIC_API_KEY ? 'anthropic' : 'simulated';
}
