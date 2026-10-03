/**
 * Autenticación: registro, sesión, login, logout, CSRF, recuperación de contraseña,
 * invitaciones de equipo y cambio de negocio activo.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { consoleEmail } from '../../src/integrations/email/email.service.js';
import { ApiClient, DEFAULT_PASSWORD, registerTrainer, setPlan, setupTestApp, teardownTestApp, uniqueEmail } from './helpers.js';

let app: FastifyInstance;

beforeAll(async () => {
  app = await setupTestApp();
});

afterAll(async () => {
  await teardownTestApp(app);
});

/** Último email enviado a una dirección (proveedor de consola en tests). */
function lastEmailTo(to: string) {
  return [...consoleEmail.outbox].reverse().find((m) => m.to === to.toLowerCase()) ?? null;
}

/** Extrae el token del enlace (`?token=...`) incluido en un email. */
function tokenFromEmail(text: string): string {
  const m = /[?&]token=([^\s&]+)/.exec(text);
  if (!m) throw new Error(`El email no contiene ningún enlace con token:\n${text}`);
  return decodeURIComponent(m[1]);
}

describe('registro y sesión', () => {
  it('registra un entrenador, crea su negocio y deja la sesión iniciada', async () => {
    const email = uniqueEmail('registro');
    const client = new ApiClient(app);
    const res = await client.post('/api/auth/register', { name: 'Ana Martín', email, password: DEFAULT_PASSWORD, businessName: 'Ana Fit' });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
    const businessId = res.json().businessId as string;
    expect(businessId).toMatch(/^[0-9a-f-]{36}$/);
    expect(client.session).toBeTruthy();
    // La cookie de sesión es httpOnly y SameSite=Lax.
    const setCookie = String(res.headers['set-cookie']);
    expect(setCookie).toContain('kai_session=');
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Lax/i);

    const me = await client.get('/api/auth/me');
    expect(me.statusCode).toBe(200);
    const body = me.json();
    expect(body.user.email).toBe(email.toLowerCase());
    expect(body.user.name).toBe('Ana Martín');
    expect(body.user.platformRole).toBe('user');
    expect(body.activeBusinessId).toBe(businessId);
    expect(body.businesses).toHaveLength(1);
    expect(body.businesses[0]).toMatchObject({ businessId, name: 'Ana Fit', role: 'trainer', status: 'active' });
    // La respuesta nunca incluye el hash de la contraseña.
    expect(JSON.stringify(body)).not.toMatch(/scrypt|passwordHash/);
  });

  it('sin sesión, /auth/me responde sin usuario y las rutas privadas devuelven 401', async () => {
    const anon = new ApiClient(app);
    const me = await anon.get('/api/auth/me');
    expect(me.statusCode).toBe(200);
    expect(me.json()).toEqual({ user: null, businesses: [], activeBusinessId: null });
    expect((await anon.get('/api/leads')).statusCode).toBe(401);
    expect((await anon.get('/api/dashboard')).statusCode).toBe(401);
  });

  it('una cookie de sesión inventada no da acceso', async () => {
    const fake = new ApiClient(app);
    fake.session = 'x'.repeat(43);
    expect((await fake.get('/api/leads')).statusCode).toBe(401);
  });

  it('no permite registrar dos veces el mismo email (409), aunque cambien las mayúsculas', async () => {
    const t = await registerTrainer(app);
    const res = await new ApiClient(app).post('/api/auth/register', { name: 'Otra Persona', email: t.email.toUpperCase(), password: DEFAULT_PASSWORD, businessName: 'Otro negocio' });
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toMatch(/ya existe/i);
  });

  it.each([
    ['demasiado corta', 'Abc12345'],
    ['sin números', 'SoloLetrasLargas'],
    ['sin letras', '12345678901'],
  ])('rechaza una contraseña débil (%s) con 400 y un mensaje claro', async (_label, password) => {
    const client = new ApiClient(app);
    const res = await client.post('/api/auth/register', { name: 'Débil', email: uniqueEmail('debil'), password, businessName: 'Negocio Débil' });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/contraseña/i);
    expect(client.session).toBeNull();
  });

  it('valida los datos del registro (email no válido → 400 en español)', async () => {
    const res = await new ApiClient(app).post('/api/auth/register', { name: 'X Y', email: 'no-es-un-email', password: DEFAULT_PASSWORD, businessName: 'Negocio' });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/email/i);
  });
});

describe('login y logout', () => {
  it('login correcto crea sesión; contraseña incorrecta o email desconocido → 401 con el mismo mensaje', async () => {
    const t = await registerTrainer(app);
    const client = new ApiClient(app);

    const wrong = await client.post('/api/auth/login', { email: t.email, password: 'Incorrecta123' });
    expect(wrong.statusCode).toBe(401);
    expect(client.session).toBeNull();
    const unknown = await client.post('/api/auth/login', { email: uniqueEmail('nadie'), password: 'Incorrecta123' });
    expect(unknown.statusCode).toBe(401);
    // Mismo mensaje en ambos casos: no se puede averiguar si una cuenta existe.
    expect(unknown.json().message).toBe(wrong.json().message);

    const ok = await client.post('/api/auth/login', { email: `  ${t.email.toUpperCase()} `, password: t.password });
    expect(ok.statusCode).toBe(200);
    expect(client.session).toBeTruthy();
    const me = (await client.get('/api/auth/me')).json();
    expect(me.user.email).toBe(t.email);
    expect(me.activeBusinessId).toBe(t.businessId);
  });

  it('logout borra la cookie e invalida la sesión en el servidor', async () => {
    const t = await registerTrainer(app);
    const oldSession = t.client.session;
    const res = await t.client.post('/api/auth/logout');
    expect(res.statusCode).toBe(200);
    expect(t.client.session).toBeNull();
    expect((await t.client.get('/api/auth/me')).json().user).toBeNull();

    // Aunque alguien conserve la cookie antigua, ya no sirve.
    const replay = new ApiClient(app);
    replay.session = oldSession;
    expect((await replay.get('/api/auth/me')).json().user).toBeNull();
    expect((await replay.get('/api/leads')).statusCode).toBe(401);
  });
});

describe('protección CSRF', () => {
  it('las escrituras sin la cabecera x-requested-with se rechazan con 403', async () => {
    const t = await registerTrainer(app);
    const noHeader = await t.client.post('/api/leads', { name: 'Lead CSRF' }, { csrf: false });
    expect(noHeader.statusCode).toBe(403);
    expect(noHeader.json().error).toBe('csrf');

    // Una cabecera con otro valor tampoco sirve.
    const wrongValue = await t.client.post('/api/leads', { name: 'Lead CSRF' }, { csrf: false, headers: { 'x-requested-with': 'XMLHttpRequest' } });
    expect(wrongValue.statusCode).toBe(403);

    // El login y el registro también están protegidos.
    expect((await new ApiClient(app).post('/api/auth/login', { email: t.email, password: t.password }, { csrf: false })).statusCode).toBe(403);
    expect((await t.client.request('DELETE', `/api/leads/00000000-0000-4000-8000-000000000000`, { csrf: false })).statusCode).toBe(403);

    // No se creó nada.
    const leads = (await t.client.get('/api/leads')).json().leads as unknown[];
    expect(leads).toHaveLength(0);
    // Las lecturas no necesitan la cabecera.
    expect((await t.client.get('/api/leads', { csrf: false })).statusCode).toBe(200);
  });
});

describe('recuperación de contraseña', () => {
  it('envía un enlace por email, permite restablecer una sola vez y cierra las sesiones abiertas', async () => {
    const t = await registerTrainer(app);
    const anon = new ApiClient(app);
    const before = consoleEmail.outbox.length;

    const res = await anon.post('/api/auth/forgot-password', { email: t.email });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
    expect(consoleEmail.outbox.length).toBeGreaterThan(before);
    const mail = lastEmailTo(t.email);
    expect(mail).not.toBeNull();
    expect(mail!.subject).toMatch(/contraseña/i);
    expect(mail!.text).toContain('/restablecer?token=');
    const token = tokenFromEmail(mail!.text);

    // Una contraseña nueva débil se rechaza y el token sigue siendo válido.
    const weak = await anon.post('/api/auth/reset-password', { token, password: 'corta1' });
    expect(weak.statusCode).toBe(400);

    const newPassword = 'NuevaClave2026';
    const reset = await anon.post('/api/auth/reset-password', { token, password: newPassword });
    expect(reset.statusCode).toBe(200);

    // La sesión que tenía abierta el entrenador queda cerrada.
    expect((await t.client.get('/api/auth/me')).json().user).toBeNull();

    // La contraseña antigua ya no vale; la nueva sí.
    expect((await new ApiClient(app).post('/api/auth/login', { email: t.email, password: t.password })).statusCode).toBe(401);
    expect((await new ApiClient(app).post('/api/auth/login', { email: t.email, password: newPassword })).statusCode).toBe(200);

    // El token no sirve dos veces.
    const again = await anon.post('/api/auth/reset-password', { token, password: 'OtraClave20261' });
    expect(again.statusCode).toBe(400);
    expect(again.json().message).toMatch(/no es válido|caducado/i);
  });

  it('responde igual si el email no existe y no envía nada', async () => {
    const t = await registerTrainer(app);
    const anon = new ApiClient(app);
    const known = await anon.post('/api/auth/forgot-password', { email: t.email });
    const ghost = uniqueEmail('fantasma');
    const before = consoleEmail.outbox.length;
    const unknown = await anon.post('/api/auth/forgot-password', { email: ghost });
    expect(unknown.statusCode).toBe(200);
    expect(unknown.json()).toEqual(known.json());
    expect(consoleEmail.outbox.length).toBe(before);
    expect(lastEmailTo(ghost)).toBeNull();
  });

  it('un token inventado no sirve', async () => {
    const res = await new ApiClient(app).post('/api/auth/reset-password', { token: 'token-inventado-1234567890', password: 'NuevaClave2026' });
    expect(res.statusCode).toBe(400);
  });
});

describe('invitaciones de equipo', () => {
  it('el entrenador invita a una persona nueva, que acepta con su nombre y contraseña', async () => {
    const owner = await registerTrainer(app, { businessName: 'Estudio Equipo' });
    await setPlan(owner.businessId, 'pro'); // Starter solo permite 1 usuario.
    const guestEmail = uniqueEmail('invitada');

    const inv = await owner.client.post('/api/team/invite', { email: guestEmail, role: 'team_member' });
    expect(inv.statusCode).toBe(200);
    expect(inv.json().invitation).toMatchObject({ email: guestEmail.toLowerCase(), role: 'team_member' });
    const link = inv.json().link as string;
    expect(link).toContain('/invitacion?token=');
    // También se envía por email (proveedor de consola en tests).
    const mail = lastEmailTo(guestEmail);
    expect(mail?.text).toContain(link);
    const token = tokenFromEmail(link);

    // La invitación aparece como pendiente en el equipo.
    const team = (await owner.client.get('/api/team')).json();
    expect(team.invitations.map((i: { email: string }) => i.email)).toContain(guestEmail.toLowerCase());

    const guest = new ApiClient(app);
    const info = await guest.get(`/api/auth/invitation?token=${encodeURIComponent(token)}`);
    expect(info.statusCode).toBe(200);
    expect(info.json()).toMatchObject({ email: guestEmail.toLowerCase(), role: 'team_member', businessName: 'Estudio Equipo', userExists: false });

    // Sin nombre ni contraseña no se puede crear la cuenta.
    expect((await guest.post('/api/auth/accept-invitation', { token })).statusCode).toBe(400);

    const accept = await guest.post('/api/auth/accept-invitation', { token, name: 'Pablo Equipo', password: DEFAULT_PASSWORD });
    expect(accept.statusCode).toBe(200);
    expect(accept.json().businessId).toBe(owner.businessId);
    const me = (await guest.get('/api/auth/me')).json();
    expect(me.user.email).toBe(guestEmail.toLowerCase());
    expect(me.activeBusinessId).toBe(owner.businessId);
    expect(me.businesses).toHaveLength(1);
    expect(me.businesses[0]).toMatchObject({ businessId: owner.businessId, role: 'team_member' });

    // El enlace no se puede reutilizar.
    expect((await new ApiClient(app).post('/api/auth/accept-invitation', { token, name: 'Intruso', password: DEFAULT_PASSWORD })).statusCode).toBe(400);
    expect((await new ApiClient(app).get(`/api/auth/invitation?token=${encodeURIComponent(token)}`)).statusCode).toBe(400);

    const members = (await owner.client.get('/api/team')).json().members as { email: string; role: string }[];
    expect(members.find((m) => m.email === guestEmail.toLowerCase())?.role).toBe('team_member');
  });

  it('respeta el límite de usuarios del plan (Starter: solo el entrenador)', async () => {
    const owner = await registerTrainer(app);
    const res = await owner.client.post('/api/team/invite', { email: uniqueEmail('extra'), role: 'team_member' });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/plan/i);
  });

  it('una cuenta existente acepta la invitación con su sesión y puede cambiar de negocio', async () => {
    const owner = await registerTrainer(app, { businessName: 'Negocio Principal' });
    await setPlan(owner.businessId, 'pro');
    const other = await registerTrainer(app, { businessName: 'Negocio Propio' });
    // Un lead en cada negocio para comprobar qué datos se ven tras cambiar.
    expect((await owner.client.post('/api/leads', { name: 'Lead del principal' })).statusCode).toBe(200);
    expect((await other.client.post('/api/leads', { name: 'Lead propio' })).statusCode).toBe(200);

    const inv = await owner.client.post('/api/team/invite', { email: other.email, role: 'trainer' });
    expect(inv.statusCode).toBe(200);
    const token = tokenFromEmail(inv.json().link);
    const info = (await other.client.get(`/api/auth/invitation?token=${encodeURIComponent(token)}`)).json();
    expect(info.userExists).toBe(true);

    // Sin sesión ni contraseña de la cuenta invitada, no se puede aceptar.
    expect((await new ApiClient(app).post('/api/auth/accept-invitation', { token })).statusCode).toBe(401);
    expect((await new ApiClient(app).post('/api/auth/accept-invitation', { token, password: 'NoEsLaClave123' })).statusCode).toBe(401);

    const accept = await other.client.post('/api/auth/accept-invitation', { token });
    expect(accept.statusCode).toBe(200);

    let me = (await other.client.get('/api/auth/me')).json();
    expect(me.businesses.map((b: { businessId: string }) => b.businessId).sort()).toEqual([owner.businessId, other.businessId].sort());
    expect(me.activeBusinessId).toBe(owner.businessId);
    let names = ((await other.client.get('/api/leads')).json().leads as { name: string }[]).map((l) => l.name);
    expect(names).toEqual(['Lead del principal']);

    // Cambio de negocio: los datos visibles cambian con él.
    const sw = await other.client.post('/api/auth/switch-business', { businessId: other.businessId });
    expect(sw.statusCode).toBe(200);
    me = (await other.client.get('/api/auth/me')).json();
    expect(me.activeBusinessId).toBe(other.businessId);
    names = ((await other.client.get('/api/leads')).json().leads as { name: string }[]).map((l) => l.name);
    expect(names).toEqual(['Lead propio']);

    // No se puede cambiar a un negocio al que no se pertenece.
    const stranger = await registerTrainer(app);
    const forbidden = await other.client.post('/api/auth/switch-business', { businessId: stranger.businessId });
    expect(forbidden.statusCode).toBe(403);
    expect((await other.client.get('/api/auth/me')).json().activeBusinessId).toBe(other.businessId);
  });
});
