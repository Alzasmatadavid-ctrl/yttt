/* Datos del negocio activo que necesitan muchas pantallas: zona horaria y permisos del rol. */
import { useQuery } from '@tanstack/react-query';
import { ROLE_PERMISSIONS, type Permission } from '@shared';
import { api } from './api';
import { useAuth } from './auth';
import type { SettingsResponse } from './types';

/** Ajustes del negocio (misma clave de caché que el resto de la app: se piden una sola vez). */
export function useBusinessSettings() {
  return useQuery({ queryKey: ['settings'], queryFn: () => api.get<SettingsResponse>('/settings'), staleTime: 30_000 });
}

/**
 * Zona horaria del negocio. Las horas de llamadas y seguimientos se muestran siempre en ella
 * (igual que en Agenda y en Hoy), aunque el entrenador abra KAI desde otra zona.
 * Mientras no se conoce, devuelve undefined y se usa la zona del navegador.
 */
export function useBusinessTimezone(): string | undefined {
  return useBusinessSettings().data?.business.timezone;
}

/** ¿Puede el usuario hacer esta acción en el negocio activo? (mismo reparto de permisos que el servidor). */
export function useCan(permission: Permission): boolean {
  const { activeBusiness } = useAuth();
  if (!activeBusiness) return false;
  return ROLE_PERMISSIONS[activeBusiness.role]?.includes(permission) ?? false;
}
