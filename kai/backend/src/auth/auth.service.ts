import { and, eq, gt, isNull } from 'drizzle-orm';
import { getDb } from '../database/client.js';
import { businesses, invitations, memberships, passwordResetTokens, plans, users } from '../database/schema.js';
import { env, publicAppUrl } from '../config/env.js';
import { hashPassword, randomToken, sha256, verifyPassword } from '../lib/crypto.js';
import { badRequest, conflict, forbidden, notFound, unauthorized } from '../lib/errors.js';
import { createBusiness } from '../business/business.service.js';
import { sendEmail } from '../integrations/email/email.service.js';
import { audit } from '../audit/audit.service.js';
import { destroyUserSessions } from './sessions.js';
import { countSeats, getLimits } from '../plans/plans.service.js';
import type { BusinessRole } from '../lib/domain.js';

export const normalizeEmail = (email: string) => email.trim().toLowerCase();

const RESET_TTL_MS = 60 * 60_000; // 1 hora
const INVITE_TTL_MS = 7 * 24 * 3600_000; // 7 días

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

  const isPlatformAdmin = Boolean(env.ADMIN_EMAIL && normalizeEmail(env.ADMIN_EMAIL) === email);
  const [user] = await db
    .insert(users)
    .values({
      email,
      name: input.name.trim(),
      passwordHash: await hashPassword(input.password),
      platformRole: isPlatformAdmin ? 'admin' : 'user',
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

export async function authenticate(emailRaw: string, password: string) {
  const email = normalizeEmail(emailRaw);
  const [user] = await getDb().select().from(users).where(eq(users.email, email)).limit(1);
  // Mismo coste de tiempo exista o no el usuario (evita enumerar cuentas).
  const ok = user ? await verifyPassword(password, user.passwordHash) : await verifyPassword(password, await dummyHash());
  if (!user || !ok) throw unauthorized('Email o contraseña incorrectos.');
  if (!user.isActive) throw forbidden('Esta cuenta está desactivada. Contacta con soporte.');
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
    })
    .from(memberships)
    .innerJoin(businesses, eq(businesses.id, memberships.businessId))
    .leftJoin(plans, eq(plans.id, businesses.planId))
    .where(eq(memberships.userId, userId))
    .orderBy(memberships.createdAt);
}

export async function requestPasswordReset(emailRaw: string) {
  const db = getDb();
  const email = normalizeEmail(emailRaw);
  const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  // Respuesta idéntica exista o no la cuenta.
  if (!user || !user.isActive) return;
  const token = randomToken(32);
  await db.insert(passwordResetTokens).values({ userId: user.id, tokenHash: sha256(token), expiresAt: new Date(Date.now() + RESET_TTL_MS) });
  const link = `${publicAppUrl()}/restablecer?token=${encodeURIComponent(token)}`;
  await sendEmail({
    to: user.email,
    subject: 'Restablece tu contraseña de KAI',
    text: `Hola ${user.name},\n\nPara crear una nueva contraseña abre este enlace (válido 1 hora):\n${link}\n\nSi no lo has pedido tú, ignora este mensaje.\n\n— KAI`,
  });
  await audit({ actorType: 'user', actorUserId: user.id, action: 'auth.password_reset_requested', entityType: 'user', entityId: user.id });
}

export async function resetPassword(token: string, newPassword: string) {
  validatePasswordStrength(newPassword);
  const db = getDb();
  const [row] = await db
    .select()
    .from(passwordResetTokens)
    .where(
      and(eq(passwordResetTokens.tokenHash, sha256(token)), isNull(passwordResetTokens.usedAt), gt(passwordResetTokens.expiresAt, new Date())),
    )
    .limit(1);
  if (!row) throw badRequest('El enlace no es válido o ha caducado. Solicita uno nuevo.');
  await db.update(users).set({ passwordHash: await hashPassword(newPassword), updatedAt: new Date() }).where(eq(users.id, row.userId));
  await db.update(passwordResetTokens).set({ usedAt: new Date() }).where(eq(passwordResetTokens.id, row.id));
  await destroyUserSessions(row.userId);
  await audit({ actorType: 'user', actorUserId: row.userId, action: 'auth.password_reset', entityType: 'user', entityId: row.userId });
}

export async function changePassword(userId: string, current: string, next: string, keepToken?: string) {
  const db = getDb();
  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user) throw notFound();
  if (!(await verifyPassword(current, user.passwordHash))) throw badRequest('La contraseña actual no es correcta.');
  validatePasswordStrength(next);
  await db.update(users).set({ passwordHash: await hashPassword(next), updatedAt: new Date() }).where(eq(users.id, userId));
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
      if (!input.password || !(await verifyPassword(input.password, user.passwordHash)))
        throw unauthorized('Inicia sesión con la cuenta invitada para aceptar.');
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
