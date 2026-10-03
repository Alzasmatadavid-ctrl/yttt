/**
 * Errores de aplicación con código HTTP y mensaje apto para mostrar al usuario (en español).
 */
export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const badRequest = (message: string, details?: unknown) => new AppError(400, 'bad_request', message, details);
export const unauthorized = (message = 'Necesitas iniciar sesión.') => new AppError(401, 'unauthorized', message);
export const forbidden = (message = 'No tienes permiso para realizar esta acción.') => new AppError(403, 'forbidden', message);
export const notFound = (message = 'No encontrado.') => new AppError(404, 'not_found', message);
export const conflict = (message: string) => new AppError(409, 'conflict', message);
export const limitReached = (message: string) => new AppError(402, 'limit_reached', message);
export const unavailable = (message: string) => new AppError(503, 'unavailable', message);

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return typeof err === 'string' ? err : JSON.stringify(err);
}
