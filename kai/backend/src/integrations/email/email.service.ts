import { env } from '../../config/env.js';
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

/** Desarrollo: el email se muestra en la consola del servidor (útil para probar la recuperación de contraseña). */
class ConsoleEmailProvider implements EmailProvider {
  name = 'console';
  public readonly outbox: EmailMessage[] = [];
  async send(msg: EmailMessage) {
    this.outbox.push(msg);
    if (this.outbox.length > 50) this.outbox.shift();
    logger.info('email.console', { to: msg.to, subject: msg.subject, text: msg.text });
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

function provider(): EmailProvider {
  if (env.EMAIL_PROVIDER === 'resend' && env.RESEND_API_KEY) return new ResendEmailProvider(env.RESEND_API_KEY);
  return consoleEmail;
}

export async function sendEmail(msg: EmailMessage): Promise<boolean> {
  try {
    await provider().send(msg);
    return true;
  } catch (err) {
    await logError('email.send', err, { to: msg.to, subject: msg.subject });
    return false;
  }
}
