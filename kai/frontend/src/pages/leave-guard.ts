/* Aviso de «cambios sin guardar» al salir de una pantalla (Agenda → Disponibilidad, Setter IA, Ajustes → Negocio). */
import { useEffect } from 'react';
import { useBlocker, type Path } from 'react-router';

/** ¿La navegación lleva a otra pantalla? Cambiar solo la pestaña (?tab=) o el #ancla no sale de la página. */
export function leavesPage(to: string | Partial<Path>, currentPathname: string): boolean {
  const pathname = typeof to === 'string' ? new URL(to, `http://kai.local${currentPathname}`).pathname : to.pathname;
  return Boolean(pathname) && pathname !== currentPathname;
}

/**
 * ¿Hay que preguntar antes de esta navegación? Con cambios sin guardar, cualquiera que salga de la pantalla: enlaces y
 * menú lateral, las que se hacen desde código (avisos de la campana, tarjetas de Copilot, botones) y también
 * Atrás/Adelante del navegador. Cambiar de pestaña (?tab=) no pregunta.
 */
export function shouldHoldNavigation(dirty: boolean, nav: { currentLocation: Pick<Path, 'pathname'>; nextLocation: Partial<Path> }): boolean {
  return dirty && leavesPage(nav.nextLocation, nav.currentLocation.pathname);
}

/**
 * Con cambios sin guardar: aviso del navegador al cerrar o recargar, y pregunta propia («¿Salir sin guardar?») al ir a
 * otra pantalla de la aplicación. `leaving` abre el diálogo; `leave` completa la navegación retenida y `stay` la descarta.
 * Usa useBlocker, que necesita el router de datos de main.tsx (createBrowserRouter + RouterProvider).
 */
export function useLeaveGuard(dirty: boolean) {
  const blocker = useBlocker((nav) => shouldHoldNavigation(dirty, nav));

  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);

  // Si los cambios dejan de estar pendientes con una navegación retenida (p. ej. se acaban de guardar), se deja pasar.
  useEffect(() => {
    if (blocker.state === 'blocked' && !dirty) blocker.proceed();
  }, [blocker, dirty]);

  return {
    leaving: blocker.state === 'blocked',
    leave: () => blocker.proceed?.(),
    stay: () => blocker.reset?.(),
  };
}
