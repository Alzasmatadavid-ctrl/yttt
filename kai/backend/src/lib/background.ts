import { logError } from '../audit/audit.service.js';

/**
 * Tareas que se ejecutan después de responder (por ejemplo, enviar un email) para que la
 * respuesta no tarde distinto según lo que ocurra detrás. Los fallos se registran en error_logs.
 */
const pending = new Set<Promise<void>>();

export function runInBackground(source: string, task: () => Promise<unknown>, context: Record<string, unknown> = {}): void {
  const p: Promise<void> = (async () => {
    try {
      await task();
    } catch (err) {
      await logError(source, err, context);
    }
  })();
  pending.add(p);
  void p.finally(() => pending.delete(p));
}

/** Espera a que terminen las tareas en curso (cierre ordenado del servidor y tests). */
export async function settleBackgroundTasks(): Promise<void> {
  while (pending.size) await Promise.allSettled([...pending]);
}
