import { lazy, Suspense, type ReactNode } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router';
import { useAuth } from './lib/auth';
import { PageLoading } from './components/ui';
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

function RequireAuth({ children, allowOnboarding }: { children: ReactNode; allowOnboarding?: boolean }) {
  const { me, loading, activeBusiness } = useAuth();
  const location = useLocation();
  if (loading) return <PageLoading />;
  if (!me?.user) return <Navigate to={`/login?next=${encodeURIComponent(location.pathname + location.search)}`} replace />;
  if (!activeBusiness) {
    return me.user.platformRole === 'admin' ? <Navigate to="/admin" replace /> : <Navigate to="/registro" replace />;
  }
  if (!allowOnboarding && !activeBusiness.onboardingCompletedAt && activeBusiness.role === 'trainer') return <Navigate to="/app/onboarding" replace />;
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
  if (loading) return <PageLoading />;
  if (me?.user) return <Navigate to={me.businesses.length ? '/app' : me.user.platformRole === 'admin' ? '/admin' : '/app'} replace />;
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
