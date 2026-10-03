import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { UserCheck } from 'lucide-react';
import { ROLE_LABELS, type BusinessRole } from '@shared';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { Button, Callout, Field, Input, Spinner, useToast } from '../../components/ui';
import AuthShell, { FormError, PasswordInput, PasswordRules, passwordIssue } from '../../components/AuthShell';

/** Respuesta de GET /api/auth/invitation. */
interface InvitationInfo {
  email: string;
  role: BusinessRole;
  businessName: string;
  userExists: boolean;
}

type Errors = Partial<Record<'name' | 'password', string>>;

function roleText(role: BusinessRole) {
  const label = ROLE_LABELS[role] ?? ROLE_LABELS.team_member;
  return label.charAt(0).toLowerCase() + label.slice(1);
}

export default function Invitation() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const validToken = token.length >= 10 && token.length <= 200;
  const { me, refresh } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<Errors>({});

  const invitation = useQuery({
    queryKey: ['invitation', token],
    queryFn: () => api.get<InvitationInfo>('/auth/invitation', { token }),
    enabled: validToken,
    retry: false,
    staleTime: Infinity,
  });
  const info = invitation.data;
  const currentEmail = me?.user?.email ?? null;
  const isSameUser = Boolean(info && currentEmail && currentEmail.toLowerCase() === info.email.toLowerCase());
  const isOtherUser = Boolean(info && currentEmail && !isSameUser);
  const mode: 'same' | 'existing' | 'new' = isSameUser ? 'same' : info?.userExists ? 'existing' : 'new';

  const accept = useMutation({
    mutationFn: () =>
      api.post<{ ok: boolean; businessId: string }>(
        '/auth/accept-invitation',
        mode === 'same' ? { token } : mode === 'existing' ? { token, password } : { token, name: name.trim(), password },
      ),
    onSuccess: async () => {
      // La sesión pasa al negocio que invita: descartamos datos en caché de otra cuenta o negocio.
      qc.removeQueries({ predicate: (q) => q.queryKey[0] !== 'me' && q.queryKey[0] !== 'invitation' });
      await refresh();
      toast(info ? `Ya formas parte de ${info.businessName}` : 'Invitación aceptada');
      navigate('/app', { replace: true });
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const found: Errors = {};
    if (mode === 'new') {
      if (name.trim().length < 2) found.name = 'Indica tu nombre.';
      const issue = passwordIssue(password);
      if (issue) found.password = issue;
    } else if (mode === 'existing' && !password) {
      found.password = 'Introduce la contraseña de tu cuenta.';
    }
    setErrors(found);
    if (Object.keys(found).length) return;
    accept.mutate();
  };

  if (!validToken) {
    return (
      <AuthShell docTitle="Invitación no válida" title="Esta invitación no es válida" subtitle="Puede que el enlace esté incompleto o que lo hayas copiado mal.">
        <div className="kai-form">
          <div role="alert">
            <Callout tone="danger">Abre el enlace completo que recibiste por email. Si no funciona, pide a la persona que te invitó que te envíe una invitación nueva.</Callout>
          </div>
          <Link to="/login" className="btn btn-lg btn-block">
            Ir a entrar
          </Link>
        </div>
      </AuthShell>
    );
  }

  if (invitation.isPending) {
    return (
      <AuthShell docTitle="Invitación" title="Invitación a KAI" subtitle="Comprobando tu invitación…">
        <div className="kai-center">
          <Spinner size={26} />
        </div>
      </AuthShell>
    );
  }

  if (invitation.isError || !info) {
    return (
      <AuthShell docTitle="Invitación no válida" title="No podemos abrir esta invitación" subtitle="Las invitaciones caducan a los 7 días y solo se pueden usar una vez.">
        <div className="kai-form">
          <FormError error={invitation.error ?? 'La invitación no es válida o ha caducado.'} />
          <p className="muted small">Pide a la persona que te invitó que te envíe una invitación nueva. Si ya la aceptaste, entra con tu cuenta.</p>
          <Link to="/login" className="btn btn-lg btn-block">
            Ir a entrar
          </Link>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      docTitle="Invitación"
      title="Únete a tu equipo en KAI"
      subtitle={
        mode === 'new'
          ? 'Crea tu cuenta para acceder a la bandeja, los leads y la agenda del equipo.'
          : 'Acepta la invitación para acceder a la bandeja, los leads y la agenda del equipo.'
      }
    >
      <div className="kai-invite">
        <span className="kai-invite-mark" aria-hidden>
          {info.businessName.trim().charAt(0).toUpperCase() || 'K'}
        </span>
        <p className="small">
          Te han invitado a unirte a <strong>{info.businessName}</strong> como {roleText(info.role)}.
          <br />
          <span className="muted">Invitación para {info.email}</span>
        </p>
      </div>

      {isOtherUser && (
        <Callout tone="warning">
          Ahora mismo has iniciado sesión como <strong>{currentEmail}</strong>. Al aceptar, pasarás a usar la cuenta <strong>{info.email}</strong> en este navegador.
        </Callout>
      )}

      <form className="kai-form" onSubmit={submit} noValidate>
        <FormError error={accept.error} />

        {mode === 'same' && <p className="muted">Has iniciado sesión con la cuenta invitada. Solo tienes que confirmar.</p>}

        {mode === 'existing' && (
          <>
            <p className="muted small">Ya tienes una cuenta de KAI con este email. Introduce su contraseña para aceptar la invitación.</p>
            {/* Campo de usuario oculto para que el gestor de contraseñas reconozca la cuenta. */}
            <input type="email" name="username" autoComplete="username" value={info.email} readOnly hidden />
            <Field label="Contraseña de tu cuenta" htmlFor="inv-password" error={errors.password}>
              <PasswordInput
                id="inv-password"
                autoComplete="current-password"
                autoFocus
                value={password}
                aria-invalid={Boolean(errors.password)}
                onChange={(e) => setPassword(e.target.value)}
              />
            </Field>
            <div className="kai-inline-link">
              <Link to="/recuperar">¿Has olvidado tu contraseña?</Link>
            </div>
          </>
        )}

        {mode === 'new' && (
          <>
            <Field label="Email" htmlFor="inv-email" hint="Es el email al que llegó la invitación.">
              <Input id="inv-email" type="email" autoComplete="username" value={info.email} readOnly />
            </Field>
            <Field label="Tu nombre" htmlFor="inv-name" error={errors.name}>
              <Input
                id="inv-name"
                autoComplete="name"
                autoFocus
                maxLength={120}
                placeholder="Ej. Marta López"
                value={name}
                aria-invalid={Boolean(errors.name)}
                onChange={(e) => setName(e.target.value)}
              />
            </Field>
            <Field label="Crea una contraseña" htmlFor="inv-password" error={errors.password}>
              <PasswordInput
                id="inv-password"
                autoComplete="new-password"
                value={password}
                aria-invalid={Boolean(errors.password)}
                aria-describedby="inv-password-rules"
                onChange={(e) => setPassword(e.target.value)}
              />
              <PasswordRules id="inv-password-rules" value={password} />
            </Field>
          </>
        )}

        <Button type="submit" variant="primary" size="lg" block icon={UserCheck} loading={accept.isPending}>
          Unirme a {info.businessName}
        </Button>
      </form>
    </AuthShell>
  );
}
