/* Pestaña «Tu cuenta»: datos de acceso, cambio de contraseña, apariencia y cierre de sesión. */
import { useId, useState, type FormEvent } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Eye, EyeOff, KeyRound, LogOut, Moon, Palette, Sun, UserRound } from 'lucide-react';
import { ROLE_LABELS } from '@shared';
import { api, errorText } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { applyTheme, getTheme, type Theme } from '../../lib/theme';
import { Button, Callout, Card, Field, Input, Segmented, useToast } from '../../components/ui';

const MIN_PASSWORD = 10;

/** Mismas reglas que el servidor: mínimo 10 caracteres, letras y números. */
function passwordProblem(pw: string): string | null {
  if (pw.length < MIN_PASSWORD) return `Debe tener al menos ${MIN_PASSWORD} caracteres.`;
  if (pw.length > 200) return 'Es demasiado larga (máximo 200 caracteres).';
  if (!/[a-zA-Z]/.test(pw) || !/[0-9]/.test(pw)) return 'Debe combinar letras y números.';
  return null;
}

/** Campo de contraseña con botón para mostrarla u ocultarla. */
function PasswordInput({ id, value, onChange, autoComplete, invalid, describedBy }: { id: string; value: string; onChange: (v: string) => void; autoComplete: string; invalid?: boolean; describedBy?: string }) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="settings-password">
      <Input
        id={id}
        type={visible ? 'text' : 'password'}
        value={value}
        autoComplete={autoComplete}
        maxLength={200}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        onChange={(e) => onChange(e.target.value)}
      />
      <Button variant="ghost" size="sm" iconOnly icon={visible ? EyeOff : Eye} title={visible ? 'Ocultar' : 'Mostrar'} onClick={() => setVisible((v) => !v)}>
        {visible ? 'Ocultar contraseña' : 'Mostrar contraseña'}
      </Button>
    </div>
  );
}

function PasswordCard({ email }: { email: string }) {
  const toast = useToast();
  const ids = { current: useId(), next: useId(), confirm: useId(), rules: useId() };
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  const errors = {
    current: !current ? 'Escribe tu contraseña actual.' : null,
    next: passwordProblem(next) ?? (next && next === current ? 'La nueva contraseña debe ser distinta de la actual.' : null),
    confirm: !confirm ? 'Repite la nueva contraseña.' : confirm !== next ? 'Las contraseñas no coinciden.' : null,
  };
  const hasErrors = Boolean(errors.current || errors.next || errors.confirm);
  const checks = [
    { ok: next.length >= MIN_PASSWORD, label: `Al menos ${MIN_PASSWORD} caracteres` },
    { ok: /[a-zA-Z]/.test(next), label: 'Alguna letra' },
    { ok: /[0-9]/.test(next), label: 'Algún número' },
  ];

  const change = useMutation({
    mutationFn: () => api.post('/auth/change-password', { currentPassword: current, newPassword: next }),
    onSuccess: () => {
      setCurrent('');
      setNext('');
      setConfirm('');
      setSubmitted(false);
      setServerError(null);
      toast('Contraseña actualizada. Hemos cerrado tus sesiones abiertas en otros dispositivos.');
    },
    onError: (e) => {
      const msg = errorText(e);
      setServerError(msg);
      toast(msg, 'error');
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setSubmitted(true);
    setServerError(null);
    if (hasErrors || change.isPending) return;
    change.mutate();
  };

  return (
    <Card title="Cambiar contraseña" icon={KeyRound}>
      <form className="col gap-16" onSubmit={submit} noValidate>
        {/* Campo oculto para que los gestores de contraseñas asocien el cambio a tu usuario. */}
        <input type="text" name="username" autoComplete="username" value={email} readOnly hidden />
        <div className="grid-3">
          <Field label="Contraseña actual" htmlFor={ids.current} error={submitted ? errors.current : null}>
            <PasswordInput id={ids.current} value={current} onChange={setCurrent} autoComplete="current-password" invalid={submitted && Boolean(errors.current)} />
          </Field>
          <Field label="Nueva contraseña" htmlFor={ids.next} error={(submitted || next.length >= MIN_PASSWORD) && errors.next ? errors.next : null}>
            <PasswordInput id={ids.next} value={next} onChange={setNext} autoComplete="new-password" invalid={submitted && Boolean(errors.next)} describedBy={ids.rules} />
          </Field>
          <Field label="Repite la nueva contraseña" htmlFor={ids.confirm} error={(submitted || (confirm.length > 0 && confirm.length >= next.length)) && errors.confirm ? errors.confirm : null}>
            <PasswordInput id={ids.confirm} value={confirm} onChange={setConfirm} autoComplete="new-password" invalid={submitted && Boolean(errors.confirm)} />
          </Field>
        </div>
        <ul className="settings-pw-rules" id={ids.rules} aria-label="Requisitos de la nueva contraseña">
          {checks.map((c) => (
            <li key={c.label} className={c.ok ? 'ok' : undefined}>
              <span className="settings-pw-dot" aria-hidden />
              {c.label}
              <span className="sr-only">{c.ok ? ' (cumplido)' : ' (pendiente)'}</span>
            </li>
          ))}
        </ul>
        {serverError && <Callout tone="danger">{serverError}</Callout>}
        <div className="settings-actions" style={{ marginTop: 0 }}>
          <p className="grow subtle xs">Por seguridad, al cambiarla cerraremos tus sesiones abiertas en otros dispositivos. En este seguirás conectado.</p>
          <Button type="submit" variant="primary" size="sm" icon={KeyRound} loading={change.isPending}>
            Cambiar contraseña
          </Button>
        </div>
      </form>
    </Card>
  );
}

export default function AccountTab() {
  const { me, activeBusiness, logout } = useAuth();
  const [theme, setTheme] = useState<Theme>(() => getTheme());
  const [loggingOut, setLoggingOut] = useState(false);
  const toast = useToast();
  const user = me?.user;

  const changeTheme = (t: Theme) => {
    applyTheme(t);
    setTheme(t);
  };

  const signOut = async () => {
    setLoggingOut(true);
    try {
      await logout();
    } catch (e) {
      setLoggingOut(false);
      toast(errorText(e), 'error');
    }
  };

  return (
    <>
      <Card title="Tus datos" icon={UserRound}>
        <dl className="kv settings-kv">
          <dt>Nombre</dt>
          <dd>{user?.name || '—'}</dd>
          <dt>Email</dt>
          <dd>{user?.email || '—'}</dd>
          <dt>Negocio activo</dt>
          <dd>{activeBusiness?.name ?? '—'}</dd>
          <dt>Tu rol</dt>
          <dd>{activeBusiness ? <span className={`badge ${activeBusiness.role === 'trainer' ? 'badge-accent' : 'badge-info'}`}>{ROLE_LABELS[activeBusiness.role]}</span> : '—'}</dd>
        </dl>
        <p className="subtle xs mt-12">El nombre y el email con los que entras en KAI no se pueden cambiar desde aquí. Si necesitas cambiarlos, contacta con el equipo de soporte de KAI.</p>
      </Card>

      <PasswordCard email={user?.email ?? ''} />

      <div className="grid-2">
        <Card title="Apariencia" icon={Palette}>
          <div className="col gap-12">
            <p className="muted small">Elige cómo quieres ver KAI en este dispositivo. El cambio se aplica al momento.</p>
            <div>
              <Segmented<Theme>
                value={theme}
                onChange={changeTheme}
                options={[
                  { value: 'dark', label: 'Oscuro' },
                  { value: 'light', label: 'Claro' },
                ]}
              />
            </div>
            <p className="subtle xs row" style={{ gap: 6 }}>
              {theme === 'dark' ? <Moon size={14} aria-hidden /> : <Sun size={14} aria-hidden />}
              {theme === 'dark' ? 'Tema oscuro activo: más descansado para la vista con poca luz.' : 'Tema claro activo: más legible a pleno sol o con mucha luz.'}
            </p>
          </div>
        </Card>

        <Card title="Sesión" icon={LogOut}>
          <div className="col gap-12">
            <p className="muted small">Cierra la sesión en este dispositivo. Para volver a entrar necesitarás tu email y tu contraseña.</p>
            <div>
              <Button icon={LogOut} loading={loggingOut} onClick={() => void signOut()}>
                Cerrar sesión
              </Button>
            </div>
          </div>
        </Card>
      </div>
    </>
  );
}
