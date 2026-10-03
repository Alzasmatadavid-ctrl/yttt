import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { useMutation } from '@tanstack/react-query';
import { LogIn } from 'lucide-react';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { Button, Field, Input } from '../../components/ui';
import AuthShell, { FormError, PasswordInput, isEmail, safeNext } from '../../components/AuthShell';

type Errors = Partial<Record<'email' | 'password', string>>;

export default function Login() {
  const { refresh } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const next = safeNext(params.get('next'));
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<Errors>({});

  const login = useMutation({
    mutationFn: () => api.post<{ ok: boolean }>('/auth/login', { email: email.trim(), password }),
    onSuccess: async () => {
      await refresh();
      navigate(next ?? '/app', { replace: true });
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const found: Errors = {};
    if (!email.trim()) found.email = 'Introduce tu email.';
    else if (!isEmail(email)) found.email = 'Revisa el email: parece que no está bien escrito.';
    if (!password) found.password = 'Introduce tu contraseña.';
    setErrors(found);
    if (Object.keys(found).length) return;
    login.mutate();
  };

  return (
    <AuthShell
      docTitle="Entrar"
      title="Entra en KAI"
      subtitle="Accede a tu bandeja, tus leads y tu agenda."
      footer={
        <>
          ¿Todavía no tienes cuenta? <Link to="/registro">Crear cuenta</Link>
        </>
      }
    >
      <form className="kai-form" onSubmit={submit} noValidate>
        <FormError error={login.error} />
        <Field label="Email" htmlFor="login-email" error={errors.email}>
          <Input
            id="login-email"
            type="email"
            inputMode="email"
            autoComplete="email"
            autoFocus
            maxLength={200}
            placeholder="tu@email.com"
            value={email}
            aria-invalid={Boolean(errors.email)}
            onChange={(e) => setEmail(e.target.value)}
          />
        </Field>
        <Field label="Contraseña" htmlFor="login-password" error={errors.password}>
          <PasswordInput
            id="login-password"
            autoComplete="current-password"
            value={password}
            aria-invalid={Boolean(errors.password)}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
        <div className="kai-inline-link">
          <Link to="/recuperar">¿Has olvidado tu contraseña?</Link>
        </div>
        <Button type="submit" variant="primary" size="lg" block icon={LogIn} loading={login.isPending}>
          Entrar
        </Button>
      </form>
    </AuthShell>
  );
}
