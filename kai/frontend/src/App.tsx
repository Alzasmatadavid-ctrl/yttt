import { lazy, Suspense, type ReactNode } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router';
import { useAuth } from './lib/auth';
import { PageLoading } from './components/ui';
import { safeNext } from './lib/nav';
import AppLayout from './layouts/AppLayout';
import AdminLayout from './layouts/AdminLayout';

const Landing = lazy(() => import('./pages/Landing'));
const Login = lazy(() => import('./pages/auth/Login'));
const Register = lazy(() => import('./pages/auth/Register'));
const Forgot = lazy(() => import('./pages/auth/Forgot'));
const Reset = lazy(() => import('./pages/auth/Reset'));
const Invitation = lazy(() => import('./pages/auth/Invitation'));
const Onboarding = lazy(() => import('./pages/Onboarding'));
const Dashboard = lazy(() => import('./pages/Dashboard'));
const Inbox = lazy(() => import('./pages/Inbox'));
const Pipeline = lazy(() => import('./pages/Pipeline'));
const LeadDetail = lazy(() => import('./pages/LeadDetail'));
const Leads = lazy(() => import('./pages/Leads'));
const Agenda = lazy(() => import('./pages/Agenda'));
const Analytics = lazy(() => import('./pages/Analytics'));
const CopilotPage = lazy(() => import('./pages/CopilotPage'));
const Simulator = lazy(() => import('./pages/Simulator'));
const SetterSettings = lazy(() => import('./pages/setter/SetterSettings'));
const Integrations = lazy(() => import('./pages/Integrations'));
const Settings = lazy(() => import('./pages/settings/Settings'));
const AdminOverview = lazy(() => import('./pages/admin/AdminOverview'));
const AdminBusinesses = lazy(() => import('./pages/admin/AdminBusinesses'));
const AdminBusinessDetail = lazy(() => import('./pages/admin/AdminBusinessDetail'));
const AdminUsers = lazy(() => import('./pages/admin/AdminUsers'));
const AdminPlans = lazy(() => import('./pages/admin/AdminPlans'));
const AdminLogs = lazy(() => import('./pages/admin/AdminLogs'));
const NotFound = lazy(() => import('./pages/NotFound'));
const NoBusiness = lazy(() => import('./pages/NoBusiness'));
const Legal = lazy(() => import('./pages/Legal'));

/** Páginas que se pueden abrir con el onboarding a medias (los pasos 13 y 14 llevan a Integraciones, y Google vuelve allí). */
const OPEN_DURING_ONBOARDING = ['/app/integraciones'];

/**
 * Pantalla para una cuenta con sesión que no pertenece a ningún negocio (p. ej., un miembro al que han quitado del equipo).
 * No puede ser /registro: está reservada a quien no tiene sesión y devolvería a /app, que a su vez mandaría aquí (bucle).
 */
const NO_BUSINESS_PATH = '/sin-negocio';

function RequireAuth({ children, allowOnboarding }: { children: ReactNode; allowOnboarding?: boolean }) {
  const { me, loading, activeBusiness } = useAuth();
  const location = useLocation();
  if (loading) return <PageLoading />;
  if (!me?.user) return <Navigate to={`/login?next=${encodeURIComponent(location.pathname + location.search)}`} replace />;
  if (!activeBusiness) {
    return me.user.platformRole === 'admin' ? <Navigate to="/admin" replace /> : <Navigate to={NO_BUSINESS_PATH} replace />;
  }
  // Cuenta suspendida: el servidor rechaza (403) todo lo del negocio, también el onboarding. Se deja pasar a AppLayout,
  // que muestra el aviso de cuenta suspendida, y si se abre el onboarding se lleva allí en vez de mostrar errores.
  if (activeBusiness.status === 'suspended') return allowOnboarding ? <Navigate to="/app" replace /> : <>{children}</>;
  const openDuringOnboarding = allowOnboarding || OPEN_DURING_ONBOARDING.some((p) => location.pathname.startsWith(p));
  if (!openDuringOnboarding && !activeBusiness.onboardingCompletedAt && activeBusiness.role === 'trainer') return <Navigate to="/app/onboarding" replace />;
  return <>{children}</>;
}

function RequireAdmin({ children }: { children: ReactNode }) {
  const { me, loading } = useAuth();
  if (loading) return <PageLoading />;
  if (!me?.user) return <Navigate to="/login?next=/admin" replace />;
  if (me.user.platformRole !== 'admin') return <Navigate to="/app" replace />;
  return <>{children}</>;
}

function GuestOnly({ children }: { children: ReactNode }) {
  const { me, loading } = useAuth();
  const location = useLocation();
  if (loading) return <PageLoading />;
  if (me?.user) {
    const next = safeNext(new URLSearchParams(location.search).get('next'));
    const fallback = me.businesses.length ? '/app' : me.user.platformRole === 'admin' ? '/admin' : NO_BUSINESS_PATH;
    return <Navigate to={next ?? fallback} replace />;
  }
  return <>{children}</>;
}

export default function App() {
  return (
    <Suspense fallback={<PageLoading />}>
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="/login" element={<GuestOnly><Login /></GuestOnly>} />
        <Route path="/registro" element={<GuestOnly><Register /></GuestOnly>} />
        <Route path="/recuperar" element={<Forgot />} />
        <Route path="/restablecer" element={<Reset />} />
        <Route path="/invitacion" element={<Invitation />} />
        <Route path={NO_BUSINESS_PATH} element={<NoBusiness />} />
        <Route path="/privacidad" element={<Legal />} />
        <Route path="/terminos" element={<Legal />} />
        <Route path="/app/onboarding" element={<RequireAuth allowOnboarding><Onboarding /></RequireAuth>} />
        <Route path="/app" element={<RequireAuth><AppLayout /></RequireAuth>}>
          <Route index element={<Dashboard />} />
          <Route path="inbox" element={<Inbox />} />
          <Route path="inbox/:conversationId" element={<Inbox />} />
          <Route path="pipeline" element={<Pipeline />} />
          <Route path="leads" element={<Leads />} />
          <Route path="leads/:leadId" element={<LeadDetail />} />
          <Route path="agenda" element={<Agenda />} />
          <Route path="analitica" element={<Analytics />} />
          <Route path="copilot" element={<CopilotPage />} />
          <Route path="simulador" element={<Simulator />} />
          <Route path="simulador/:conversationId" element={<Simulator />} />
          <Route path="setter" element={<SetterSettings />} />
          <Route path="integraciones" element={<Integrations />} />
          <Route path="ajustes" element={<Settings />} />
        </Route>
        <Route path="/admin" element={<RequireAdmin><AdminLayout /></RequireAdmin>}>
          <Route index element={<AdminOverview />} />
          <Route path="negocios" element={<AdminBusinesses />} />
          <Route path="negocios/:id" element={<AdminBusinessDetail />} />
          <Route path="usuarios" element={<AdminUsers />} />
          <Route path="planes" element={<AdminPlans />} />
          <Route path="registros" element={<AdminLogs />} />
        </Route>
        <Route path="*" element={<NotFound />} />
      </Routes>
    </Suspense>
  );
}
