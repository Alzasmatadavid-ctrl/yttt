/* Estructura del panel de administración (propietario de KAI): barra lateral propia + contenido. */
import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router';
import { ArrowLeft, Building2, CreditCard, LayoutDashboard, LogOut, Menu, Moon, ScrollText, Shield, Sun, Users, X } from 'lucide-react';
import { useAuth } from '../lib/auth';
import { applyTheme, getTheme, type Theme } from '../lib/theme';
import { Logo } from '../components/brand';
import { Button } from '../components/ui';
import '../styles/admin.css';

const NAV = [
  { to: '/admin', label: 'Resumen', icon: LayoutDashboard, end: true },
  { to: '/admin/negocios', label: 'Negocios', icon: Building2 },
  { to: '/admin/usuarios', label: 'Usuarios', icon: Users },
  { to: '/admin/planes', label: 'Planes', icon: CreditCard },
  { to: '/admin/registros', label: 'Registros', icon: ScrollText },
];

export default function AdminLayout() {
  const { me, activeBusiness, logout } = useAuth();
  const [menuOpen, setMenuOpen] = useState(false);
  const [theme, setTheme] = useState<Theme>(getTheme());
  const location = useLocation();

  useEffect(() => setMenuOpen(false), [location.pathname]);

  return (
    <div className="app-shell">
      {menuOpen && <div className="sidebar-backdrop" onClick={() => setMenuOpen(false)} />}
      <aside id="admin-sidebar" className={`sidebar ${menuOpen ? 'open' : ''}`} aria-label="Navegación de administración">
        <div className="sidebar-brand">
          <Logo to="/admin" size={26} />
          <div className="row" style={{ gap: 4 }}>
            <span className="badge badge-violet">Admin</span>
            {menuOpen && (
              <Button variant="ghost" size="sm" iconOnly icon={X} className="hide-desktop" onClick={() => setMenuOpen(false)}>
                Cerrar menú
              </Button>
            )}
          </div>
        </div>
        <p className="subtle xs adm-sidebar-intro">Panel del propietario de KAI: negocios, usuarios, planes y salud del sistema.</p>

        <div className="nav-section">Administración</div>
        {NAV.map((n) => (
          <NavLink key={n.to} to={n.to} end={n.end} className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}>
            <n.icon aria-hidden />
            {n.label}
          </NavLink>
        ))}

        {activeBusiness && (
          <>
            <div className="nav-section">Tu negocio</div>
            <NavLink to="/app" className="nav-link adm-back-link" title={`Volver a ${activeBusiness.name}`}>
              <ArrowLeft aria-hidden />
              Volver a la app
              <span className="subtle xs ellipsis adm-back-sub">{activeBusiness.name}</span>
            </NavLink>
          </>
        )}

        <div className="sidebar-footer">
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
              {theme === 'dark' ? 'Cambiar a tema claro' : 'Cambiar a tema oscuro'}
            </Button>
            <Button variant="ghost" size="sm" iconOnly icon={LogOut} onClick={() => void logout()}>
              Cerrar sesión
            </Button>
          </div>
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <Button variant="ghost" iconOnly icon={Menu} className="menu-btn" aria-controls="admin-sidebar" aria-expanded={menuOpen} onClick={() => setMenuOpen(true)}>
            Abrir menú
          </Button>
          <div className="adm-topbar-title">
            <Shield aria-hidden />
            <span className="ellipsis">Panel de administración</span>
          </div>
          <div className="grow" />
          <span className="subtle xs ellipsis" style={{ maxWidth: 260 }}>
            Tienes acceso a los datos de todos los negocios
          </span>
        </header>
        <Outlet />
      </div>
    </div>
  );
}
