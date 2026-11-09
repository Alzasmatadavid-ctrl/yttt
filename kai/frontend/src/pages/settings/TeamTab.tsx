/* Pestaña «Equipo»: personas con acceso al negocio, invitaciones pendientes y roles. */
import { useCallback, useEffect, useId, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, CircleAlert, Copy, Link2, Lock, Mail, MailX, RefreshCw, Send, ShieldCheck, Trash2, UserPlus, Users, X } from 'lucide-react';
import { ROLE_LABELS, type BusinessRole } from '@shared';
import { api, errorText } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { timeAgo } from '../../lib/format';
import { Button, Callout, Card, ConfirmDialog, EmptyState, Field, Input, Modal, PageLoading, Select, useToast } from '../../components/ui';
import { Meter } from '../../components/charts';
import { LeadAvatar } from '../../components/lead-bits';
import { PLAN_QUERY_KEY, ROLE_INFO, TEAM_QUERY_KEY, longDate, type InviteResponse, type PlanResponse, type SettingsTabProps, type TeamInvitation, type TeamMember, type TeamResponse } from './settings-shared';

const ROLE_OPTIONS: { value: BusinessRole; label: string }[] = [
  { value: 'team_member', label: ROLE_LABELS.team_member },
  { value: 'trainer', label: ROLE_LABELS.trainer },
];

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function RoleBadge({ role }: { role: BusinessRole }) {
  return <span className={`badge ${role === 'trainer' ? 'badge-accent' : 'badge-info'}`}>{ROLE_LABELS[role]}</span>;
}

/** Explicación de lo que puede hacer cada rol. */
function RoleGuide() {
  return (
    <div className="grid-2">
      {(['team_member', 'trainer'] as BusinessRole[]).map((role) => {
        const info = ROLE_INFO[role];
        return (
          <div key={role} className="settings-role">
            <div className="row-between">
              <strong>{info.title}</strong>
              <RoleBadge role={role} />
            </div>
            <p className="muted small mt-4">{info.summary}</p>
            <p className="settings-role-heading mt-12">Puede</p>
            <ul className="settings-checklist mt-4" aria-label={`Qué puede hacer el rol ${info.title}`}>
              {info.can.map((c) => (
                <li key={c} className="settings-check-item">
                  <Check aria-hidden className="ok" />
                  <span>{c}</span>
                </li>
              ))}
            </ul>
            {info.cannot.length > 0 && (
              <>
                <p className="settings-role-heading mt-12">No puede</p>
                <ul className="settings-checklist mt-4" aria-label={`Qué no puede hacer el rol ${info.title}`}>
                  {info.cannot.map((c) => (
                    <li key={c} className="settings-check-item is-no">
                      <X aria-hidden />
                      <span>{c}</span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ───────────── Invitar ─────────────

function InviteModal({ open, onClose, members, invitations }: { open: boolean; onClose: () => void; members: TeamMember[]; invitations: TeamInvitation[] }) {
  const qc = useQueryClient();
  const toast = useToast();
  const ids = { email: useId(), role: useId(), link: useId() };
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<BusinessRole>('team_member');
  const [touched, setTouched] = useState(false);
  const [result, setResult] = useState<InviteResponse | null>(null);
  const [copied, setCopied] = useState(false);

  const normalized = email.trim().toLowerCase();
  const emailError = !normalized
    ? 'Escribe el email de la persona que quieres invitar.'
    : !EMAIL_RE.test(normalized)
      ? 'Ese email no parece válido.'
      : members.some((m) => m.email.toLowerCase() === normalized)
        ? 'Esa persona ya forma parte del equipo.'
        : null;
  const alreadyInvited = invitations.some((i) => i.email.toLowerCase() === normalized);

  // Estable: el Modal compartido vuelve a enfocar su primer botón cada vez que cambia onClose.
  const close = useCallback(() => {
    setEmail('');
    setRole('team_member');
    setTouched(false);
    setResult(null);
    setCopied(false);
    onClose();
  }, [onClose]);

  // Al abrir, llevar el foco al campo de email (el Modal enfoca antes su botón de cerrar); con el enlace creado, al enlace.
  useEffect(() => {
    if (!open) return;
    const target = result ? ids.link : ids.email;
    const id = window.setTimeout(() => document.getElementById(target)?.focus(), 0);
    return () => window.clearTimeout(id);
  }, [open, result, ids.email, ids.link]);

  const invite = useMutation({
    mutationFn: () => api.post<InviteResponse>('/team/invite', { email: normalized, role }),
    onSuccess: (res) => {
      void qc.invalidateQueries({ queryKey: TEAM_QUERY_KEY });
      void qc.invalidateQueries({ queryKey: PLAN_QUERY_KEY });
      if (res.emailed) {
        toast(`Invitación enviada a ${res.invitation.email}`);
        close();
      } else {
        setResult(res);
      }
    },
    onError: (e) => toast(errorText(e), 'error'),
  });

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    setTouched(true);
    if (emailError || invite.isPending) return;
    invite.mutate();
  };

  const copy = async () => {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result.link ?? '');
      setCopied(true);
      toast('Enlace copiado');
    } catch {
      const input = document.getElementById(ids.link) as HTMLInputElement | null;
      input?.select();
      toast('No hemos podido copiarlo automáticamente. Selecciona el enlace y cópialo a mano.', 'info');
    }
  };

  if (result) {
    return (
      <Modal
        open={open}
        onClose={close}
        title="Invitación creada"
        footer={
          <Button variant="primary" onClick={close}>
            Hecho
          </Button>
        }
      >
        <div className="col gap-12">
          <Callout tone="warning" icon={MailX}>
            No hemos podido enviar el email a <strong>{result.invitation.email}</strong> (el envío de emails no está configurado o ha fallado). Copia este enlace y envíaselo tú por WhatsApp, email o como prefieras.
          </Callout>
          <Field label="Enlace de invitación" htmlFor={ids.link} hint={`Válido hasta el ${longDate(result.invitation.expiresAt)}. Por seguridad, solo se muestra ahora: si lo pierdes, anula esta invitación y crea otra.`}>
            <div className="row">
              <Input id={ids.link} readOnly value={result.link ?? ''} onFocus={(e) => e.currentTarget.select()} className="grow" />
              <Button icon={copied ? Check : Copy} onClick={() => void copy()}>
                {copied ? 'Copiado' : 'Copiar'}
              </Button>
            </div>
          </Field>
          <p className="subtle xs">Al abrir el enlace, la persona podrá crear su cuenta (o entrar con la que ya tenga) y se unirá a tu equipo como «{ROLE_LABELS[result.invitation.role]}».</p>
        </div>
      </Modal>
    );
  }

  return (
    <Modal
      open={open}
      onClose={close}
      title="Invitar a alguien a tu equipo"
      wide
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            Cancelar
          </Button>
          <Button variant="primary" icon={Send} loading={invite.isPending} disabled={touched && Boolean(emailError)} onClick={() => submit()}>
            Enviar invitación
          </Button>
        </>
      }
    >
      <form className="col gap-16" onSubmit={submit} noValidate>
        <Field label="Email" htmlFor={ids.email} error={touched ? emailError : null} hint="Le enviaremos por email un enlace para unirse (si el envío no está disponible, te daremos el enlace para que se lo mandes tú). Caduca a los 7 días.">
          <Input
            id={ids.email}
            type="email"
            autoComplete="off"
            value={email}
            maxLength={200}
            placeholder="nombre@ejemplo.com"
            aria-invalid={(touched && Boolean(emailError)) || undefined}
            onChange={(e) => setEmail(e.target.value)}
            onBlur={() => normalized && setTouched(true)}
          />
        </Field>
        {alreadyInvited && !emailError && <Callout tone="info">Ya hay una invitación pendiente para este email. Si continúas, se creará otra nueva y ambas servirán hasta que caduquen.</Callout>}
        <div className="field">
          <span className="label" id={ids.role}>
            Rol
          </span>
          <div className="settings-role-picker" role="group" aria-labelledby={ids.role}>
            {(['team_member', 'trainer'] as BusinessRole[]).map((r) => {
              const info = ROLE_INFO[r];
              return (
                <button key={r} type="button" className="option" aria-pressed={role === r} onClick={() => setRole(r)}>
                  <strong>{info.title}</strong>
                  <span className="muted small">{info.summary}</span>
                  <span className="settings-checklist mt-4">
                    {info.can.map((c) => (
                      <span key={c} className="settings-check-item">
                        <Check aria-hidden className="ok" />
                        <span>{c}</span>
                      </span>
                    ))}
                    {info.cannot.map((c) => (
                      <span key={c} className="settings-check-item is-no">
                        <X aria-hidden />
                        <span>
                          <span className="sr-only">No puede: </span>
                          {c}
                        </span>
                      </span>
                    ))}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
        {role === 'trainer' && (
          <Callout tone="warning">Da el rol Entrenador solo a personas de máxima confianza: podrán cambiar cualquier ajuste, conectar canales e incluso quitar a otras personas del equipo.</Callout>
        )}
      </form>
    </Modal>
  );
}

// ───────────── Pestaña ─────────────

export default function TeamTab({ canEdit }: SettingsTabProps) {
  const qc = useQueryClient();
  const toast = useToast();
  const { me } = useAuth();
  const myId = me?.user?.id ?? null;
  const team = useQuery({ queryKey: TEAM_QUERY_KEY, queryFn: () => api.get<TeamResponse>('/team') });
  const plan = useQuery({ queryKey: PLAN_QUERY_KEY, queryFn: () => api.get<PlanResponse>('/settings/plan') });

  const [inviteOpen, setInviteOpen] = useState(false);
  const [roleChange, setRoleChange] = useState<{ member: TeamMember; role: BusinessRole } | null>(null);
  const [removing, setRemoving] = useState<TeamMember | null>(null);
  const [cancelling, setCancelling] = useState<TeamInvitation | null>(null);
  const closeInvite = useCallback(() => setInviteOpen(false), []);
  const closeRoleChange = useCallback(() => setRoleChange(null), []);
  const closeRemoving = useCallback(() => setRemoving(null), []);
  const closeCancelling = useCallback(() => setCancelling(null), []);

  const refreshTeam = () => {
    void qc.invalidateQueries({ queryKey: TEAM_QUERY_KEY });
    void qc.invalidateQueries({ queryKey: PLAN_QUERY_KEY });
  };

  const changeRole = useMutation({
    mutationFn: ({ member, role }: { member: TeamMember; role: BusinessRole }) => api.patch(`/team/members/${member.userId}`, { role }),
    onSuccess: (_d, { member, role }) => {
      toast(`${member.name || member.email} ahora es «${ROLE_LABELS[role]}»`);
      setRoleChange(null);
      refreshTeam();
    },
    onError: (e) => toast(errorText(e), 'error'),
  });

  const removeMember = useMutation({
    mutationFn: (member: TeamMember) => api.del(`/team/members/${member.userId}`),
    onSuccess: (_d, member) => {
      toast(`${member.name || member.email} ya no tiene acceso al negocio`);
      setRemoving(null);
      refreshTeam();
    },
    onError: (e) => toast(errorText(e), 'error'),
  });

  const cancelInvite = useMutation({
    mutationFn: (inv: TeamInvitation) => api.del(`/team/invitations/${inv.id}`),
    onSuccess: (_d, inv) => {
      toast(`Invitación a ${inv.email} anulada`);
      setCancelling(null);
      refreshTeam();
    },
    onError: (e) => toast(errorText(e), 'error'),
  });

  if (team.isPending) return <PageLoading />;
  if (team.isError || !team.data) {
    return (
      <div className="card">
        <EmptyState
          icon={CircleAlert}
          title="No hemos podido cargar tu equipo"
          description={errorText(team.error)}
          action={
            <Button icon={RefreshCw} loading={team.isFetching} onClick={() => void team.refetch()}>
              Reintentar
            </Button>
          }
        />
      </div>
    );
  }

  const { members, invitations } = team.data;
  const sortedMembers = [...members].sort((a, b) => {
    if (a.userId === myId) return -1;
    if (b.userId === myId) return 1;
    if (a.role !== b.role) return a.role === 'trainer' ? -1 : 1;
    return (a.name || a.email).localeCompare(b.name || b.email, 'es');
  });
  const seats = plan.data?.seats ?? members.length + invitations.length;
  const maxSeats = plan.data ? plan.data.limits.maxTeamMembers : undefined;
  const atLimit = maxSeats !== undefined && maxSeats !== null && seats >= maxSeats;

  return (
    <>
      {!canEdit && (
        <Callout tone="info" icon={Lock}>
          Puedes ver quién forma parte del equipo, pero solo las personas con rol Entrenador pueden invitar, cambiar roles o quitar acceso.
        </Callout>
      )}

      <Card
        title="Personas con acceso"
        icon={Users}
        actions={
          canEdit && (
            <Button variant="primary" size="sm" icon={UserPlus} disabled={atLimit} title={atLimit ? 'Has llegado al máximo de usuarios de tu plan' : undefined} onClick={() => setInviteOpen(true)}>
              Invitar a alguien
            </Button>
          )
        }
      >
        <div className="settings-seats">
          {plan.data ? (
            <>
              <Meter label="Usuarios de tu plan" value={seats} max={plan.data.limits.maxTeamMembers} />
              <p className="subtle xs mt-4">Cuentan las personas del equipo y las invitaciones pendientes.</p>
            </>
          ) : plan.isError ? (
            <p className="subtle xs">No hemos podido cargar el límite de usuarios de tu plan.</p>
          ) : null}
          {atLimit && canEdit && (
            <p className="small muted mt-8">
              Has llegado al máximo de usuarios de tu plan. Para invitar a alguien más, quita a una persona o anula una invitación, o cambia de plan (consulta la pestaña «Plan y uso»).
            </p>
          )}
        </div>

        <ul className="settings-people mt-16" aria-label="Personas con acceso a este negocio">
          {sortedMembers.map((m) => {
            const isMe = m.userId === myId;
            const who = m.name || m.email;
            return (
              <li key={m.userId} className="settings-person">
                <div className="settings-person-main">
                  <LeadAvatar name={who} size={36} />
                  <div style={{ minWidth: 0 }}>
                    <div className="row" style={{ gap: 6, minWidth: 0 }}>
                      <strong className="ellipsis">{m.name || 'Sin nombre'}</strong>
                      {isMe && <span className="badge">Tú</span>}
                    </div>
                    <div className="subtle xs ellipsis">{m.email}</div>
                  </div>
                </div>
                <div className="settings-person-role">
                  {canEdit && !isMe ? (
                    <Select
                      aria-label={`Rol de ${who}`}
                      value={m.role}
                      options={ROLE_OPTIONS}
                      className="settings-role-select"
                      disabled={changeRole.isPending}
                      onChange={(e) => {
                        const next = e.target.value as BusinessRole;
                        if (next !== m.role) setRoleChange({ member: m, role: next });
                      }}
                    />
                  ) : (
                    <RoleBadge role={m.role} />
                  )}
                </div>
                <div className="settings-person-meta xs">
                  <span>
                    <span className="subtle">Último acceso: </span>
                    {isMe ? 'ahora' : m.lastLoginAt ? timeAgo(m.lastLoginAt) : 'todavía no ha entrado'}
                  </span>
                  <span>
                    <span className="subtle">En el equipo desde el </span>
                    {longDate(m.joinedAt)}
                  </span>
                </div>
                {canEdit && (
                  <div className="settings-person-actions">
                    {isMe ? (
                      <span className="subtle xs" title="No puedes quitarte a ti mismo ni cambiar tu propio rol">
                        Tu cuenta
                      </span>
                    ) : (
                      <Button variant="ghost" size="sm" iconOnly icon={Trash2} title="Quitar del equipo" onClick={() => setRemoving(m)}>
                        {`Quitar a ${who} del equipo`}
                      </Button>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
        {members.length === 1 && canEdit && <p className="muted small mt-12">De momento trabajas tú solo. Invita a quien te ayude con los leads para que pueda responder conversaciones y agendar llamadas.</p>}
      </Card>

      <Card title="Invitaciones pendientes" icon={Mail}>
        {invitations.length === 0 ? (
          <p className="muted small">No hay invitaciones pendientes. Cuando alguien acepta una invitación pasa a la lista de arriba; las caducadas desaparecen solas.</p>
        ) : (
          <>
            <ul className="settings-people" aria-label="Invitaciones pendientes">
              {invitations.map((inv) => (
                <li key={inv.id} className="settings-person is-invite">
                  <div className="settings-person-main">
                    <span className="settings-invite-icon" aria-hidden>
                      <Link2 size={16} />
                    </span>
                    <div style={{ minWidth: 0 }}>
                      <strong className="ellipsis" style={{ display: 'block' }}>
                        {inv.email}
                      </strong>
                      <div className="subtle xs">Pendiente de aceptar</div>
                    </div>
                  </div>
                  <div className="settings-person-role">
                    <RoleBadge role={inv.role} />
                  </div>
                  <div className="settings-person-meta xs">
                    <span>
                      <span className="subtle">Caduca el </span>
                      {longDate(inv.expiresAt)}
                    </span>
                    <span className="subtle">({timeAgo(inv.expiresAt)})</span>
                  </div>
                  {canEdit && (
                    <div className="settings-person-actions">
                      <Button variant="ghost" size="sm" icon={X} onClick={() => setCancelling(inv)} aria-label={`Anular la invitación a ${inv.email}`}>
                        Anular
                      </Button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
            <p className="subtle xs mt-12">
              El enlace de cada invitación solo se muestra al crearla. Si la persona no lo encuentra o lo has perdido, anula la invitación y crea otra: obtendrás un enlace nuevo.
            </p>
          </>
        )}
      </Card>

      <Card title="Qué puede hacer cada rol" icon={ShieldCheck}>
        <RoleGuide />
      </Card>

      {canEdit && <InviteModal open={inviteOpen} onClose={closeInvite} members={members} invitations={invitations} />}

      <ConfirmDialog
        open={roleChange !== null}
        title={roleChange?.role === 'trainer' ? '¿Dar acceso completo?' : '¿Limitar el acceso?'}
        message={
          roleChange
            ? roleChange.role === 'trainer'
              ? `${roleChange.member.name || roleChange.member.email} pasará a ser «Entrenador»: podrá cambiar cualquier ajuste de KAI, conectar canales, gestionar el plan, eliminar leads y gestionar el equipo (incluido quitarte acceso).`
              : `${roleChange.member.name || roleChange.member.email} pasará a ser «Miembro del equipo»: seguirá trabajando con leads, conversaciones y agenda, pero ya no podrá cambiar la configuración, las integraciones, el equipo ni el plan, ni eliminar leads.`
            : ''
        }
        confirmLabel={roleChange?.role === 'trainer' ? 'Dar acceso completo' : 'Cambiar rol'}
        loading={changeRole.isPending}
        onConfirm={() => roleChange && changeRole.mutate(roleChange)}
        onClose={closeRoleChange}
      />

      <ConfirmDialog
        open={removing !== null}
        title="¿Quitar a esta persona del equipo?"
        message={
          removing
            ? `${removing.name || removing.email} dejará de tener acceso a este negocio inmediatamente. Los leads y las conversaciones en los que ha trabajado se conservan. Podrás volver a invitarla cuando quieras.`
            : ''
        }
        confirmLabel="Quitar del equipo"
        danger
        loading={removeMember.isPending}
        onConfirm={() => removing && removeMember.mutate(removing)}
        onClose={closeRemoving}
      />

      <ConfirmDialog
        open={cancelling !== null}
        title="¿Anular esta invitación?"
        message={cancelling ? `El enlace enviado a ${cancelling.email} dejará de funcionar. Si cambias de idea, tendrás que enviarle una invitación nueva.` : ''}
        confirmLabel="Anular invitación"
        danger
        loading={cancelInvite.isPending}
        onConfirm={() => cancelling && cancelInvite.mutate(cancelling)}
        onClose={closeCancelling}
      />
    </>
  );
}
