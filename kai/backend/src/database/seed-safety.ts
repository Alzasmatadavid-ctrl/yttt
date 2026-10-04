/**
 * Comprobaciones de seguridad del script de datos demo (npm run db:seed).
 * Son funciones puras para poder probarlas sin ejecutar el script.
 */

/** Contraseña demo por defecto: es pública (está en el código y en .env.example). */
export const PUBLIC_DEMO_PASSWORD = 'KaiDemo2026';

/** Devuelve el motivo por el que NO se debe ejecutar el seed con esta configuración, o null si se puede. */
export function seedEnvironmentProblem(cfg: {
  production: boolean;
  force: boolean;
  demoEmail: string;
  demoPassword: string | undefined;
  adminEmail: string | undefined;
}): string | null {
  const demoEmail = cfg.demoEmail.trim().toLowerCase();
  if (cfg.adminEmail && cfg.adminEmail.trim().toLowerCase() === demoEmail)
    return 'DEMO_EMAIL coincide con ADMIN_EMAIL. Usa un email distinto para la cuenta demo.';
  if (!cfg.production) return null;
  if (!cfg.force) return 'Estás en producción. Los datos demo solo deberían crearse en local. Si de verdad quieres hacerlo, añade --force.';
  const pwd = cfg.demoPassword ?? '';
  if (!pwd || pwd === PUBLIC_DEMO_PASSWORD || pwd.length < 12 || !/[a-zA-Z]/.test(pwd) || !/[0-9]/.test(pwd))
    return 'En producción la cuenta demo necesita una DEMO_PASSWORD propia (al menos 12 caracteres con letras y números, distinta de la de ejemplo).';
  return null;
}

export interface DemoMembership {
  businessId: string;
  businessName: string;
  role: string;
  /** Personas que pertenecen a ese negocio (incluida la cuenta demo). */
  memberCount: number;
}

/**
 * Decide qué se borra al recrear la demo (--reset). Solo se borran negocios demo (por nombre) en los que
 * la cuenta demo es la única persona; si la cuenta es de administración o pertenece a algún negocio que
 * no es la demo, no se borra nada: probablemente DEMO_EMAIL apunta a una cuenta real.
 */
export function planDemoReset(
  user: { email: string; platformRole: string },
  memberships: DemoMembership[],
  demoBusinessName: string,
): { ok: true; businessIds: string[] } | { ok: false; reason: string } {
  if (user.platformRole === 'admin')
    return { ok: false, reason: `La cuenta ${user.email} es de administración: no se borra. Usa otro DEMO_EMAIL.` };
  const real = memberships.filter((m) => m.businessName !== demoBusinessName);
  if (real.length)
    return {
      ok: false,
      reason: `La cuenta ${user.email} pertenece a negocios que no son la demo (${real.map((m) => `«${m.businessName}»`).join(', ')}): no se borra nada. Usa otro DEMO_EMAIL.`,
    };
  const shared = memberships.filter((m) => m.memberCount > 1);
  if (shared.length)
    return { ok: false, reason: 'El negocio demo tiene más personas en su equipo: no se borra automáticamente. Bórralo a mano o usa otro DEMO_EMAIL.' };
  return { ok: true, businessIds: memberships.filter((m) => m.role === 'trainer').map((m) => m.businessId) };
}
