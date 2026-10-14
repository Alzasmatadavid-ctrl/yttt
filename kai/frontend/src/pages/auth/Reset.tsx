import { useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useMutation } from '@tanstack/react-query';
import { CircleCheck, KeyRound, LogIn } from 'lucide-react';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { Button, Callout, Field } from '../../components/ui';
import AuthShell, { FormError, PasswordInput, PasswordRules, passwordIssue } from '../../components/AuthShell';

type Errors = Partial<Record<'password' | 'repeat', string>>;

export default function Reset() {
  const { refresh } = useAuth();
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const validToken = token.length >= 10 && token.length <= 200;
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [errors, setErrors] = useState<Errors>({});

  const reset = useMutation({
    mutationFn: () => api.post<{ ok: boolean }>('/auth/reset-password', { token, password }),
    // El servidor cierra todas las sesiones de la cuenta: actualizamos el estado de sesión del navegador.
    onSuccess: () => refresh(),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const found: Errors = {};
    const issue = passwordIssue(password);
    if (issue) found.password = issue;
    if (!repeat) found.repeat = 'Repite la contraseña.';
    else if (repeat !== password) found.repeat = 'Las contraseñas no coinciden.';
    setErrors(found);
    if (Object.keys(found).length) return;
    reset.mutate();
  };

  if (!validToken) {
    return (
      <AuthShell docTitle="Enlace no válido" title="Este enlace no es válido" subtitle="Puede que esté incompleto o que lo hayas copiado mal.">
        <div className="kai-form">
          <div role="alert">
            <Callout tone="danger">Para crear una contraseña nueva necesitas el enlace completo que te enviamos por email. Si ya no lo tienes, pide uno nuevo.</Callout>
          </div>
          <Link to="/recuperar" className="btn btn-primary btn-lg btn-block">
            Pedir un enlace nuevo
          </Link>
        </div>
      </AuthShell>
    );
  }

  if (reset.isSuccess) {
    return (
      <AuthShell docTitle="Contraseña actualizada" title="Contraseña actualizada" subtitle="Ya puedes entrar en KAI con tu nueva contraseña.">
        <div className="kai-form">
          <div role="status">
            <Callout tone="accent" icon={CircleCheck}>
              Por seguridad, hemos cerrado todas las sesiones abiertas de tu cuenta, también las de otros dispositivos.
            </Callout>
          </div>
          <Link to="/login" className="btn btn-primary btn-lg btn-block">
            <LogIn aria-hidden />
            Entrar con mi nueva contraseña
          </Link>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      docTitle="Nueva contraseña"
      title="Crea una contraseña nueva"
      subtitle="Elige una contraseña que no uses en otros sitios."
      footer={
        <>
          ¿El enlace ha caducado? <Link to="/recuperar">Pide uno nuevo</Link>
        </>
      }
    >
      <form className="kai-form" onSubmit={submit} noValidate>
        <FormError error={reset.error} />
        <Field label="Nueva contraseña" htmlFor="reset-password" error={errors.password}>
          <PasswordInput
            id="reset-password"
            autoComplete="new-password"
            autoFocus
            value={password}
            aria-invalid={Boolean(errors.password)}
            aria-describedby="reset-password-rules"
            onChange={(e) => setPassword(e.target.value)}
          />
          <PasswordRules id="reset-password-rules" value={password} />
        </Field>
        <Field label="Repite la contraseña" htmlFor="reset-repeat" error={errors.repeat}>
          <PasswordInput
            id="reset-repeat"
            autoComplete="new-password"
            value={repeat}
            aria-invalid={Boolean(errors.repeat)}
            onChange={(e) => setRepeat(e.target.value)}
          />
        </Field>
        <Button type="submit" variant="primary" size="lg" block icon={KeyRound} loading={reset.isPending}>
          Guardar contraseña
        </Button>
      </form>
    </AuthShell>
  );
}
