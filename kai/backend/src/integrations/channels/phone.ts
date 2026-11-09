/**
 * Normalización de teléfonos para WhatsApp (formato internacional sin “+”, p. ej. 34600111222).
 * Si el número llega sin prefijo de país, se usa el del país del negocio (según su zona horaria).
 */
const TZ_COUNTRY_CODE: Record<string, string> = {
  'Europe/Madrid': '34',
  'Atlantic/Canary': '34',
  'Africa/Ceuta': '34',
  'Europe/Lisbon': '351',
  'America/Mexico_City': '52',
  'America/Monterrey': '52',
  'America/Cancun': '52',
  'America/Tijuana': '52',
  'America/Bogota': '57',
  'America/Argentina/Buenos_Aires': '54',
  'America/Santiago': '56',
  'America/Lima': '51',
  'America/Caracas': '58',
  'America/Guayaquil': '593',
  'America/Montevideo': '598',
  'America/Asuncion': '595',
  'America/La_Paz': '591',
  'America/Panama': '507',
  'America/Costa_Rica': '506',
  'America/Guatemala': '502',
  'America/El_Salvador': '503',
  'America/Tegucigalpa': '504',
  'America/Managua': '505',
  'America/Santo_Domingo': '1',
  'America/Puerto_Rico': '1',
  'America/New_York': '1',
  'America/Chicago': '1',
  'America/Denver': '1',
  'America/Los_Angeles': '1',
};

export function toWhatsAppId(phone: string | null | undefined, timezone: string): string | null {
  if (!phone) return null;
  const trimmed = phone.trim();
  let digits = trimmed.replace(/[^\d]/g, '');
  if (!digits) return null;
  if (trimmed.startsWith('+')) return digits;
  if (digits.startsWith('00')) return digits.slice(2);
  const cc = TZ_COUNTRY_CODE[timezone];
  if (cc && digits.length <= 10 && !digits.startsWith(cc)) digits = `${cc}${digits.replace(/^0+/, '')}`;
  return digits.length >= 8 ? digits : null;
}

/** Prefijo telefónico del país del negocio (según su zona horaria), o null si no se conoce. */
export function countryCodeForTimezone(timezone: string | null | undefined): string | null {
  return (timezone && TZ_COUNTRY_CODE[timezone]) || null;
}

/**
 * Número en formato internacional (solo dígitos, sin «+») cuando se puede saber su país: lleva «+» o «00», o se le
 * pone el prefijo del país del negocio (el mismo criterio que `toWhatsAppId`, que es a donde le escribe KAI).
 * null si el número no lleva prefijo y no se conoce el país. Los móviles de México y Argentina se unifican: WhatsApp
 * los identifica como 521… y 549… y se suelen apuntar como 52… y 54….
 */
export function internationalDigits(phone: string, countryCode: string | null): string | null {
  const trimmed = phone.trim();
  let digits = trimmed.replace(/[^\d]/g, '');
  if (!digits) return null;
  if (!trimmed.startsWith('+')) {
    if (digits.startsWith('00')) digits = digits.slice(2);
    else if (!countryCode) return null;
    else if (digits.length <= 10 && !digits.startsWith(countryCode)) digits = `${countryCode}${digits.replace(/^0+/, '')}`;
  }
  if (/^521\d{10}$/.test(digits)) digits = `52${digits.slice(3)}`;
  if (/^549\d{10}$/.test(digits)) digits = `54${digits.slice(3)}`;
  return digits;
}

/**
 * ¿Es el mismo número de teléfono? Con el país conocido se comparan completos: +33 612 345 678 (Francia) NO es
 * +34 612 345 678 (España), aunque acaben igual. Solo si no se puede saber el país de uno de ellos (sin prefijo y con
 * un negocio de un país desconocido) se comparan los últimos 9 dígitos.
 */
export function samePhoneNumber(a: string, b: string, countryCode: string | null): boolean {
  const ia = internationalDigits(a, countryCode);
  const ib = internationalDigits(b, countryCode);
  if (ia && ib) return ia === ib;
  const da = a.replace(/\D/g, '');
  const db = b.replace(/\D/g, '');
  return da.length >= 9 && db.length >= 9 ? da.slice(-9) === db.slice(-9) : da === db;
}
