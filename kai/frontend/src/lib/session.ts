/*
 * Sesión (/auth/me): distinguir «no hay sesión» de «no se ha podido comprobar».
 * Sin sesión, /auth/me responde 200 con `user: null`. Un fallo (429 por exceso de peticiones, 502 durante un despliegue,
 * sin conexión…) solo dice que no se ha podido preguntar: no debe llevar al login, porque parecería que se ha cerrado
 * la sesión y se perdería la pantalla abierta.
 */
import { ApiError } from './api';

export type SessionState = 'loading' | 'unreachable' | 'guest' | 'user';

/**
 * loading: aún se está preguntando (o reintentando). unreachable: no hay respuesta de /auth/me (error o sin conexión).
 * guest: el servidor ha respondido que no hay sesión. user: hay sesión.
 */
export function sessionState(me: { user: unknown } | null | undefined, loading: boolean): SessionState {
  if (loading) return 'loading';
  // Sin datos y sin estar cargando = la petición falló o está en pausa por falta de conexión.
  if (!me) return 'unreachable';
  return me.user ? 'user' : 'guest';
}

/** Reintentos de /auth/me: un 429 (límite de peticiones) también se reintenta, con más espera; los demás 4xx no. */
export function sessionRetry(failureCount: number, err: unknown): boolean {
  if (err instanceof ApiError && err.status === 429) return failureCount < 3;
  return !(err instanceof ApiError && err.status >= 400 && err.status < 500) && failureCount < 2;
}

/** Espera antes de cada reintento (ms): 2, 4 y 8 s tras un 429; 1 y 2 s en los demás fallos. */
export function sessionRetryDelay(failureCount: number, err: unknown): number {
  return err instanceof ApiError && err.status === 429 ? 2000 * 2 ** failureCount : Math.min(1000 * 2 ** failureCount, 30_000);
}
