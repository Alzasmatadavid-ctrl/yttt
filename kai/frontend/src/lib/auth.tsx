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
  /** Negocio con el que trabaja esta pestaña (todas sus peticiones van a él). */
  activeBusiness: Me['businesses'][number] | null;
  /**
   * Negocio al que se ha cambiado desde OTRA pestaña (la sesión es común a todas). Esta pestaña sigue trabajando con el
   * suyo (activeBusiness), así que nunca guarda nada en el negocio equivocado; la app solo lo avisa. null si no ha pasado.
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

/** Negocio activo de la sesión según /auth/me (el que abriría una pestaña nueva). */
const sessionBusinessId = (data: Me) => data.activeBusinessId ?? data.businesses[0]?.businessId ?? null;

/**
 * Esta pestaña pasa a trabajar con el negocio activo de la sesión. Si ya trabajaba con otro, se descarta lo que hubiera
 * en caché (era de ese otro negocio y no debe verse, ni un instante, en el nuevo). Se conserva la sesión (`me`).
 */
function adoptSessionBusiness(data: Me | undefined, qc: QueryClient): boolean {
  const next = data?.user ? sessionBusinessId(data) : null;
  const previous = getRequestBusiness();
  if (next === previous) return false;
  if (previous !== null) {
    void qc.cancelQueries({ predicate: (q) => q.queryKey[0] !== 'me' });
    qc.removeQueries({ predicate: (q) => q.queryKey[0] !== 'me' });
  }
  setRequestBusiness(next);
  return true;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [, rerender] = useState(0);
  const { data, isLoading, refetch } = useQuery({ queryKey: ['me'], queryFn: () => api.get<Me>('/auth/me'), staleTime: 60_000 });

  // El negocio de la pestaña se fija con el primer /auth/me que tenga negocio, durante el render: así la primera petición
  // de cualquier pantalla ya sale con la cabecera. Después se mantiene aunque otra pestaña cambie el negocio de la sesión.
  if (data?.user && getRequestBusiness() === null && sessionBusinessId(data)) setRequestBusiness(sessionBusinessId(data));
  const pinned = getRequestBusiness();
  // Si se ha perdido el acceso a ese negocio (te han quitado del equipo, se cerró la sesión…), se pasa al de la sesión.
  // (Mientras /auth/me no ha respondido nunca, data es undefined: eso no es perder el acceso.)
  const lostPinned = pinned !== null && data !== undefined && (!data.user || !data.businesses.some((b) => b.businessId === pinned));
  useEffect(() => {
    if (lostPinned && adoptSessionBusiness(data, qc)) rerender((n) => n + 1);
  }, [lostPinned, data, qc]);

  // Cuando otra pestaña cambia de negocio, se vuelve a pedir la sesión para poder avisar (sin tocar el negocio de esta).
  useEffect(() => {
    const channel = openChannel();
    if (!channel) return;
    channel.onmessage = (e: MessageEvent) => {
      if ((e.data as { type?: string } | null)?.type === 'business-switched') void qc.invalidateQueries({ queryKey: ['me'] });
    };
    return () => channel.close();
  }, [qc]);

  const businesses = data?.businesses ?? [];
  const activeBusiness = businesses.find((b) => b.businessId === pinned) ?? businesses.find((b) => b.businessId === data?.activeBusinessId) ?? businesses[0] ?? null;
  const sessionBusiness = data?.activeBusinessId ? businesses.find((b) => b.businessId === data.activeBusinessId) ?? null : null;
  const otherTabBusiness = sessionBusiness && activeBusiness && sessionBusiness.businessId !== activeBusiness.businessId ? sessionBusiness : null;

  const value: AuthValue = {
    me: data,
    loading: isLoading,
    // Un refresco que pide la propia pestaña (al entrar, crear un negocio o aceptar una invitación) sí adopta el negocio de la sesión.
    refresh: async () => {
      const r = await refetch();
      if (adoptSessionBusiness(r.data, qc)) rerender((n) => n + 1);
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
      // Las demás pestañas siguen con su negocio, pero lo saben y pueden avisar.
      const channel = openChannel();
      channel?.postMessage({ type: 'business-switched', businessId });
      channel?.close();
      qc.clear();
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
