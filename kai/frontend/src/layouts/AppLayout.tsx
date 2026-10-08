import { useEffect, useRef, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeftRight,
  Ban,
  Bell,
  CalendarDays,
  ChartColumn,
  ChevronsUpDown,
  Plus,
  FlaskConical,
  Inbox,
  LayoutDashboard,
  LogOut,
  Menu,
  Moon,
  Plug,
  Settings,
  Shield,
  SlidersHorizontal,
  Sparkles,
  SquareKanban,
  Sun,
  Users,
  X,
} from 'lucide-react';
import { useAuth } from '../lib/auth';
import { api, errorText } from '../lib/api';
import { applyTheme, getTheme, type Theme } from '../lib/theme';
import { timeAgo } from '../lib/format';
import { Logo } from '../components/brand';
import { Button, Callout, ConfirmDialog, EmptyState, Field, Input, Modal, useToast } from '../components/ui';
import { ScoreBandsContext } from '../components/lead-bits';
import CopilotPanel from '../components/CopilotPanel';
import { useCan } from '../lib/business';
import type { Alert, SettingsResponse } from '../lib/types';
import { DEFAULT_SCORE_BANDS } from '@shared';

interface AlertRow {
  alert: Alert;
  leadName: string | null;
}

function AlertsMenu() {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const rootRef = useRef<HTMLDivElement>(null);
  const { data } = useQuery({ queryKey: ['alerts'], queryFn: () => api.get<{ alerts: AlertRow[] }>('/alerts'), refetchInterval: 20_000 });
  const resolve = useMutation({
    mutationFn: (id: string) => api.post(`/alerts/${id}/resolve`, { status: 'dismissed' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['alerts'] });
      void qc.invalidateQueries({ queryKey: ['dashboard'] });
    },
    onError: (e) => toast(errorText(e), 'error'),
  });
  // Cerrar al pulsar fuera o con Escape (un fondo “fixed” no sirve aquí: la barra superior usa backdrop-filter).
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent | TouchEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('touchstart', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('touchstart', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);
  const alerts = data?.alerts ?? [];
  const go = (row: AlertRow) => {
    setOpen(false);
    if (row.alert.type === 'call_outcome' && row.alert.leadId) navigate(`/app/leads/${row.alert.leadId}`);
    // «No hay huecos libres»: lo que hay que revisar es el horario, aunque el aviso venga de una conversación.
    else if (row.alert.type === 'no_availability') navigate('/app/agenda?tab=disponibilidad');
    else if (row.alert.conversationId) navigate(`/app/inbox/${row.alert.conversationId}`);
    else if (row.alert.leadId) navigate(`/app/leads/${row.alert.leadId}`);
    else if (row.alert.type === 'integration_error' || row.alert.type === 'delivery_blocked') navigate('/app/integraciones');
  };
  return (
    <div ref={rootRef} className="alerts-menu">
      <span style={{ position: 'relative', display: 'inline-flex' }}>
        <Button variant="ghost" iconOnly icon={Bell} onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-haspopup="true">
          {alerts.length ? `Avisos (${alerts.length})` : 'Avisos'}
        </Button>
        {alerts.length > 0 && (
          <span className="alerts-count" aria-hidden>
            {alerts.length}
          </span>
        )}
      </span>
      {open && (
        <div className="card alerts-dropdown" role="dialog" aria-label="Avisos">
          <div className="row-between" style={{ padding: '6px 8px 10px' }}>
            <strong>Avisos</strong>
            <span className="subtle small">{alerts.length === 1 ? '1 pendiente' : `${alerts.length} pendientes`}</span>
          </div>
          {alerts.length === 0 && <p className="muted small" style={{ padding: '8px 8px 12px' }}>Todo en orden. KAI te avisará aquí cuando necesite tu intervención.</p>}
          {alerts.map((row) => (
            <div key={row.alert.id} className="alerts-row">
              <span className={`badge ${row.alert.severity === 'critical' ? 'badge-danger' : row.alert.severity === 'warning' ? 'badge-warning' : 'badge-info'}`} style={{ marginTop: 2 }}>
                {row.alert.severity === 'critical' ? 'Urgente' : row.alert.severity === 'warning' ? 'Atención' : 'Aviso'}
              </span>
              <button type="button" className="alerts-row-main" onClick={() => go(row)}>
                <div style={{ fontWeight: 600 }}>
                  {row.alert.title}
                  {row.leadName && !row.alert.title.includes(row.leadName) ? ` · ${row.leadName}` : ''}
                </div>
                <div className="muted small">{row.alert.body}</div>
                <div className="subtle xs mt-4">{timeAgo(row.alert.createdAt)}</div>
              </button>
              <Button variant="ghost" size="sm" iconOnly icon={X} title="Descartar aviso" loading={resolve.isPending && resolve.variables === row.alert.id} onClick={() => resolve.mutate(row.alert.id)}>
                Descartar aviso
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function AppLayout() {
  const { me, activeBusiness, otherTabBusiness, logout, switchBusiness } = useAuth();
  const [menuOpen, setMenuOpen] = useState(false);
  const [copilotOpen, setCopilotOpen] = useState(false);
  // Aviso de «has cambiado de negocio en otra pestaña»: se puede ocultar (hasta el siguiente cambio).
  const [hiddenTabNotice, setHiddenTabNotice] = useState<string | null>(null);
  const [bizOpen, setBizOpen] = useState(false);
  const [theme, setTheme] = useState<Theme>(getTheme());
  const [confirmAutopilot, setConfirmAutopilot] = useState(false);
  const [newBizOpen, setNewBizOpen] = useState(false);
  const [newBizName, setNewBizName] = useState('');
  const location = useLocation();
  const qc = useQueryClient();
  const toast = useToast();

  useEffect(() => setMenuOpen(false), [location.pathname]);
  // Menú móvil: al abrirlo, el foco entra en él (primer enlace); al cerrarlo, vuelve al botón «Menú».
  const sidebarRef = useRef<HTMLElement>(null);
  const menuWasOpen = useRef(false);
  useEffect(() => {
    if (menuOpen) sidebarRef.current?.querySelector<HTMLElement>('.nav-link')?.focus();
    else if (menuWasOpen.current) document.querySelector<HTMLElement>('.topbar .menu-btn')?.focus();
    menuWasOpen.current = menuOpen;
  }, [menuOpen]);
  const bizRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!bizOpen) return;
    const onDown = (e: MouseEvent | TouchEvent) => {
      if (bizRef.current && !bizRef.current.contains(e.target as Node)) setBizOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setBizOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('touchstart', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('touchstart', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [bizOpen]);
  // Cerrar el menú móvil con Escape.
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setMenuOpen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [menuOpen]);
  // Cajón de Copilot: es un diálogo. Al abrirlo, el foco va al campo de la pregunta; se cierra con Escape (salvo que haya
  // un modal abierto encima, que se cierra primero) y, al cerrarlo, el foco vuelve al botón «Copilot» que lo abrió.
  const copilotRef = useRef<HTMLElement>(null);
  const copilotWasOpen = useRef(false);
  useEffect(() => {
    if (copilotOpen) {
      copilotRef.current?.querySelector<HTMLElement>('.copilot-input input')?.focus();
      const onKey = (e: KeyboardEvent) => {
        if (e.key === 'Escape' && !document.querySelector('.overlay')) setCopilotOpen(false);
      };
      window.addEventListener('keydown', onKey);
      copilotWasOpen.current = true;
      return () => window.removeEventListener('keydown', onKey);
    }
    if (copilotWasOpen.current) document.querySelector<HTMLElement>('.topbar .copilot-btn')?.focus();
    copilotWasOpen.current = false;
  }, [copilotOpen]);
  // Al ir a otra pantalla (p. ej. al pulsar un lead de una respuesta de Copilot), el cajón se cierra.
  useEffect(() => setCopilotOpen(false), [location.pathname]);

  // Con la cuenta suspendida el servidor rechaza todas las peticiones del negocio: no se piden datos.
  const suspended = activeBusiness?.status === 'suspended';
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => api.get<SettingsResponse>('/settings'), staleTime: 30_000, enabled: !suspended });
  const inbox = useQuery({ queryKey: ['inbox-counts'], queryFn: () => api.get<{ counts: Record<string, number> }>('/inbox', { filter: 'pending', limit: 1 }), refetchInterval: 20_000, enabled: !suspended });
  const autopilot = settings.data?.aiSettings.autopilotEnabled ?? true;
  // Pausar o reactivar a KAI cambia la configuración del negocio: solo la persona titular (rol Entrenador) puede hacerlo.
  const canToggleAutopilot = useCan('settings:write') && !suspended;
  const toggleAutopilot = useMutation({
    mutationFn: (enabled: boolean) => api.put('/settings/ai', { autopilotEnabled: enabled }),
    onSuccess: (_d, enabled) => {
      void qc.invalidateQueries({ queryKey: ['settings'] });
      // Lo que «necesita tu respuesta» depende de si KAI está contestando.
      void qc.invalidateQueries({ queryKey: ['inbox'] });
      void qc.invalidateQueries({ queryKey: ['inbox-counts'] });
      void qc.invalidateQueries({ queryKey: ['dashboard'] });
      toast(enabled ? 'KAI vuelve a responder automáticamente' : 'KAI en pausa: no responderá automáticamente');
      setConfirmAutopilot(false);
    },
    onError: (e) => toast(errorText(e), 'error'),
  });

  const createBusiness = useMutation({
    mutationFn: (name: string) => api.post<{ business: { id: string } }>('/businesses', { name }),
    onSuccess: () => {
      qc.clear();
      window.location.href = '/app/onboarding';
    },
    onError: (e) => toast(errorText(e), 'error'),
  });
  // Igual que el servidor: el límite del plan cuenta los negocios de la cuenta (el principal y los creados desde él).
  const canAddBusiness =
    activeBusiness?.role === 'trainer' && (activeBusiness.maxBusinesses === null || (activeBusiness.accountBusinesses ?? 1) < activeBusiness.maxBusinesses);
  const hasBizMenu = (me?.businesses.length ?? 0) > 1 || canAddBusiness;

  const pendingCount = inbox.data?.counts.pending ?? 0;
  const nav = [
    { to: '/app', label: 'Hoy', icon: LayoutDashboard, end: true },
    { to: '/app/inbox', label: 'Bandeja', icon: Inbox, count: pendingCount },
    { to: '/app/pipeline', label: 'Pipeline', icon: SquareKanban },
    { to: '/app/leads', label: 'Leads', icon: Users },
    { to: '/app/agenda', label: 'Agenda', icon: CalendarDays },
    { to: '/app/analitica', label: 'Analítica', icon: ChartColumn },
    { to: '/app/copilot', label: 'KAI Copilot', icon: Sparkles },
  ];
  const navKai = [
    { to: '/app/simulador', label: 'Simulador', icon: FlaskConical },
    { to: '/app/setter', label: 'Setter IA', icon: SlidersHorizontal },
    { to: '/app/integraciones', label: 'Integraciones', icon: Plug },
    { to: '/app/ajustes', label: 'Ajustes', icon: Settings },
  ];
  const mode = settings.data?.ai.mode;

  return (
    <div className="app-shell">
      {menuOpen && <div className="sidebar-backdrop" onClick={() => setMenuOpen(false)} />}
      <aside className={`sidebar ${menuOpen ? 'open' : ''}`} aria-label="Navegación principal" ref={sidebarRef}>
        <div className="sidebar-brand">
          <Logo to="/app" size={26} />
          <span className="badge badge-accent">Setter IA</span>
        </div>
        <div style={{ position: 'relative' }} ref={bizRef}>
          <button
            type="button"
            className="biz-switch"
            onClick={() => hasBizMenu && setBizOpen((o) => !o)}
            aria-expanded={hasBizMenu ? bizOpen : undefined}
            aria-haspopup={hasBizMenu ? 'true' : undefined}
            style={hasBizMenu ? undefined : { cursor: 'default' }}
            title={hasBizMenu ? 'Cambiar de negocio' : activeBusiness?.name}
          >
            <span className="biz-mark">{(activeBusiness?.name ?? 'K').slice(0, 2).toUpperCase()}</span>
            <span className="grow">
              <span className="ellipsis" style={{ display: 'block', fontWeight: 600 }}>
                {activeBusiness?.name}
              </span>
              <span className="subtle xs">{activeBusiness?.planName ?? 'Sin plan'}</span>
            </span>
            {hasBizMenu && <ChevronsUpDown size={15} className="subtle" />}
          </button>
          {bizOpen && hasBizMenu && (
            <div className="card" style={{ position: 'absolute', top: 54, left: 0, right: 0, zIndex: 5, padding: 6 }}>
              {me!.businesses.map((b) => (
                <button
                  key={b.businessId}
                  className={`nav-link ${b.businessId === activeBusiness?.businessId ? 'active' : ''}`}
                  style={{ width: '100%', border: 0, background: 'none', cursor: 'pointer' }}
                  onClick={() => (b.businessId === activeBusiness?.businessId ? setBizOpen(false) : switchBusiness(b.businessId).catch((e: unknown) => toast(errorText(e), 'error')))}
                >
                  {b.name}
                </button>
              ))}
              {canAddBusiness && (
                <button
                  className="nav-link"
                  style={{ width: '100%', border: 0, background: 'none', cursor: 'pointer' }}
                  onClick={() => {
                    setBizOpen(false);
                    setNewBizOpen(true);
                  }}
                >
                  <Plus aria-hidden />
                  Añadir negocio
                </button>
              )}
            </div>
          )}
        </div>
        {nav.map((n) => (
          <NavLink key={n.to} to={n.to} end={n.end} className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}>
            <n.icon aria-hidden />
            {n.label}
            {n.count ? <span className="nav-count">{n.count}</span> : null}
          </NavLink>
        ))}
        <div className="nav-section">KAI</div>
        {navKai.map((n) => (
          <NavLink key={n.to} to={n.to} className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}>
            <n.icon aria-hidden />
            {n.label}
          </NavLink>
        ))}
        {me?.user?.platformRole === 'admin' && (
          <NavLink to="/admin" className="nav-link">
            <Shield aria-hidden />
            Administración
          </NavLink>
        )}
        <div className="sidebar-footer">
          {canToggleAutopilot ? (
            <button className="kai-status" onClick={() => setConfirmAutopilot(true)} style={{ cursor: 'pointer', textAlign: 'left', color: 'inherit' }}>
              <span className={`pulse ${autopilot ? '' : 'off'}`} />
              <span className="grow">
                <span style={{ display: 'block', fontWeight: 600, fontSize: 13 }}>{autopilot ? 'KAI está activo' : 'KAI en pausa'}</span>
                <span className="subtle xs">{mode === 'simulated' ? 'Modo simulación (sin IA externa)' : autopilot ? 'Respondiendo a tus leads' : 'No responde automáticamente'}</span>
              </span>
            </button>
          ) : (
            <div className="kai-status" title={suspended ? undefined : 'Solo la persona titular del negocio puede pausar o reactivar a KAI.'}>
              <span className={`pulse ${autopilot && !suspended ? '' : 'off'}`} />
              <span className="grow">
                <span style={{ display: 'block', fontWeight: 600, fontSize: 13 }}>{suspended ? 'KAI detenido' : autopilot ? 'KAI está activo' : 'KAI en pausa'}</span>
                <span className="subtle xs">{suspended ? 'La cuenta está suspendida' : autopilot ? 'Respondiendo a los leads' : 'Pausado por la persona titular'}</span>
              </span>
            </div>
          )}
          <div className="row" style={{ padding: '4px 2px' }}>
            <div className="grow" style={{ minWidth: 0 }}>
              <div className="ellipsis small" style={{ fontWeight: 600 }}>
                {me?.user?.name}
              </div>
              <div className="ellipsis subtle xs">{me?.user?.email}</div>
            </div>
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              icon={theme === 'dark' ? Sun : Moon}
              onClick={() => {
                const next = theme === 'dark' ? 'light' : 'dark';
                applyTheme(next);
                setTheme(next);
              }}
            >
              Cambiar tema
            </Button>
            <Button variant="ghost" size="sm" iconOnly icon={LogOut} onClick={() => void logout()}>
              Cerrar sesión
            </Button>
          </div>
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <Button variant="ghost" iconOnly icon={Menu} className="menu-btn" onClick={() => setMenuOpen(true)}>
            Menú
          </Button>
          <div className="grow" />
          {!suspended && <AlertsMenu />}
          {!suspended && (
            <Button variant="primary" size="sm" icon={Sparkles} className="copilot-btn" onClick={() => setCopilotOpen(true)} aria-haspopup="dialog" aria-expanded={copilotOpen}>
              Copilot
            </Button>
          )}
        </header>
        {otherTabBusiness && activeBusiness && hiddenTabNotice !== otherTabBusiness.businessId && (
          <div className="tab-business-notice" role="status">
            <Callout tone="warning" icon={ArrowLeftRight}>
              <div className="row-between wrap" style={{ gap: 10 }}>
                <span>
                  Has cambiado a <strong>«{otherTabBusiness.name}»</strong> en otra pestaña. Esta pestaña sigue trabajando con <strong>«{activeBusiness.name}»</strong>: lo que
                  guardes aquí se guarda en «{activeBusiness.name}». Si recargas la página, se abrirá «{otherTabBusiness.name}».
                </span>
                <span className="row" style={{ gap: 6 }}>
                  <Button size="sm" onClick={() => setHiddenTabNotice(otherTabBusiness.businessId)}>
                    Seguir aquí
                  </Button>
                  <Button size="sm" variant="primary" onClick={() => switchBusiness(otherTabBusiness.businessId).catch((e: unknown) => toast(errorText(e), 'error'))}>
                    Ir a «{otherTabBusiness.name}»
                  </Button>
                </span>
              </div>
            </Callout>
          </div>
        )}
        {suspended ? (
          // Con la cuenta suspendida el servidor rechaza todas las pantallas: mejor explicarlo que dejar spinners o errores sueltos.
          <div className="page">
            <EmptyState
              icon={Ban}
              title="Esta cuenta está suspendida"
              description={`KAI no está respondiendo a los leads de «${activeBusiness?.name ?? 'este negocio'}» y no puedes consultar ni cambiar sus datos mientras dure la suspensión. Contacta con el equipo de soporte de KAI para reactivarla.`}
              action={
                <Button icon={LogOut} onClick={() => void logout()}>
                  Cerrar sesión
                </Button>
              }
            />
          </div>
        ) : (
          <ScoreBandsContext.Provider value={settings.data?.aiSettings.scoreBands ?? DEFAULT_SCORE_BANDS}>
            <Outlet />
          </ScoreBandsContext.Provider>
        )}
      </div>

      {copilotOpen && !suspended && (
        <>
          <div className="sidebar-backdrop" style={{ zIndex: 54 }} onClick={() => setCopilotOpen(false)} />
          <aside className="drawer" role="dialog" aria-modal="true" aria-labelledby="copilot-drawer-title" ref={copilotRef}>
            <div className="row-between" style={{ padding: '14px 16px', borderBottom: '1px solid var(--border)' }}>
              <div className="row">
                <Sparkles size={18} style={{ color: 'var(--accent-text)' }} aria-hidden />
                <strong id="copilot-drawer-title">KAI Copilot</strong>
              </div>
              <Button variant="ghost" size="sm" iconOnly icon={X} onClick={() => setCopilotOpen(false)}>
                Cerrar
              </Button>
            </div>
            <ScoreBandsContext.Provider value={settings.data?.aiSettings.scoreBands ?? DEFAULT_SCORE_BANDS}>
              <CopilotPanel compact />
            </ScoreBandsContext.Provider>
          </aside>
        </>
      )}

      <Modal
        open={newBizOpen}
        onClose={() => setNewBizOpen(false)}
        title="Añadir un negocio"
        footer={
          <>
            <Button variant="ghost" onClick={() => setNewBizOpen(false)}>
              Cancelar
            </Button>
            <Button variant="primary" loading={createBusiness.isPending} disabled={newBizName.trim().length < 2} onClick={() => createBusiness.mutate(newBizName.trim())}>
              Crear y configurar
            </Button>
          </>
        }
      >
        <p className="muted small" style={{ marginTop: 0 }}>
          Cada negocio tiene sus propios leads, conversaciones, agenda y configuración de KAI. Después te guiaremos para configurarlo.
        </p>
        <Field label="Nombre del negocio" htmlFor="new-business-name">
          <Input id="new-business-name" value={newBizName} onChange={(e) => setNewBizName(e.target.value)} placeholder="Ej.: Estudio Kaizen Madrid" autoFocus maxLength={120} />
        </Field>
      </Modal>

      <ConfirmDialog
        open={confirmAutopilot}
        title={autopilot ? '¿Pausar a KAI?' : '¿Reactivar a KAI?'}
        message={
          autopilot
            ? 'KAI dejará de responder automáticamente a todos los leads hasta que lo reactives. Los mensajes seguirán llegando a tu bandeja.'
            : 'KAI volverá a responder automáticamente a los leads en las conversaciones donde esté activo.'
        }
        confirmLabel={autopilot ? 'Pausar KAI' : 'Reactivar KAI'}
        danger={autopilot}
        loading={toggleAutopilot.isPending}
        onConfirm={() => toggleAutopilot.mutate(!autopilot)}
        onClose={() => setConfirmAutopilot(false)}
      />
    </div>
  );
}
