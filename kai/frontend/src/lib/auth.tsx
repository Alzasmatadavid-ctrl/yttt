import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { api, getRequestBusiness, setRequestBusiness } from './api';
import type { Me } from './types';

interface AuthValue {
  me: Me | undefined;
  loading: boolean;
  refresh: () => Promise<unknown>;
  logout: () => Promise<void>;
  switchBusiness: (businessId: string) => Promise<void>;
  activeBusiness: Me['businesses'][number] | null;
  /**
   * Negocio al que se ha cambiado en OTRA pestaña (la sesión es común a todas). Esta pestaña sigue trabajando con el suyo
   * (activeBusiness), así que nunca se guarda nada en el negocio equivocado; la app solo lo avisa. null si no ha pasado.
   */
  otherTabBusiness: Me['businesses'][number] | null;
}

const AuthContext = createContext<AuthValue | null>(null);

/** Canal para avisar a las demás pestañas abiertas de que se ha cambiado de negocio. */
const CHANNEL = 'kai-session';

function openChannel(): BroadcastChannel | null {
  try {
    return typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(CHANNEL);
  } catch {
    return null;
  }
}

/** Descarta de la caché los datos del negocio anterior (se conserva la sesión, `me`). */
function forgetBusinessData(qc: QueryClient) {
  void qc.cancelQueries({ predicate: (q) => q.queryKey[0] !== 'me' });
  qc.removeQueries({ predicate: (q) => q.queryKey[0] !== 'me' });
}

/**
 * Decide con qué negocio trabaja esta pestaña a partir de la respuesta de /auth/me:
 * - la primera vez (o si aún no tenía ninguno), el negocio activo de la sesión;
 * - después se mantiene, aunque la sesión cambie de negocio desde otra pestaña;
 * - solo cambia si ya no se tiene acceso a él o si esta misma pestaña lo pide (adopt: entrar, aceptar una invitación…).
 */
function pinBusiness(data: Me | undefined, qc: QueryClient, adopt = false) {
  if (!data?.user) {
    setRequestBusiness(null);
    return;
  }
  const pinned = getRequestBusiness();
  const stillMember = pinned !== null && data.businesses.some((b) => b.businessId === pinned);
  if (stillMember && !adopt) return;
  const next = data.activeBusinessId ?? data.businesses[0]?.businessId ?? null;
  if (next === pinned) return;
  // Si esta pestaña ya trabajaba con otro negocio, lo que hubiera en caché era de ese negocio: no debe verse en el nuevo.
  if (pinned !== null) forgetBusinessData(qc);
  setRequestBusiness(next);
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const { data, isLoading, refetch } = useQuery({ queryKey: ['me'], queryFn: () => api.get<Me>('/auth/me'), staleTime: 60_000 });
  // Se fija durante el render (antes de que las pantallas pidan sus datos), para que la primera petición ya lleve la cabecera.
  pinBusiness(data, qc);
  const pinned = getRequestBusiness();
  const activeBusiness = data?.businesses.find((b) => b.businessId === pinned) ?? data?.businesses.find((b) => b.businessId === data.activeBusinessId) ?? data?.businesses[0] ?? null;
  const sessionBusiness = data?.activeBusinessId ? data.businesses.find((b) => b.businessId === data.activeBusinessId) ?? null : null;
  const otherTabBusiness = sessionBusiness && activeBusiness && sessionBusiness.businessId !== activeBusiness.businessId ? sessionBusiness : null;

  // Cuando otra pestaña cambia de negocio, se vuelve a pedir la sesión para poder avisar (sin cambiar el negocio de esta pestaña).
  const [, setTick] = useState(0);
  useEffect(() => {
    const channel = openChannel();
    if (!channel) return;
    channel.onmessage = (e: MessageEvent) => {
      if ((e.data as { type?: string } | null)?.type === 'business-switched') {
        void qc.invalidateQueries({ queryKey: ['me'] });
        setTick((t) => t + 1);
      }
    };
    return () => channel.close();
  }, [qc]);

  const value: AuthValue = {
    me: data,
    loading: isLoading,
    // Un refresco pedido por la propia pestaña (al entrar, crear un negocio o aceptar una invitación) sí adopta el negocio de la sesión.
    refresh: async () => {
      const r = await refetch();
      pinBusiness(r.data, qc, true);
      setTick((t) => t + 1);
      return r;
    },
    activeBusiness,
    otherTabBusiness,
    logout: async () => {
      await api.post('/auth/logout');
      qc.clear();
      setRequestBusiness(null);
      window.location.href = '/login';
    },
    switchBusiness: async (businessId) => {
      await api.post('/auth/switch-business', { businessId });
      const channel = openChannel();
      channel?.postMessage({ type: 'business-switched', businessId });
      channel?.close();
      qc.clear();
      setRequestBusiness(businessId);
      window.location.href = '/app';
    },
  };
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth fuera de AuthProvider');
  return ctx;
}
