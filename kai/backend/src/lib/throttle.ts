/**
 * Contador de intentos en memoria por clave (email, invitación…), con ventana fija.
 *
 * Complementa el límite por IP de @fastify/rate-limit: aunque alguien cambie de IP en cada
 * petición, no puede probar contraseñas sin fin contra la misma cuenta.
 * Es por proceso (con varias instancias, cada una cuenta por su lado): suficiente como freno.
 */
export interface AttemptLimiterOptions {
  /** Intentos permitidos dentro de la ventana. */
  max: number;
  /** Duración de la ventana en milisegundos (empieza con el primer intento). */
  windowMs: number;
  /** Claves distintas que se guardan como máximo (protege la memoria). */
  maxKeys?: number;
}

interface Entry {
  count: number;
  resetAt: number;
}

export class AttemptLimiter {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly opts: AttemptLimiterOptions) {}

  private current(key: string, now: number): Entry | null {
    const e = this.entries.get(key);
    if (!e) return null;
    if (e.resetAt <= now) {
      this.entries.delete(key);
      return null;
    }
    return e;
  }

  /** ¿Se ha agotado el cupo de intentos para esta clave? */
  isBlocked(key: string, now = Date.now()): boolean {
    const e = this.current(key, now);
    return Boolean(e && e.count >= this.opts.max);
  }

  /** Milisegundos que faltan para que la clave vuelva a tener intentos (0 si no está bloqueada). */
  retryAfterMs(key: string, now = Date.now()): number {
    const e = this.current(key, now);
    return e && e.count >= this.opts.max ? e.resetAt - now : 0;
  }

  /** Registra un intento. Devuelve cuántos lleva en la ventana actual. */
  hit(key: string, now = Date.now()): number {
    const e = this.current(key, now);
    if (e) {
      e.count++;
      return e.count;
    }
    this.prune(now);
    this.entries.set(key, { count: 1, resetAt: now + this.opts.windowMs });
    return 1;
  }

  reset(key: string) {
    this.entries.delete(key);
  }

  clear() {
    this.entries.clear();
  }

  private prune(now: number) {
    const maxKeys = this.opts.maxKeys ?? 50_000;
    if (this.entries.size < maxKeys) return;
    for (const [k, e] of this.entries) if (e.resetAt <= now) this.entries.delete(k);
    // Si sigue lleno, se descartan las más antiguas (los Map conservan el orden de inserción).
    for (const k of this.entries.keys()) {
      if (this.entries.size < maxKeys) break;
      this.entries.delete(k);
    }
  }
}

/** Minutos (redondeando hacia arriba) para mostrar en mensajes de espera. */
export const minutesFromMs = (ms: number) => Math.max(1, Math.ceil(ms / 60_000));
