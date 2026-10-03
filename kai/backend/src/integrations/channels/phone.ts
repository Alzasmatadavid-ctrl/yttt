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
