import { z } from 'zod';
import { badRequest } from './errors.js';

/** Valida datos de entrada con Zod y devuelve un error 400 legible en español. */
export function parse<T extends z.ZodType>(schema: T, data: unknown): z.infer<T> {
  const result = schema.safeParse(data ?? {});
  if (!result.success) {
    const issues = result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
    const first = issues[0];
    throw badRequest(first ? `Dato no válido${first.path ? ` en "${first.path}"` : ''}: ${first.message}` : 'Datos no válidos.', issues);
  }
  return result.data;
}

export const uuidParam = z.object({ id: z.string().uuid('Identificador no válido') });

export const paginationQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

/** Booleano en query string (“true”/“false”, “1”/“0”). Ojo: z.coerce.boolean() convierte “false” en true. */
export const boolQuery = z
  .enum(['true', 'false', '1', '0'])
  .optional()
  .transform((v) => (v === undefined ? undefined : v === 'true' || v === '1'));

/** Zona horaria IANA válida (“Europe/Madrid”, “America/Mexico_City”…). */
export const timezoneSchema = z
  .string()
  .trim()
  .min(3)
  .max(64)
  .refine((tz) => {
    try {
      new Intl.DateTimeFormat('es', { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  }, 'Zona horaria no válida');
