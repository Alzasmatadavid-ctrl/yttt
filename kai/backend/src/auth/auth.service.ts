import { and, eq, sql, gt, isNull } from 'drizzle-orm';
import { getDb, type Database } from '../database/client.js';
import { businesses, invitations, memberships, passwordResetTokens, plans, users } from '../database/schema.js';
import { publicAppUrl } from '../config/env.js';
import { hashPassword, randomToken, sha256, verifyPassword } from '../lib/crypto.js';
import { badRequest, conflict, forbidden, notFound, tooManyRequests, unauthorized } from '../lib/errors.js';
import { AttemptLimiter, minutesFromMs } from '../lib/throttle.js';
import { runInBackground } from '../lib/background.js';
import { createBusiness } from '../business/business.service.js';
import { sendEmail } from '../integrations/email/email.service.js';
import { audit } from '../audit/audit.service.js';
import { destroyUserSessions } from './sessions.js';
import { countSeats, getLimits } from '../plans/plans.service.js';
import type { BusinessRole } from '../lib/domain.js';

export const normalizeEmail = (email: string) => email.trim().toLowerCase();

const RESET_TTL_MS = 60 * 60_000; // 1 hora
const INVITE_TTL_MS = 7 * 24 * 3600_000; // 7 días

/**
 * Límites por cuenta (además del límite por IP de las rutas): frenan la fuerza bruta aunque
 * el atacante cambie de IP en cada intento.
 */
export const loginFailures = new AttemptLimiter({ max: 10, windowMs: 15 * 60_000 });
export const resetRequests = new AttemptLimiter({ max: 3, windowMs: 60 * 60_000 });
export const invitationFailures = new AttemptLimiter({ max: 10, windowMs: 15 * 60_000 });

export function validatePasswordStrength(password: string) {
  if (password.length < 10) throw badRequest('La contraseña debe tener al menos 10 caracteres.');
  if (password.length > 200) throw badRequest('La contraseña es demasiado larga.');
  if (!/[a-zA-Z]/.test(password) || !/[0-9]/.test(password))
    throw badRequest('La contraseña debe combinar letras y números.');
}

export async function registerTrainer(input: { name: string; email: string; password: string; businessName: string; timezone?: string }) {
  const db = getDb();
  const email = normalizeEmail(input.email);
  validatePasswordStrength(input.password);
  const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
  if (existing) throw conflict('Ya existe una cuenta con ese email.');

  // El registro público SIEMPRE crea cuentas normales: la de administración solo se crea al arrancar
  // (ver database/bootstrap.ts), aunque alguien se registre con el email de ADMIN_EMAIL.
  const [user] = await db
    .insert(users)
    .values({
      email,
      name: input.name.trim(),
      passwordHash: await hashPassword(input.password),
      platformRole: 'user',
    })
    .returning();

  const business = await createBusiness({
    name: input.businessName.trim(),
    ownerUserId: user.id,
    ownerName: input.name.trim(),
    timezone: input.timezone,
  });
  await audit({ businessId: business.id, actorType: 'user', actorUserId: user.id, action: 'auth.registered', entityType: 'user', entityId: user.id });
  return { user, business };
}

/**
 * Negocio propio para una cuenta que no pertenece a ninguno (p. ej. la quitaron del único equipo en el que estaba).
 * Se crea con el plan por defecto y su periodo de prueba, como en el registro. Si ya pertenece a alguno → 409:
 * los negocios adicionales se crean desde la app (POST /businesses), donde se aplica el límite del plan.
 */
export async function createOwnBusiness(userId: string, input: { name: string; timezone?: string }) {
  const business = await getDb().transaction(async (tx) => {
    // Bloquea la fila del usuario: dos clics seguidos no crean dos negocios.
    const [user] = await tx.select({ id: users.id, name: users.name }).from(users).where(eq(users.id, userId)).for('update');
    if (!user) throw notFound('Cuenta no encontrada.');
    const [membership] = await tx.select({ id: memberships.id }).from(memberships).where(eq(memberships.userId, userId)).limit(1);
    if (membership) throw conflict('Ya perteneces a un negocio.');
    return createBusiness({ name: input.name.trim(), ownerUserId: userId, ownerName: user.name, timezone: input.timezone }, tx as unknown as Database);
  });
  await audit({ businessId: business.id, actorType: 'user', actorUserId: userId, action: 'business.created', entityType: 'business', entityId: business.id, metadata: { selfService: true } });
  return business;
}

export async function authenticate(emailRaw: string, password: string) {
  const email = normalizeEmail(emailRaw);
  // Se cuenta por email exista o no la cuenta: el bloqueo no revela qué emails están registrados.
  const wait = loginFailures.retryAfterMs(email);
  if (wait > 0)
    throw tooManyRequests(
      `Demasiados intentos fallidos con este email. Espera ${minutesFromMs(wait)} min o restablece tu contraseña con «¿Has olvidado tu contraseña?».`,
    );
  const [user] = await getDb().select().from(users).where(eq(users.email, email)).limit(1);
  // Mismo coste de tiempo exista o no el usuario (evita enumerar cuentas).
  const ok = user ? await verifyPassword(password, user.passwordHash) : await verifyPassword(password, await dummyHash());
  if (!user || !ok) {
    loginFailures.hit(email);
    throw unauthorized('Email o contraseña incorrectos.');
  }
  if (!user.isActive) throw forbidden('Esta cuenta está desactivada. Contacta con soporte.');
  loginFailures.reset(email);
  await getDb().update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, user.id));
  return user;
}
let dummyHashPromise: Promise<string> | null = null;
const dummyHash = () => (dummyHashPromise ??= hashPassword(randomToken(16)));

export async function listUserBusinesses(userId: string) {
  return getDb()
    .select({
      businessId: businesses.id,
      name: businesses.name,
      role: memberships.role,
      status: businesses.status,
      onboardingCompletedAt: businesses.onboardingCompletedAt,
      planName: plans.name,
      /** Negocios que permite el plan (null = ilimitados). Sin plan asignado: 1. */
      maxBusinesses: sql<number | null>`case when ${plans.id} is null then 1 else (${plans.limits}->>'maxBusinesses')::int end`,
    })
    .from(memberships)
    .innerJoin(businesses, eq(businesses.id, memberships.businessId))
    .leftJoin(plans, eq(plans.id, businesses.planId))
    .where(eq(memberships.userId, userId))
    .orderBy(memberships.createdAt);
}

/**
 * Solicitud de “he olvidado mi contraseña”. La respuesta es idéntica (y tarda lo mismo) exista o no
 * la cuenta: el token, el email y la auditoría se hacen después de responder, en segundo plano.
 */
export async function requestPasswordReset(emailRaw: string) {
  const db = getDb();
  const email = normalizeEmail(emailRaw);
  const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  if (!user || !user.isActive) return;
  // Como mucho unos pocos emails por hora a la misma dirección (evita usar KAI para bombardear un buzón).
  if (resetRequests.isBlocked(email)) return;
  resetRequests.hit(email);
  runInBackground('auth.password_reset_email', () => deliverPasswordReset(user), { userId: user.id });
}

async function deliverPasswordReset(user: { id: string; email: string; name: string }) {
  const token = randomToken(32);
  await getDb()
    .insert(passwordResetTokens)
    .values({ userId: user.id, tokenHash: sha256(token), expiresAt: new Date(Date.now() + RESET_TTL_MS) });
  const link = `${publicAppUrl()}/restablecer?token=${encodeURIComponent(token)}`;
  await sendEmail({
    to: user.email,
    subject: 'Restablece tu contraseña de KAI',
    text: `Hola ${user.name},\n\nPara crear una nueva contraseña abre este enlace (válido 1 hora):\n${link}\n\nSi no lo has pedido tú, ignora este mensaje.\n\n— KAI`,
  });
  await audit({ actorType: 'user', actorUserId: user.id, action: 'auth.password_reset_requested', entityType: 'user', entityId: user.id });
}

/** Invalida todos los enlaces de restablecimiento pendientes de un usuario. */
async function invalidateResetTokens(userId: string) {
  await getDb()
    .update(passwordResetTokens)
    .set({ usedAt: new Date() })
    .where(and(eq(passwordResetTokens.userId, userId), isNull(passwordResetTokens.usedAt)));
}

export async function resetPassword(token: string, newPassword: string) {
  validatePasswordStrength(newPassword);
  const db = getDb();
  // Consumo atómico: si llegan dos peticiones con el mismo enlace, solo una lo usa.
  const [row] = await db
    .update(passwordResetTokens)
    .set({ usedAt: new Date() })
    .where(
      and(eq(passwordResetTokens.tokenHash, sha256(token)), isNull(passwordResetTokens.usedAt), gt(passwordResetTokens.expiresAt, new Date())),
    )
    .returning({ userId: passwordResetTokens.userId });
  if (!row) throw badRequest('El enlace no es válido o ha caducado. Solicita uno nuevo.');
  await db.update(users).set({ passwordHash: await hashPassword(newPassword), updatedAt: new Date() }).where(eq(users.id, row.userId));
  // Cualquier otro enlace que se hubiera pedido antes deja de servir.
  await invalidateResetTokens(row.userId);
  await destroyUserSessions(row.userId);
  const [user] = await db.select({ email: users.email }).from(users).where(eq(users.id, row.userId)).limit(1);
  if (user) loginFailures.reset(user.email);
  await audit({ actorType: 'user', actorUserId: row.userId, action: 'auth.password_reset', entityType: 'user', entityId: row.userId });
}

export async function changePassword(userId: string, current: string, next: string, keepToken?: string) {
  const db = getDb();
  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user) throw notFound();
  if (!(await verifyPassword(current, user.passwordHash))) throw badRequest('La contraseña actual no es correcta.');
  validatePasswordStrength(next);
  await db.update(users).set({ passwordHash: await hashPassword(next), updatedAt: new Date() }).where(eq(users.id, userId));
  await invalidateResetTokens(userId);
  await destroyUserSessions(userId, keepToken);
  await audit({ actorType: 'user', actorUserId: userId, action: 'auth.password_changed', entityType: 'user', entityId: userId });
}

// ───────────── Equipo: invitaciones ─────────────

export async function inviteMember(businessId: string, invitedBy: string, emailRaw: string, role: BusinessRole) {
  const db = getDb();
  const email = normalizeEmail(emailRaw);
  const limits = await getLimits(businessId);
  if (limits.maxTeamMembers !== null && (await countSeats(businessId)) >= limits.maxTeamMembers)
    throw badRequest(`Tu plan permite ${limits.maxTeamMembers} usuario(s). Mejora el plan para invitar a más personas.`);
  const [already] = await db
    .select({ id: memberships.id })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(and(eq(memberships.businessId, businessId), eq(users.email, email)))
    .limit(1);
  if (already) throw conflict('Esa persona ya forma parte del equipo.');

  const token = randomToken(32);
  const [invite] = await db
    .insert(invitations)
    .values({ businessId, email, role, tokenHash: sha256(token), invitedByUserId: invitedBy, expiresAt: new Date(Date.now() + INVITE_TTL_MS) })
    .returning();
  const [biz] = await db.select({ name: businesses.name }).from(businesses).where(eq(businesses.id, businessId)).limit(1);
  const link = `${publicAppUrl()}/invitacion?token=${encodeURIComponent(token)}`;
  const emailed = await sendEmail({
    to: email,
    subject: `Te han invitado a ${biz?.name ?? 'un equipo'} en KAI`,
    text: `Hola,\n\nTe han invitado a unirte a ${biz?.name ?? 'un equipo'} en KAI.\nAcepta la invitación aquí (válida 7 días):\n${link}\n\n— KAI`,
  });
  await audit({ businessId, actorType: 'user', actorUserId: invitedBy, action: 'team.invited', entityType: 'invitation', entityId: invite.id, metadata: { email, role } });
  // El enlace se devuelve para poder copiarlo si no hay proveedor de email configurado.
  return { invitation: invite, link, emailed };
}

export async function getInvitation(token: string) {
  const [row] = await getDb()
    .select({ invitation: invitations, businessName: businesses.name })
    .from(invitations)
    .innerJoin(businesses, eq(businesses.id, invitations.businessId))
    .where(and(eq(invitations.tokenHash, sha256(token)), isNull(invitations.acceptedAt), gt(invitations.expiresAt, new Date())))
    .limit(1);
  if (!row) throw badRequest('La invitación no es válida o ha caducado.');
  const [user] = await getDb().select({ id: users.id }).from(users).where(eq(users.email, row.invitation.email)).limit(1);
  return { ...row, userExists: Boolean(user) };
}

export async function acceptInvitation(token: string, input: { name?: string; password?: string; currentUserId?: string }) {
  const db = getDb();
  const { invitation } = await getInvitation(token);
  let [user] = await db.select().from(users).where(eq(users.email, invitation.email)).limit(1);
  if (user) {
    if (input.currentUserId !== user.id) {
      if (invitationFailures.isBlocked(invitation.id))
        throw tooManyRequests('Demasiados intentos con esta invitación. Espera unos minutos e inténtalo de nuevo.');
      if (!input.password || !(await verifyPassword(input.password, user.passwordHash))) {
        invitationFailures.hit(invitation.id);
        throw unauthorized('Inicia sesión con la cuenta invitada para aceptar.');
      }
    }
  } else {
    if (!input.name || !input.password) throw badRequest('Indica tu nombre y una contraseña.');
    validatePasswordStrength(input.password);
    [user] = await db
      .insert(users)
      .values({ email: invitation.email, name: input.name.trim(), passwordHash: await hashPassword(input.password) })
      .returning();
  }
  await db
    .insert(memberships)
    .values({ businessId: invitation.businessId, userId: user.id, role: invitation.role })
    .onConflictDoNothing();
  await db.update(invitations).set({ acceptedAt: new Date() }).where(eq(invitations.id, invitation.id));
  await audit({ businessId: invitation.businessId, actorType: 'user', actorUserId: user.id, action: 'team.invitation_accepted', entityType: 'invitation', entityId: invitation.id });
  return { user, businessId: invitation.businessId };
}
