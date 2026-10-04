import { z } from 'zod';
import { badRequest } from './errors.js';

// Mensajes de validación en español natural (los propios de cada esquema tienen prioridad).
z.config(z.locales.es());
z.config({
  customError: (iss) => {
    const origin = (iss as { origin?: string }).origin;
    switch (iss.code) {
      case 'invalid_type':
        if (iss.input === undefined || iss.input === null) return 'es obligatorio';
        return iss.expected === 'int' ? 'debe ser un número entero' : 'el formato no es correcto';
      case 'too_small': {
        const min = Number(iss.minimum);
        if (origin === 'string') return min <= 1 ? 'no puede estar vacío' : `debe tener al menos ${min} caracteres`;
        if (origin === 'array' || origin === 'set') return `debe tener al menos ${min} ${min === 1 ? 'elemento' : 'elementos'}`;
        return `debe ser como mínimo ${min}`;
      }
      case 'too_big': {
        const max = Number(iss.maximum);
        if (origin === 'string') return `admite como máximo ${max} caracteres`;
        if (origin === 'array' || origin === 'set') return `admite como máximo ${max} elementos`;
        return `debe ser como máximo ${max}`;
      }
      case 'invalid_format': {
        const format = (iss as { format?: string }).format;
        if (format === 'email') return 'no es un email válido';
        if (format === 'url') return 'no es una dirección web válida';
        if (format === 'uuid') return 'identificador no válido';
        return 'el formato no es correcto';
      }
      case 'invalid_value':
        return 'no es una opción válida';
      default:
        return undefined;
    }
  },
});

/** Nombres legibles de los campos más comunes, para que los errores se entiendan sin conocimientos técnicos. */
const FIELD_LABELS: Record<string, string> = {
  email: 'email',
  password: 'contraseña',
  newPassword: 'nueva contraseña',
  currentPassword: 'contraseña actual',
  name: 'nombre',
  businessName: 'nombre del negocio',
  phone: 'teléfono',
  timezone: 'zona horaria',
  priceCents: 'precio',
  text: 'mensaje',
  question: 'pregunta',
};

/** Valida datos de entrada con Zod y devuelve un error 400 legible en español. */
export function parse<T extends z.ZodType>(schema: T, data: unknown): z.infer<T> {
  const result = schema.safeParse(data ?? {});
  if (!result.success) {
    const issues = result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
    const first = issues[0];
    const field = first?.path ? (FIELD_LABELS[first.path.split('.').pop() ?? ''] ?? first.path) : '';
    throw badRequest(first ? `Revisa ${field ? `el campo «${field}»` : 'los datos'}: ${first.message}` : 'Datos no válidos.', issues);
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

/** Parámetros de la URL que nunca deben acabar en los registros (enlaces de invitación, OAuth…). */
const SENSITIVE_QUERY_PARAMS = ['token', 'code', 'state', 'key', 'secret', 'access_token', 'hub.verify_token', 'hub.challenge'];

/** Devuelve la URL con los valores sensibles de la query sustituidos por «[oculto]». */
export function redactUrl(url: string): string {
  const q = url.indexOf('?');
  if (q < 0) return url;
  const params = url
    .slice(q + 1)
    .split('&')
    .map((pair) => {
      const eq = pair.indexOf('=');
      const rawName = eq < 0 ? pair : pair.slice(0, eq);
      let name = rawName;
      try {
        name = decodeURIComponent(rawName.replace(/\+/g, ' '));
      } catch {
        // nombre mal codificado: se compara tal cual
      }
      return eq >= 0 && SENSITIVE_QUERY_PARAMS.includes(name.toLowerCase()) ? `${rawName}=[oculto]` : pair;
    });
  return `${url.slice(0, q)}?${params.join('&')}`;
}
