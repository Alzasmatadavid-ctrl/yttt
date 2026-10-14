import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { useMutation } from '@tanstack/react-query';
import { MailCheck, Send } from 'lucide-react';
import { api } from '../../lib/api';
import { Button, Callout, Field, Input } from '../../components/ui';
import AuthShell, { FormError, isEmail } from '../../components/AuthShell';

export default function Forgot() {
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);

  const forgot = useMutation({
    mutationFn: () => api.post<{ ok: boolean; message: string }>('/auth/forgot-password', { email: email.trim() }),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!email.trim()) return setError('Introduce tu email.');
    if (!isEmail(email)) return setError('Revisa el email: parece que no está bien escrito.');
    setError(null);
    forgot.mutate();
  };

  return (
    <AuthShell
      docTitle="Recuperar contraseña"
      title="Recupera tu contraseña"
      subtitle="Te enviaremos un enlace por email para que crees una contraseña nueva."
      footer={
        <>
          ¿Ya la recuerdas? <Link to="/login">Entrar</Link>
        </>
      }
    >
      {forgot.isSuccess ? (
        <div className="kai-form">
          <div role="status">
            <Callout tone="accent" icon={MailCheck}>
              {forgot.data.message || 'Si existe una cuenta con ese email, te hemos enviado un enlace para restablecer la contraseña.'}
            </Callout>
          </div>
          <p className="muted small">El enlace caduca al cabo de una hora. Si no ves el email en unos minutos, revisa la carpeta de correo no deseado.</p>
          <Link to="/login" className="btn btn-primary btn-lg btn-block">
            Volver a entrar
          </Link>
          <Button variant="ghost" block onClick={() => forgot.reset()}>
            Probar con otro email
          </Button>
        </div>
      ) : (
        <form className="kai-form" onSubmit={submit} noValidate>
          <FormError error={forgot.error} />
          <Field label="Email de tu cuenta" htmlFor="forgot-email" error={error}>
            <Input
              id="forgot-email"
              type="email"
              inputMode="email"
              autoComplete="email"
              autoFocus
              maxLength={200}
              placeholder="tu@email.com"
              value={email}
              aria-invalid={Boolean(error)}
              onChange={(e) => setEmail(e.target.value)}
            />
          </Field>
          <Button type="submit" variant="primary" size="lg" block icon={Send} loading={forgot.isPending}>
            Enviar enlace
          </Button>
        </form>
      )}
    </AuthShell>
  );
}
