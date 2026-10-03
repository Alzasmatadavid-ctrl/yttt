import type { FastifyReply, FastifyRequest } from 'fastify';
import { eq } from 'drizzle-orm';
import { getDb } from '../database/client.js';
import { businesses, memberships } from '../database/schema.js';
import { ROLE_PERMISSIONS, type BusinessRole, type Permission } from '../lib/domain.js';
import { forbidden, unauthorized } from '../lib/errors.js';
import { resolveSession, SESSION_COOKIE } from './sessions.js';

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  platformRole: 'admin' | 'user';
}

/** Contexto de tenant: TODA operación de negocio recibe esto y filtra por `businessId`. */
export interface TenantContext {
  businessId: string;
  userId: string;
  role: BusinessRole;
  permissions: Permission[];
  ip?: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    authUser: AuthUser | null;
    sessionToken: string | null;
    activeBusinessId: string | null;
    tenant: TenantContext | null;
    rawBody?: string;
  }
}

/** Hook global: identifica al usuario a partir de la cookie de sesión (si existe). */
export async function identify(request: FastifyRequest) {
  request.authUser = null;
  request.sessionToken = null;
  request.activeBusinessId = null;
  request.tenant = null;
  const token = request.cookies?.[SESSION_COOKIE];
  if (!token) return;
  const row = await resolveSession(token);
  if (!row) return;
  request.authUser = { id: row.user.id, email: row.user.email, name: row.user.name, platformRole: row.user.platformRole };
  request.sessionToken = token;
  request.activeBusinessId = row.session.activeBusinessId;
}

export function requireUser(request: FastifyRequest): AuthUser {
  if (!request.authUser) throw unauthorized();
  return request.authUser;
}

export function requireAdmin(request: FastifyRequest): AuthUser {
  const user = requireUser(request);
  if (user.platformRole !== 'admin') throw forbidden('Solo el administrador de KAI puede acceder.');
  return user;
}

/**
 * Resuelve el negocio activo y comprueba que el usuario pertenece a él.
 * Si se indica un permiso, también lo verifica.
 */
export async function requireTenant(request: FastifyRequest, permission?: Permission): Promise<TenantContext> {
  const user = requireUser(request);
  if (!request.tenant) {
    const db = getDb();
    const headerBusiness = request.headers['x-kai-business'];
    const wanted = (typeof headerBusiness === 'string' && headerBusiness) || request.activeBusinessId;
    const rows = await db
      .select({ businessId: memberships.businessId, role: memberships.role, status: businesses.status })
      .from(memberships)
      .innerJoin(businesses, eq(businesses.id, memberships.businessId))
      .where(eq(memberships.userId, user.id))
      .orderBy(memberships.createdAt);
    // Negocio pedido (cabecera o sesión) si el usuario pertenece a él; si no, el primero que tenga.
    const m = (wanted ? rows.find((r) => r.businessId === wanted) : undefined) ?? (typeof headerBusiness === 'string' && headerBusiness ? undefined : rows[0]);
    if (!m) throw forbidden('No tienes acceso a este negocio.');
    if (m.status === 'suspended') throw forbidden('Esta cuenta está suspendida. Contacta con soporte.');
    request.tenant = {
      businessId: m.businessId,
      userId: user.id,
      role: m.role,
      permissions: ROLE_PERMISSIONS[m.role],
      ip: request.ip,
    };
  }
  if (permission && !request.tenant.permissions.includes(permission)) throw forbidden();
  return request.tenant;
}

export function can(ctx: TenantContext, permission: Permission) {
  return ctx.permissions.includes(permission);
}

export type Handler = (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
