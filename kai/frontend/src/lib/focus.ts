/*
 * Foco retenido en un diálogo (Modal): con Tab y Mayús+Tab se pasa del último control al primero y al revés, sin salir
 * al menú ni a la página que queda detrás del fondo oscuro.
 */

/**
 * Control al que hay que llevar el foco al pulsar Tab (shift = Mayús+Tab), o null si el navegador puede moverlo solo
 * porque el siguiente control sigue dentro del diálogo.
 * focusables: controles del diálogo en orden; active: el que tiene el foco; inside: si el foco está dentro del diálogo.
 */
export function focusTrapTarget<T>(focusables: readonly T[], active: T | null, inside: boolean, shift: boolean): T | null {
  if (focusables.length === 0) return null;
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  // El foco está fuera del diálogo (o en algo que no es un control, como el propio diálogo): se vuelve a meter.
  if (!inside || active === null || !focusables.includes(active)) return shift ? last : first;
  if (shift && active === first) return last;
  if (!shift && active === last) return first;
  return null;
}
