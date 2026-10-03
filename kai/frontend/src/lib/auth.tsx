import { createContext, useContext, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './api';
import type { Me } from './types';

interface AuthValue {
  me: Me | undefined;
  loading: boolean;
  refresh: () => Promise<unknown>;
  logout: () => Promise<void>;
  switchBusiness: (businessId: string) => Promise<void>;
  activeBusiness: Me['businesses'][number] | null;
}

const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const { data, isLoading, refetch } = useQuery({ queryKey: ['me'], queryFn: () => api.get<Me>('/auth/me'), staleTime: 60_000 });
  const activeBusiness = data?.businesses.find((b) => b.businessId === data.activeBusinessId) ?? data?.businesses[0] ?? null;
  const value: AuthValue = {
    me: data,
    loading: isLoading,
    refresh: () => refetch(),
    activeBusiness,
    logout: async () => {
      await api.post('/auth/logout');
      qc.clear();
      window.location.href = '/login';
    },
    switchBusiness: async (businessId) => {
      await api.post('/auth/switch-business', { businessId });
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
