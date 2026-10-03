import { useMemo, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Globe, UserPlus } from 'lucide-react';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { Button, Field, Input } from '../../components/ui';
import AuthShell, { FormError, PasswordInput, PasswordRules, isEmail, passwordIssue } from '../../components/AuthShell';

type FormState = { name: string; email: string; password: string; businessName: string };
type Errors = Partial<Record<keyof FormState, string>>;

function detectTimezone(): string | undefined {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return tz && tz.length <= 64 ? tz : undefined;
  } catch {
    return undefined;
  }
}

export default function Register() {
  const { refresh } = useAuth();
  const navigate = useNavigate();
  const timezone = useMemo(detectTimezone, []);
  const [form, setForm] = useState<FormState>({ name: '', email: '', password: '', businessName: '' });
  const [errors, setErrors] = useState<Errors>({});
  // Días de prueba reales (misma consulta y caché que la landing). Si no llegan, se habla de «un periodo de prueba».
  const plans = useQuery({
    queryKey: ['public-plans'],
    queryFn: () => api.get<{ plans: unknown[]; trialDays?: number }>('/public/plans'),
    staleTime: 5 * 60_000,
    retry: 1,
  });
  const trialDays = plans.data?.trialDays;

  const register = useMutation({
    mutationFn: () =>
      api.post<{ ok: boolean; businessId: string }>('/auth/register', {
        name: form.name.trim(),
        email: form.email.trim(),
        password: form.password,
        businessName: form.businessName.trim(),
        timezone,
      }),
    onSuccess: async () => {
      await refresh();
      navigate('/app/onboarding', { replace: true });
    },
  });

  const set = (key: keyof FormState) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [key]: e.target.value }));

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const found: Errors = {};
    if (form.name.trim().length < 2) found.name = 'Indica tu nombre.';
    if (!form.email.trim()) found.email = 'Introduce tu email.';
    else if (!isEmail(form.email)) found.email = 'Revisa el email: parece que no está bien escrito.';
    const pwIssue = passwordIssue(form.password);
    if (pwIssue) found.password = pwIssue;
    if (form.businessName.trim().length < 2) found.businessName = 'Indica el nombre de tu negocio.';
    setErrors(found);
    if (Object.keys(found).length) return;
    register.mutate();
  };

  return (
    <AuthShell
      docTitle="Crear cuenta"
      title="Crea tu cuenta"
      subtitle={`Después te guiaremos paso a paso para configurar a KAI. Empiezas con ${trialDays ? `${trialDays} días de prueba` : 'un periodo de prueba'}.`}
      footer={
        <>
          ¿Ya tienes cuenta? <Link to="/login">Entrar</Link>
        </>
      }
    >
      <form className="kai-form" onSubmit={submit} noValidate>
        <FormError error={register.error} />
        <Field label="Tu nombre" htmlFor="reg-name" error={errors.name}>
          <Input
            id="reg-name"
            autoComplete="name"
            autoFocus
            maxLength={120}
            placeholder="Ej. Álex Ruiz"
            value={form.name}
            aria-invalid={Boolean(errors.name)}
            onChange={set('name')}
          />
        </Field>
        <Field label="Email" htmlFor="reg-email" error={errors.email}>
          <Input
            id="reg-email"
            type="email"
            inputMode="email"
            autoComplete="email"
            maxLength={200}
            placeholder="tu@email.com"
            value={form.email}
            aria-invalid={Boolean(errors.email)}
            onChange={set('email')}
          />
        </Field>
        <Field label="Contraseña" htmlFor="reg-password" error={errors.password}>
          <PasswordInput
            id="reg-password"
            autoComplete="new-password"
            value={form.password}
            aria-invalid={Boolean(errors.password)}
            aria-describedby="reg-password-rules"
            onChange={set('password')}
          />
          <PasswordRules id="reg-password-rules" value={form.password} />
        </Field>
        <Field
          label="Nombre de tu negocio"
          htmlFor="reg-business"
          error={errors.businessName}
          hint="El nombre de tu marca o servicio de entrenamiento. KAI lo usará al hablar con tus leads y podrás cambiarlo más adelante."
        >
          <Input
            id="reg-business"
            autoComplete="organization"
            maxLength={120}
            placeholder="Ej. Álex Ruiz Training"
            value={form.businessName}
            aria-invalid={Boolean(errors.businessName)}
            onChange={set('businessName')}
          />
        </Field>
        {timezone && (
          <p className="kai-meta">
            <Globe aria-hidden />
            <span>
              Zona horaria detectada: <strong>{timezone}</strong>. La usamos para tu agenda y tus recordatorios; puedes cambiarla después en Ajustes.
            </span>
          </p>
        )}
        <Button type="submit" variant="primary" size="lg" block icon={UserPlus} loading={register.isPending}>
          Crear cuenta
        </Button>
        <p className="kai-legal">
          Al crear tu cuenta aceptas las{' '}
          <Link to="/terminos" target="_blank" rel="noopener">
            condiciones de uso
          </Link>{' '}
          y la{' '}
          <Link to="/privacidad" target="_blank" rel="noopener">
            política de privacidad
          </Link>{' '}
          de KAI. Tú decides qué canales conectas y puedes desconectarlos cuando quieras.
        </p>
      </form>
    </AuthShell>
  );
}
