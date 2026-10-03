import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parse } from '../lib/http.js';
import { audit } from '../audit/audit.service.js';
import { forbidden } from '../lib/errors.js';
import {
  acceptInvitation,
  authenticate,
  changePassword,
  getInvitation,
  listUserBusinesses,
  registerTrainer,
  requestPasswordReset,
  resetPassword,
} from './auth.service.js';
import { createSession, destroySession, SESSION_COOKIE, sessionCookieOptions, setActiveBusiness } from './sessions.js';
import { requireUser } from './guards.js';

const email = z.string().trim().email('Email no válido').max(200);
const password = z.string().min(1, 'Introduce la contraseña').max(200);

export async function authRoutes(app: FastifyInstance) {
  const authLimit = { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } };

  app.post('/register', authLimit, async (request, reply) => {
    const body = parse(
      z.object({
        name: z.string().trim().min(2, 'Indica tu nombre').max(120),
        email,
        password: z.string().max(200),
        businessName: z.string().trim().min(2, 'Indica el nombre de tu negocio').max(120),
        timezone: z.string().max(64).optional(),
      }),
      request.body,
    );
    const { user, business } = await registerTrainer(body);
    const session = await createSession(user.id, business.id, { ip: request.ip, userAgent: request.headers['user-agent'] });
    reply.setCookie(SESSION_COOKIE, session.token, sessionCookieOptions());
    return { ok: true, businessId: business.id };
  });

  app.post('/login', authLimit, async (request, reply) => {
    const body = parse(z.object({ email, password }), request.body);
    const user = await authenticate(body.email, body.password);
    const businesses = await listUserBusinesses(user.id);
    const session = await createSession(user.id, businesses[0]?.businessId ?? null, {
      ip: request.ip,
      userAgent: request.headers['user-agent'],
    });
    reply.setCookie(SESSION_COOKIE, session.token, sessionCookieOptions());
    await audit({ actorType: 'user', actorUserId: user.id, action: 'auth.login', ip: request.ip });
    return { ok: true };
  });

  app.post('/logout', async (request, reply) => {
    if (request.sessionToken) await destroySession(request.sessionToken);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/me', async (request) => {
    if (!request.authUser) return { user: null, businesses: [], activeBusinessId: null };
    const businesses = await listUserBusinesses(request.authUser.id);
    const active = businesses.find((b) => b.businessId === request.activeBusinessId) ?? businesses[0] ?? null;
    return { user: request.authUser, businesses, activeBusinessId: active?.businessId ?? null };
  });

  app.post('/switch-business', async (request) => {
    const user = requireUser(request);
    const { businessId } = parse(z.object({ businessId: z.string().uuid() }), request.body);
    const businesses = await listUserBusinesses(user.id);
    if (!businesses.some((b) => b.businessId === businessId)) throw forbidden('No tienes acceso a ese negocio.');
    await setActiveBusiness(request.sessionToken!, businessId);
    return { ok: true };
  });

  app.post('/forgot-password', authLimit, async (request) => {
    const body = parse(z.object({ email }), request.body);
    await requestPasswordReset(body.email);
    return { ok: true, message: 'Si existe una cuenta con ese email, te hemos enviado un enlace para restablecer la contraseña.' };
  });

  app.post('/reset-password', authLimit, async (request) => {
    const body = parse(z.object({ token: z.string().min(10).max(200), password: z.string().max(200) }), request.body);
    await resetPassword(body.token, body.password);
    return { ok: true };
  });

  app.post('/change-password', authLimit, async (request) => {
    const user = requireUser(request);
    const body = parse(z.object({ currentPassword: password, newPassword: z.string().max(200) }), request.body);
    await changePassword(user.id, body.currentPassword, body.newPassword, request.sessionToken ?? undefined);
    return { ok: true };
  });

  app.get('/invitation', async (request) => {
    const { token } = parse(z.object({ token: z.string().min(10).max(200) }), request.query);
    const inv = await getInvitation(token);
    return { email: inv.invitation.email, role: inv.invitation.role, businessName: inv.businessName, userExists: inv.userExists };
  });

  app.post('/accept-invitation', authLimit, async (request, reply) => {
    const body = parse(
      z.object({
        token: z.string().min(10).max(200),
        name: z.string().trim().min(2).max(120).optional(),
        password: z.string().max(200).optional(),
      }),
      request.body,
    );
    const { user, businessId } = await acceptInvitation(body.token, { ...body, currentUserId: request.authUser?.id });
    const session = await createSession(user.id, businessId, { ip: request.ip, userAgent: request.headers['user-agent'] });
    reply.setCookie(SESSION_COOKIE, session.token, sessionCookieOptions());
    return { ok: true, businessId };
  });
}
