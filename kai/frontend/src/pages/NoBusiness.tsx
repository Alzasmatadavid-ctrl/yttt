/*
 * Pantalla para una cuenta con sesión iniciada que no pertenece a ningún negocio
 * (por ejemplo, un miembro al que han quitado del equipo). Sin ella, /app y /registro se redirigían entre sí sin fin.
 * Desde aquí la persona puede crear su propio negocio con esta misma cuenta (POST /auth/create-business).
 */
import { useId, useMemo, useState, type FormEvent } from 'react';
import { Link, Navigate } from 'react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Building2, House, LogOut, Plus, RefreshCw, Shield, UserX } from 'lucide-react';
import { useAuth } from '../lib/auth';
import { api, errorText } from '../lib/api';
import { Logo } from '../components/brand';
import { Button, Callout, Field, Input, PageLoading } from '../components/ui';
import { forgetPreviousSession, useDocumentTitle } from '../components/AuthShell';
import '../styles/auth.css';

/** Zona horaria del navegador (la misma detección que al crear una cuenta). */
function detectTimezone(): string | undefined {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return tz && tz.length <= 64 ? tz : undefined;
  } catch {
    return undefined;
  }
}

/** «Crear mi negocio»: nombre del negocio (y zona horaria del navegador). Al terminar, el onboarding. */
function CreateBusiness({ onCreated }: { onCreated: () => void }) {
  const qc = useQueryClient();
  const nameId = useId();
  const timezone = useMemo(detectTimezone, []);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [touched, setTouched] = useState(false);
  const clean = name.trim();
  const nameError = clean.length < 2 ? 'Escribe el nombre de tu negocio (mínimo 2 caracteres).' : clean.length > 120 ? 'Máximo 120 caracteres.' : null;

  const create = useMutation({
    mutationFn: () => api.post<{ business: { id: string; name: string } }>('/auth/create-business', { name: clean, ...(timezone ? { timezone } : {}) }),
    onSuccess: async () => {
      // Empieza un negocio nuevo: nada de lo que quedara en caché (de un negocio anterior) debe verse.
      forgetPreviousSession(qc);
      onCreated();
      await qc.invalidateQueries({ queryKey: ['me'] });
    },
    // 409: la cuenta ya pertenece a un negocio (p. ej., aceptó una invitación en otra pestaña): al recargar la sesión, entra en él.
    onError: () => void qc.invalidateQueries({ queryKey: ['me'] }),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (nameError || create.isPending) return;
    create.mutate();
  };

  if (!open) {
    return (
      <Button variant="primary" size="lg" icon={Building2} onClick={() => setOpen(true)}>
        Crear mi negocio
      </Button>
    );
  }
  return (
    <form className="kai-nobiz-create" onSubmit={submit} noValidate>
      <strong className="kai-nobiz-create-title">
        <Building2 aria-hidden /> Crea tu negocio en KAI
      </strong>
      <Field label="Nombre del negocio" htmlFor={nameId} error={touched ? nameError : null} hint="Si trabajas con tu propio nombre, también puedes usarlo aquí.">
        <Input id={nameId} value={name} maxLength={120} autoFocus placeholder="Ej.: Quema Grasa con Laura" autoComplete="organization" onChange={(e) => setName(e.target.value)} />
      </Field>
      {timezone && (
        <p className="xs muted">
          Zona horaria detectada: <strong>{timezone}</strong>. La usamos para tu agenda y tus recordatorios; puedes cambiarla después en Ajustes.
        </p>
      )}
      {create.error && (
        <div role="alert">
          <Callout tone="danger">{errorText(create.error)}</Callout>
        </div>
      )}
      <div className="kai-nobiz-create-actions">
        <Button
          onClick={() => {
            setOpen(false);
            setTouched(false);
            create.reset();
          }}
          disabled={create.isPending}
        >
          Cancelar
        </Button>
        <Button type="submit" variant="primary" icon={Plus} loading={create.isPending}>
          Crear mi negocio
        </Button>
      </div>
      <p className="xs subtle">Después te guiamos paso a paso para dejar a KAI listo para hablar con tus leads.</p>
    </form>
  );
}

export default function NoBusiness() {
  const { me, loading, refresh, logout } = useAuth();
  // Tras crear un negocio, la sesión ya tiene negocio: se va directamente al onboarding (no al panel).
  const [created, setCreated] = useState(false);
  const [checking, setChecking] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useDocumentTitle('Sin acceso a ningún negocio');

  if (loading) return <PageLoading />;
  if (!me?.user) return <Navigate to="/login" replace />;
  // Si mientras tanto ha recuperado el acceso (por ejemplo, aceptando una invitación en otra pestaña), vuelve a la app.
  if (me.businesses.length) return <Navigate to={created ? '/app/onboarding' : '/app'} replace />;
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
            <strong>¿Quieres usar KAI para tu propio negocio?</strong> Puedes crearlo ahora con esta misma cuenta: pulsa «Crear mi negocio».
          </li>
        </ul>
        <CreateBusiness onCreated={() => setCreated(true)} />
        {error && (
          <div role="alert">
            <Callout tone="danger">{error}</Callout>
          </div>
        )}
        <div className="kai-404-actions">
          <Button size="lg" icon={LogOut} loading={leaving} onClick={() => void leave()}>
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
