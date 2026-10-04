/*
 * Pantalla para una cuenta con sesión iniciada que no pertenece a ningún negocio
 * (por ejemplo, un miembro al que han quitado del equipo). Sin ella, /app y /registro se redirigían entre sí sin fin.
 */
import { useState } from 'react';
import { Link, Navigate } from 'react-router';
import { House, LogOut, RefreshCw, Shield, UserX } from 'lucide-react';
import { useAuth } from '../lib/auth';
import { errorText } from '../lib/api';
import { Logo } from '../components/brand';
import { Button, Callout, PageLoading } from '../components/ui';
import { useDocumentTitle } from '../components/AuthShell';
import '../styles/auth.css';

export default function NoBusiness() {
  const { me, loading, refresh, logout } = useAuth();
  const [checking, setChecking] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useDocumentTitle('Sin acceso a ningún negocio');

  if (loading) return <PageLoading />;
  if (!me?.user) return <Navigate to="/login" replace />;
  // Si mientras tanto ha recuperado el acceso (por ejemplo, aceptando una invitación en otra pestaña), vuelve a la app.
  if (me.businesses.length) return <Navigate to="/app" replace />;
  const isAdmin = me.user.platformRole === 'admin';

  const checkAgain = async () => {
    setChecking(true);
    setError(null);
    try {
      await refresh();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setChecking(false);
    }
  };

  const leave = async () => {
    setLeaving(true);
    setError(null);
    try {
      await logout();
    } catch (e) {
      setError(errorText(e));
      setLeaving(false);
    }
  };

  return (
    <div className="kai-404">
      <header className="kai-404-top">
        <Logo />
      </header>
      <main className="kai-404-body">
        <span className="kai-nobiz-icon" aria-hidden>
          <UserX />
        </span>
        <h1>Tu cuenta no tiene acceso a ningún negocio</h1>
        <p className="muted">
          Has entrado como <strong>{me.user.email}</strong>, pero esta cuenta ya no forma parte de ningún negocio de KAI. Suele pasar cuando la persona
          titular del negocio te quita de su equipo.
        </p>
        <ul className="kai-nobiz-list">
          <li>
            <strong>¿Te han vuelto a invitar?</strong> Abre el enlace del email de invitación y acéptala con esta misma cuenta. Después pulsa «Comprobar de
            nuevo».
          </li>
          <li>
            <strong>¿Crees que es un error?</strong> Pide a la persona titular del negocio que te envíe una invitación nueva desde Ajustes → Equipo.
          </li>
          <li>
            <strong>¿Quieres usar KAI para tu propio negocio?</strong> Cierra sesión y crea una cuenta nueva con otro email.
          </li>
        </ul>
        {error && (
          <div role="alert">
            <Callout tone="danger">{error}</Callout>
          </div>
        )}
        <div className="kai-404-actions">
          <Button variant="primary" size="lg" icon={LogOut} loading={leaving} onClick={() => void leave()}>
            Cerrar sesión
          </Button>
          <Button size="lg" icon={RefreshCw} loading={checking} onClick={() => void checkAgain()}>
            Comprobar de nuevo
          </Button>
          {isAdmin ? (
            <Link to="/admin" className="btn btn-lg">
              <Shield aria-hidden />
              Ir a Administración
            </Link>
          ) : (
            <Link to="/" className="btn btn-lg">
              <House aria-hidden />
              Ir al inicio
            </Link>
          )}
        </div>
      </main>
    </div>
  );
}
