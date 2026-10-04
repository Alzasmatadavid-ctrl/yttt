import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { env, isProduction, isTest, trustProxySetting, type TrustProxy } from './config/env.js';
import { AppError } from './lib/errors.js';
import { redactUrl } from './lib/http.js';
import { safeEqual } from './lib/crypto.js';
import { logError } from './audit/audit.service.js';
import { identify } from './auth/guards.js';
import { authRoutes } from './auth/auth.routes.js';
import { crmRoutes } from './crm/crm.routes.js';
import { simulatorRoutes } from './crm/simulator.routes.js';
import { calendarRoutes } from './calendar/calendar.routes.js';
import { integrationsRoutes } from './integrations/integrations.routes.js';
import { webhookRoutes } from './webhooks/webhooks.routes.js';
import { settingsRoutes } from './settings/settings.routes.js';
import { analyticsRoutes } from './analytics/analytics.routes.js';
import { copilotRoutes } from './ai/copilot/copilot.routes.js';
import { businessRoutes } from './business/business.routes.js';
import { adminRoutes } from './admin/admin.routes.js';
import { runDueJobs } from './automation/worker.js';
import { aiModeInfo } from './ai/providers/index.js';

/** Rutas que reciben peticiones de terceros (no del navegador del entrenador): sin comprobación CSRF. */
const CSRF_EXEMPT = [/^\/api\/webhooks\//, /^\/api\/public\//, /^\/api\/internal\//];

export async function buildApp(opts: { logger?: boolean; trustProxy?: TrustProxy } = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger
      ? {
          level: env.LOG_LEVEL,
          redact: ['req.headers.cookie', 'req.headers.authorization', 'req.headers["x-kai-key"]', 'req.headers["x-kai-signature"]'],
          // Las URLs se registran sin tokens (enlaces de invitación, callbacks OAuth…).
          serializers: {
            req: (req: { method: string; url: string; hostname?: string; ip?: string }) => ({
              method: req.method,
              url: redactUrl(req.url),
              hostname: req.hostname,
              remoteAddress: req.ip,
            }),
          },
        }
      : false,
    // IP real del visitante solo a través de proxies de confianza (ver TRUST_PROXY en .env.example):
    // nunca `true`, que permitiría falsificarla con X-Forwarded-For y saltarse los límites de peticiones.
    trustProxy: opts.trustProxy ?? trustProxySetting(),
    bodyLimit: 1_000_000,
  });

  // JSON conservando el cuerpo original (necesario para verificar firmas de webhooks).
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (request, body, done) => {
    const raw = typeof body === 'string' ? body : body.toString('utf8');
    request.rawBody = raw;
    if (!raw.trim()) return done(null, {});
    try {
      done(null, JSON.parse(raw));
    } catch {
      const err = new AppError(400, 'invalid_json', 'El cuerpo de la petición no es un JSON válido.');
      done(err as unknown as FastifyError, undefined);
    }
  });

  await app.register(cookie);
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        imgSrc: ["'self'", 'data:', 'https:'],
        styleSrc: ["'self'", "'unsafe-inline'"],
        fontSrc: ["'self'", 'data:'],
        scriptSrc: ["'self'"],
        connectSrc: ["'self'"],
        frameAncestors: ["'none'"],
        formAction: ["'self'"],
        objectSrc: ["'none'"],
      },
    },
    crossOriginEmbedderPolicy: false,
  });
  await app.register(rateLimit, {
    global: true,
    max: 300,
    timeWindow: '1 minute',
    errorResponseBuilder: () => ({ statusCode: 429, error: 'rate_limited', message: 'Demasiadas solicitudes. Espera un momento e inténtalo de nuevo.' }),
  });

  app.decorateRequest('authUser', null);
  app.decorateRequest('sessionToken', null);
  app.decorateRequest('activeBusinessId', null);
  app.decorateRequest('tenant', null);

  app.addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith('/api/')) return;
    // Protección CSRF: el frontend envía siempre esta cabecera; un formulario de otra web no puede.
    const isWrite = !['GET', 'HEAD', 'OPTIONS'].includes(request.method);
    if (isWrite && !CSRF_EXEMPT.some((rx) => rx.test(request.url)) && request.headers['x-requested-with'] !== 'kai') {
      return reply.code(403).send({ error: 'csrf', message: 'Petición no permitida.' });
    }
    await identify(request);
  });

  app.setErrorHandler(async (error: FastifyError | AppError, request, reply) => {
    if (error instanceof AppError) {
      return reply.code(error.statusCode).send({ error: error.code, message: error.message, details: error.details });
    }
    const status = (error as FastifyError).statusCode ?? 500;
    if (status === 429) return reply.code(429).send({ error: 'rate_limited', message: 'Demasiadas solicitudes. Espera un momento e inténtalo de nuevo.' });
    if (status >= 400 && status < 500) {
      const message = status === 413 ? 'El contenido enviado es demasiado grande.' : status === 415 ? 'Formato de contenido no admitido.' : 'Petición no válida.';
      return reply.code(status).send({ error: 'bad_request', message });
    }
    await logError('http', error, { url: request.url, method: request.method }, request.tenant?.businessId ?? null);
    return reply.code(500).send({ error: 'internal', message: 'Ha ocurrido un error inesperado. Ya lo hemos registrado.' });
  });

  await app.register(
    async (api) => {
      api.get('/health', async () => ({ ok: true, ai: aiModeInfo().mode, time: new Date().toISOString() }));

      // Ejecución de la cola desde un cron externo (Railway/Render/Vercel Cron…).
      api.post('/internal/cron', async (request, reply) => {
        const header = request.headers.authorization ?? '';
        if (!env.CRON_SECRET || !safeEqual(header, `Bearer ${env.CRON_SECRET}`)) return reply.code(401).send({ error: 'unauthorized' });
        let total = 0;
        for (let i = 0; i < 5; i++) {
          const n = await runDueJobs(20);
          total += n;
          if (n < 20) break;
        }
        return { ok: true, processed: total };
      });

      await api.register(authRoutes, { prefix: '/auth' });
      await api.register(crmRoutes);
      await api.register(simulatorRoutes);
      await api.register(calendarRoutes);
      await api.register(integrationsRoutes);
      await api.register(webhookRoutes);
      await api.register(settingsRoutes);
      await api.register(analyticsRoutes);
      await api.register(copilotRoutes);
      await api.register(adminRoutes);
      await api.register(businessRoutes);
    },
    { prefix: '/api' },
  );

  // Producción: el mismo servidor sirve la aplicación web (un solo despliegue).
  const dist = path.resolve(process.cwd(), env.FRONTEND_DIST);
  if (env.SERVE_FRONTEND && existsSync(path.join(dist, 'index.html'))) {
    await app.register(fastifyStatic, { root: dist, wildcard: false, maxAge: isProduction() ? '1h' : 0 });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/')) return reply.code(404).send({ error: 'not_found', message: 'Ruta no encontrada.' });
      return reply.type('text/html').sendFile('index.html', { maxAge: 0 });
    });
  } else {
    app.setNotFoundHandler((_request, reply) => reply.code(404).send({ error: 'not_found', message: 'Ruta no encontrada.' }));
  }

  if (!isTest()) app.log.info({ ai: aiModeInfo() }, 'KAI API lista');
  return app;
}
