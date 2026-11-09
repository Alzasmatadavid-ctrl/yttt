/**
 * Cliente de la API de KAI.
 * - Envía siempre la cookie de sesión (mismo dominio) y la cabecera anti-CSRF.
 * - Indica en cada petición para qué negocio es (cabecera X-KAI-Business): ver setRequestBusiness.
 * - Convierte los errores del servidor en mensajes legibles (en español).
 */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

type Query = Record<string, string | number | boolean | undefined | null>;

/**
 * Negocio con el que trabaja ESTA pestaña. El negocio activo se guarda en la sesión del servidor, que comparten todas
 * las pestañas: si en otra pestaña se cambia de negocio, esta seguiría mostrando el negocio A mientras sus peticiones
 * (guardar ajustes, responder a un lead…) irían contra el B. Con la cabecera, el servidor usa siempre el negocio de la
 * pestaña, o responde 403 si ya no se tiene acceso a él; nunca pasa a otro en silencio. Lo fija AuthProvider.
 */
let requestBusinessId: string | null = null;

export function setRequestBusiness(businessId: string | null) {
  requestBusinessId = businessId;
}

export function getRequestBusiness() {
  return requestBusinessId;
}

function buildUrl(path: string, query?: Query) {
  const url = new URL(`/api${path}`, window.location.origin);
  if (query) for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  return url.toString();
}

async function request<T>(method: string, path: string, body?: unknown, query?: Query): Promise<T> {
  let res: Response;
  try {
    res = await fetch(buildUrl(path, query), {
      method,
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        'X-Requested-With': 'kai',
        ...(requestBusinessId ? { 'X-KAI-Business': requestBusinessId } : {}),
      },
      body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
    });
  } catch {
    throw new ApiError(0, 'network', 'No hay conexión con el servidor. Revisa tu conexión a internet.');
  }
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    const d = (data ?? {}) as { error?: string; message?: string; details?: unknown };
    throw new ApiError(res.status, d.error ?? 'error', d.message ?? 'Algo ha fallado. Inténtalo de nuevo.', d.details);
  }
  return data as T;
}

export const api = {
  get: <T>(path: string, query?: Query) => request<T>('GET', path, undefined, query),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body),
  put: <T>(path: string, body?: unknown) => request<T>('PUT', path, body),
  patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, body),
  del: <T>(path: string) => request<T>('DELETE', path),
};

export const errorText = (err: unknown) => (err instanceof Error ? err.message : 'Algo ha fallado.');
