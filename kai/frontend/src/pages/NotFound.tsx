import { Link } from 'react-router';
import { ArrowRight, House } from 'lucide-react';
import { useAuth } from '../lib/auth';
import { Logo } from '../components/brand';
import { useDocumentTitle } from '../components/AuthShell';
import '../styles/auth.css';

export default function NotFound() {
  const { me } = useAuth();
  useDocumentTitle('Página no encontrada');
  return (
    <div className="kai-404">
      <header className="kai-404-top">
        <Logo />
      </header>
      <main className="kai-404-body">
        <p className="kai-404-code" aria-hidden>
          404
        </p>
        <h1>
          <span className="sr-only">Error 404. </span>No encontramos esta página
        </h1>
        <p className="muted">Puede que el enlace esté mal escrito o que la página ya no exista. Desde aquí puedes volver a un sitio conocido.</p>
        <div className="kai-404-actions">
          <Link to="/" className="btn btn-lg">
            <House aria-hidden />
            Ir al inicio
          </Link>
          {me?.user ? (
            <Link to="/app" className="btn btn-primary btn-lg">
              Ir a la app
              <ArrowRight aria-hidden />
            </Link>
          ) : (
            <Link to="/login" className="btn btn-primary btn-lg">
              Entrar
              <ArrowRight aria-hidden />
            </Link>
          )}
        </div>
      </main>
    </div>
  );
}
