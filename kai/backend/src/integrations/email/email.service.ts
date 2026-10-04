import { emailConfigured, env, isProduction } from '../../config/env.js';
import { logError } from '../../audit/audit.service.js';
import { logger } from '../../lib/logger.js';

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface EmailProvider {
  name: string;
  send(msg: EmailMessage): Promise<void>;
}

/**
 * Desarrollo: el email se muestra en la consola del servidor (útil para probar la recuperación de contraseña).
 * Nunca se usa en producción: los emails llevan enlaces con tokens que no deben quedar en los registros.
 */
class ConsoleEmailProvider implements EmailProvider {
  name = 'console';
  public readonly outbox: EmailMessage[] = [];
  async send(msg: EmailMessage) {
    this.outbox.push(msg);
    if (this.outbox.length > 50) this.outbox.shift();
    if (isProduction()) logger.info('email.console', { to: msg.to, subject: msg.subject });
    else logger.info('email.console', { to: msg.to, subject: msg.subject, text: msg.text });
  }
}

/** Producción sin proveedor configurado: no se envía nada y se informa de ello (sendEmail devuelve false). */
export class EmailNotConfiguredError extends Error {
  constructor() {
    super('El envío de emails no está configurado (EMAIL_PROVIDER=resend y RESEND_API_KEY).');
    this.name = 'EmailNotConfiguredError';
  }
}

/** Producción: Resend (https://resend.com) — API REST oficial `POST /emails`. */
class ResendEmailProvider implements EmailProvider {
  name = 'resend';
  constructor(private readonly apiKey: string) {}
  async send(msg: EmailMessage) {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: env.EMAIL_FROM, to: [msg.to], subject: msg.subject, text: msg.text, html: msg.html }),
    });
    if (!res.ok) throw new Error(`Resend ${res.status}: ${await res.text()}`);
  }
}

export const consoleEmail = new ConsoleEmailProvider();

function provider(): EmailProvider | null {
  if (emailConfigured()) return new ResendEmailProvider(env.RESEND_API_KEY!);
  // En producción, sin Resend no hay envío (la consola dejaría los enlaces con token en los registros).
  if (isProduction()) return null;
  return consoleEmail;
}

/** Envía un email. Devuelve false si no se ha podido enviar (o si no hay proveedor configurado). */
export async function sendEmail(msg: EmailMessage): Promise<boolean> {
  const p = provider();
  if (!p) {
    await logError('email.send', new EmailNotConfiguredError(), { to: msg.to, subject: msg.subject }, null, 'warn');
    return false;
  }
  try {
    await p.send(msg);
    return true;
  } catch (err) {
    await logError('email.send', err, { to: msg.to, subject: msg.subject });
    return false;
  }
}
