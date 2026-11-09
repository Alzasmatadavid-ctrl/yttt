/**
 * Revisión nº 1 (plataforma): piezas puras de seguridad y de mensajes al entrenador.
 *  - IP real solo a través de proxies de confianza (TRUST_PROXY).
 *  - URLs sin tokens en los registros.
 *  - Límite de intentos por cuenta.
 *  - Detección estricta de bajas.
 *  - Errores de Meta traducidos al español.
 *  - Protecciones del script de datos demo.
 */
import { describe, expect, it } from 'vitest';
import { PRIVATE_PROXIES, trustProxySetting } from '../../src/config/env.js';
import { redactUrl } from '../../src/lib/http.js';
import { AttemptLimiter, minutesFromMs } from '../../src/lib/throttle.js';
import { isOptOutRequest } from '../../src/crm/opt-out.js';
import { isUniqueViolation } from '../../src/crm/leads.service.js';
import { friendlyMetaCode, friendlyMetaError, GraphApiError } from '../../src/integrations/meta/graph.js';
import { planDemoReset, PUBLIC_DEMO_PASSWORD, seedEnvironmentProblem } from '../../src/database/seed-safety.js';

describe('trustProxySetting (TRUST_PROXY)', () => {
  it('nunca confía en cualquier X-Forwarded-For', () => {
    for (const v of [undefined, '', 'true', 'false', '0', '1', '2', '10.0.0.0/8']) {
      for (const production of [true, false]) expect(trustProxySetting(v, production)).not.toBe(true);
    }
  });

  it('vacío: proxies de redes privadas en producción y ninguno en desarrollo', () => {
    expect(trustProxySetting(undefined, true)).toBe(PRIVATE_PROXIES);
    expect(trustProxySetting('', true)).toBe(PRIVATE_PROXIES);
    expect(trustProxySetting(undefined, false)).toBe(false);
  });

  it('false/0 desactiva; true usa las redes privadas', () => {
    expect(trustProxySetting('false', true)).toBe(false);
    expect(trustProxySetting('0', true)).toBe(false);
    expect(trustProxySetting('TRUE', false)).toBe(PRIVATE_PROXIES);
  });

  it('un número N confía solo en los N saltos más cercanos', () => {
    const fn = trustProxySetting('2', true);
    expect(typeof fn).toBe('function');
    const trust = fn as (addr: string, hop: number) => boolean;
    expect(trust('10.0.0.1', 0)).toBe(true);
    expect(trust('10.0.0.2', 1)).toBe(true);
    expect(trust('9.9.9.9', 2)).toBe(false);
  });

  it('IPs o rangos se pasan tal cual', () => {
    expect(trustProxySetting(' 10.0.0.0/8, 173.245.48.0/20 ', true)).toBe('10.0.0.0/8, 173.245.48.0/20');
  });
});

describe('redactUrl', () => {
  it('oculta tokens, códigos OAuth y claves de la query', () => {
    expect(redactUrl('/api/auth/invitation?token=abc123')).toBe('/api/auth/invitation?token=[oculto]');
    expect(redactUrl('/api/integrations/google/callback?code=4/xyz&state=firmado&scope=calendar')).toBe(
      '/api/integrations/google/callback?code=[oculto]&state=[oculto]&scope=calendar',
    );
    expect(redactUrl('/api/webhooks/meta?hub.mode=subscribe&hub.verify_token=secreto&hub.challenge=123')).toBe(
      '/api/webhooks/meta?hub.mode=subscribe&hub.verify_token=[oculto]&hub.challenge=[oculto]',
    );
  });

  it('deja intactas las URLs sin datos sensibles', () => {
    expect(redactUrl('/api/leads?status=new&limit=20')).toBe('/api/leads?status=new&limit=20');
    expect(redactUrl('/api/health')).toBe('/api/health');
  });
});

describe('AttemptLimiter', () => {
  it('bloquea al llegar al máximo dentro de la ventana y se libera al terminarla', () => {
    const l = new AttemptLimiter({ max: 3, windowMs: 60_000 });
    const t0 = 1_000_000;
    expect(l.isBlocked('a@b.c', t0)).toBe(false);
    l.hit('a@b.c', t0);
    l.hit('a@b.c', t0 + 1000);
    expect(l.isBlocked('a@b.c', t0 + 2000)).toBe(false);
    l.hit('a@b.c', t0 + 2000);
    expect(l.isBlocked('a@b.c', t0 + 3000)).toBe(true);
    expect(l.retryAfterMs('a@b.c', t0 + 3000)).toBe(57_000);
    expect(l.isBlocked('otra@b.c', t0 + 3000)).toBe(false);
    expect(l.isBlocked('a@b.c', t0 + 60_001)).toBe(false);
  });

  it('reset borra el contador', () => {
    const l = new AttemptLimiter({ max: 1, windowMs: 60_000 });
    l.hit('k');
    expect(l.isBlocked('k')).toBe(true);
    l.reset('k');
    expect(l.isBlocked('k')).toBe(false);
  });

  it('no crece sin límite en memoria', () => {
    const l = new AttemptLimiter({ max: 5, windowMs: 60_000, maxKeys: 100 });
    for (let i = 0; i < 1000; i++) l.hit(`k${i}`);
    expect((l as unknown as { entries: Map<string, unknown> }).entries.size).toBeLessThanOrEqual(100);
  });

  it('minutesFromMs redondea hacia arriba con un mínimo de 1', () => {
    expect(minutesFromMs(1)).toBe(1);
    expect(minutesFromMs(61_000)).toBe(2);
  });
});

describe('isOptOutRequest (bajas inequívocas)', () => {
  it.each([
    'STOP',
    'Baja',
    'baja.',
    'Dame de baja por favor',
    'Quiero darme de baja',
    'Dejad de escribirme, gracias',
    'No me escribáis más',
    'no me mandes más mensajes',
    'No quiero recibir más mensajes',
    'Borrad mis datos',
    '¡Dejen de molestarme!',
  ])('detecta «%s»', (text) => {
    expect(isOptOutRequest(text)).toBe(true);
  });

  it.each([
    '¿Por qué no me escribiste ayer?',
    'Quiero bajar de peso',
    'Me di de baja del gimnasio el mes pasado',
    'No me escribas por la mañana, mejor por la tarde',
    'Hola, ¿qué tal?',
    'basta de excusas, quiero empezar ya',
    '',
  ])('no confunde «%s» con una baja', (text) => {
    expect(isOptOutRequest(text)).toBe(false);
  });
});

describe('isUniqueViolation', () => {
  it('reconoce el código 23505 directo o envuelto', () => {
    expect(isUniqueViolation({ code: '23505' })).toBe(true);
    expect(isUniqueViolation(Object.assign(new Error('Failed query'), { cause: { code: '23505' } }))).toBe(true);
    expect(isUniqueViolation(new Error('otra cosa'))).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
  });
});

describe('errores de Meta en español', () => {
  const graphError = (status: number, code?: number, subcode?: number, message = 'Technical English message') =>
    new GraphApiError(status, { error: { message, code, error_subcode: subcode } });

  it('token caducado → reconectar en Integraciones', () => {
    const msg = friendlyMetaError(graphError(401, 190), 'WhatsApp');
    expect(msg).toMatch(/caducado/);
    expect(msg).toMatch(/Integraciones/);
    expect(msg).not.toMatch(/Technical English/);
  });

  it('fuera de la ventana de 24 h (WhatsApp 131047 e Instagram 10/2018278)', () => {
    expect(friendlyMetaError(graphError(400, 131047), 'WhatsApp')).toMatch(/24 h/);
    expect(friendlyMetaError(graphError(400, 10, 2018278), 'Instagram')).toMatch(/24 h/);
  });

  it('número sin WhatsApp, plantillas, límites y errores temporales', () => {
    expect(friendlyMetaCode(131026, undefined, 'WhatsApp')).toMatch(/no tiene WhatsApp/);
    expect(friendlyMetaCode(132001, undefined, 'WhatsApp')).toMatch(/plantilla/i);
    expect(friendlyMetaCode(80007, undefined, 'Instagram')).toMatch(/limitando/);
    expect(friendlyMetaCode(10, undefined, 'Instagram')).toMatch(/permiso/);
    expect(friendlyMetaError(graphError(503), 'WhatsApp')).toMatch(/temporal/);
  });

  it('código desconocido: mensaje genérico en español con el código', () => {
    const msg = friendlyMetaError(graphError(400, 999999), 'WhatsApp');
    expect(msg).toMatch(/WhatsApp ha rechazado la petición \(código 999999\)/);
  });

  it('tiempo de espera y fallos de red', () => {
    const timeout = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    expect(friendlyMetaError(timeout, 'WhatsApp')).toMatch(/tardado demasiado/);
    expect(friendlyMetaError(new TypeError('fetch failed'), 'Instagram')).toMatch(/No se ha podido conectar con Instagram/);
  });

  it('los errores propios de KAI (ya en español) se mantienen', () => {
    expect(friendlyMetaError(new Error('El lead no tiene número de WhatsApp.'))).toBe('El lead no tiene número de WhatsApp.');
  });
});

describe('script de datos demo', () => {
  const base = { production: false, force: false, demoEmail: 'demo@kai.local', demoPassword: undefined, adminEmail: undefined };

  it('en local se puede ejecutar con la configuración por defecto', () => {
    expect(seedEnvironmentProblem(base)).toBeNull();
  });

  it('nunca si DEMO_EMAIL coincide con ADMIN_EMAIL', () => {
    expect(seedEnvironmentProblem({ ...base, demoEmail: 'Owner@Kai.com', adminEmail: 'owner@kai.com ' })).toMatch(/ADMIN_EMAIL/);
  });

  it('en producción exige --force y una contraseña propia y fuerte', () => {
    expect(seedEnvironmentProblem({ ...base, production: true })).toMatch(/--force/);
    expect(seedEnvironmentProblem({ ...base, production: true, force: true })).toMatch(/DEMO_PASSWORD/);
    expect(seedEnvironmentProblem({ ...base, production: true, force: true, demoPassword: PUBLIC_DEMO_PASSWORD })).toMatch(/DEMO_PASSWORD/);
    expect(seedEnvironmentProblem({ ...base, production: true, force: true, demoPassword: 'corta1' })).toMatch(/DEMO_PASSWORD/);
    expect(seedEnvironmentProblem({ ...base, production: true, force: true, demoPassword: 'UnaClaveDemoLarga2026' })).toBeNull();
  });

  const DEMO = 'Demo · David Alzas Coach';
  const user = { email: 'demo@kai.local', platformRole: 'user' };

  it('--reset solo borra negocios demo en los que la cuenta demo está sola', () => {
    const plan = planDemoReset(user, [{ businessId: 'b1', businessName: DEMO, role: 'trainer', memberCount: 1 }], DEMO);
    expect(plan).toEqual({ ok: true, businessIds: ['b1'] });
  });

  it('--reset no borra nada si la cuenta pertenece a un negocio real', () => {
    const plan = planDemoReset(
      user,
      [
        { businessId: 'b1', businessName: DEMO, role: 'trainer', memberCount: 1 },
        { businessId: 'b2', businessName: 'Laura Fit', role: 'trainer', memberCount: 1 },
      ],
      DEMO,
    );
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.reason).toMatch(/Laura Fit/);
  });

  it('--reset no borra una cuenta de administración ni un negocio compartido', () => {
    expect(planDemoReset({ ...user, platformRole: 'admin' }, [], DEMO).ok).toBe(false);
    expect(planDemoReset(user, [{ businessId: 'b1', businessName: DEMO, role: 'trainer', memberCount: 2 }], DEMO).ok).toBe(false);
  });
});
