/* Fechas de la Agenda en la zona horaria del negocio. Sin React, para que la rejilla semanal (escritorio) y la lista
   por días (móvil) agrupen las citas igual y se pueda probar aparte. */

/** Partes de una fecha en la zona horaria del negocio. */
export function tzParts(d: Date, timeZone: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
      .formatToParts(d)
      .map((p) => [p.type, p.value]),
  );
  const hour = Number(parts.hour) % 24;
  return { iso: `${parts.year}-${parts.month}-${parts.day}`, hour, minute: Number(parts.minute) };
}

export function addDaysIso(iso: string, days: number) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function weekdayOfIso(iso: string) {
  const wd = new Date(`${iso}T12:00:00Z`).getUTCDay();
  return wd === 0 ? 7 : wd; // ISO: 1 = lunes
}

/** Las citas de cada día de la semana (día según la zona del negocio), ordenadas por hora de inicio. */
export function appointmentsByDay<T extends { appointment: { startsAt: string } }>(days: string[], appts: T[], timeZone: string): { iso: string; appts: T[] }[] {
  return days.map((iso) => ({
    iso,
    appts: appts
      .filter((a) => tzParts(new Date(a.appointment.startsAt), timeZone).iso === iso)
      .sort((a, b) => Date.parse(a.appointment.startsAt) - Date.parse(b.appointment.startsAt)),
  }));
}

/** Título de un día en la lista del móvil: «Lunes, 5 de octubre» (solo la primera letra en mayúscula). */
export function dayTitle(iso: string) {
  const text = new Date(`${iso}T12:00:00Z`).toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
  return text.charAt(0).toUpperCase() + text.slice(1);
}
