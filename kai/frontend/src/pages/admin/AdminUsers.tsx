/* Usuarios de la plataforma: negocios a los que pertenecen, activación y rol de administrador. */
import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Search, ShieldMinus, ShieldPlus, UserCheck, UserX, Users } from 'lucide-react';
import { ROLE_LABELS } from '@shared';
import { api, errorText } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { timeAgo } from '../../lib/format';
import { Button, Card, ConfirmDialog, EmptyState, PageHeader, Select, Spinner, useToast } from '../../components/ui';
import { ADMIN_KEYS, QueryError, num, shortDate, type AdminUser } from './admin-shared';
import '../../styles/admin.css';

type Change = 'deactivate' | 'activate' | 'make_admin' | 'remove_admin';
type Filter = 'all' | 'active' | 'inactive' | 'admin';

const FILTERS: { value: Filter; label: string }[] = [
  { value: 'all', label: 'Todos los usuarios' },
  { value: 'active', label: 'Activos' },
  { value: 'inactive', label: 'Desactivados' },
  { value: 'admin', label: 'Administradores' },
];

const CHANGE_BODY: Record<Change, { isActive?: boolean; platformRole?: 'admin' | 'user' }> = {
  deactivate: { isActive: false },
  activate: { isActive: true },
  make_admin: { platformRole: 'admin' },
  remove_admin: { platformRole: 'user' },
};

function confirmCopy(change: Change, u: AdminUser) {
  const who = u.name || u.email;
  switch (change) {
    case 'deactivate':
      return {
        title: `¿Desactivar a ${who}?`,
        message: 'No podrá iniciar sesión y se cerrarán todas sus sesiones abiertas. Sus negocios y datos no se borran; puedes volver a activarlo cuando quieras.',
        label: 'Desactivar',
        danger: true,
        done: 'Usuario desactivado',
      };
    case 'activate':
      return {
        title: `¿Activar a ${who}?`,
        message: 'Podrá volver a iniciar sesión con su email y contraseña y acceder a sus negocios (salvo los que estén suspendidos).',
        label: 'Activar',
        danger: false,
        done: 'Usuario activado',
      };
    case 'make_admin':
      return {
        title: `¿Hacer administrador a ${who}?`,
        message: 'Tendrá acceso completo a este panel: todos los negocios, usuarios, planes, registros y conversaciones de la plataforma. Dáselo solo a personas de tu total confianza.',
        label: 'Hacer administrador',
        danger: true,
        done: 'Ahora es administrador',
      };
    case 'remove_admin':
      return {
        title: `¿Quitar el rol de administrador a ${who}?`,
        message: 'Dejará de tener acceso a este panel. Seguirá pudiendo usar la aplicación en los negocios a los que pertenece.',
        label: 'Quitar administrador',
        danger: true,
        done: 'Rol de administrador retirado',
      };
  }
}

export default function AdminUsers() {
  const { me } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const [params] = useSearchParams();
  const [search, setSearch] = useState(params.get('q') ?? '');
  const [debounced, setDebounced] = useState(search.trim());
  const [filter, setFilter] = useState<Filter>('all');
  const [pending, setPending] = useState<{ user: AdminUser; change: Change } | null>(null);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  const q = useQuery({
    queryKey: [...ADMIN_KEYS.users, debounced],
    queryFn: () => api.get<{ users: AdminUser[] }>('/admin/users', { search: debounced }),
    placeholderData: (prev) => prev,
  });

  const update = useMutation({
    mutationFn: ({ user, change }: { user: AdminUser; change: Change }) => api.patch<{ ok: true }>(`/admin/users/${user.id}`, CHANGE_BODY[change]),
    onSuccess: (_d, vars) => {
      toast(confirmCopy(vars.change, vars.user).done);
      setPending(null);
      void qc.invalidateQueries({ queryKey: ADMIN_KEYS.users });
      void qc.invalidateQueries({ queryKey: ADMIN_KEYS.businessAll });
      void qc.invalidateQueries({ queryKey: ADMIN_KEYS.overview });
      void qc.invalidateQueries({ queryKey: ADMIN_KEYS.audit });
    },
    onError: (e) => toast(errorText(e), 'error'),
  });

  const all = q.data?.users ?? [];
  const rows = all.filter((u) => (filter === 'all' ? true : filter === 'active' ? u.isActive : filter === 'inactive' ? !u.isActive : u.platformRole === 'admin'));
  const copy = pending ? confirmCopy(pending.change, pending.user) : null;

  return (
    <div className="page">
      <PageHeader title="Usuarios" description="Todas las personas con cuenta en KAI: entrenadores, miembros de sus equipos y administradores. Desde aquí puedes desactivar una cuenta o darle acceso a este panel." />
      <Card flush>
        <div className="adm-toolbar">
          <div className="input-group">
            <Search aria-hidden />
            <input className="input" type="search" placeholder="Buscar por nombre o email…" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Buscar usuarios por nombre o email" />
          </div>
          <Select aria-label="Filtrar usuarios" value={filter} onChange={(e) => setFilter(e.target.value as Filter)} options={FILTERS} />
          {q.isFetching && !q.isPending ? <Spinner size={16} /> : null}
          {!q.isPending && !q.isError && (
            <span className="subtle small adm-toolbar-count">
              {rows.length === all.length ? `${num(all.length)} usuario${all.length === 1 ? '' : 's'}` : `${num(rows.length)} de ${num(all.length)}`}
            </span>
          )}
        </div>
        {q.isPending ? (
          <div className="page-loading" style={{ minHeight: 200 }}>
            <Spinner />
          </div>
        ) : q.isError ? (
          <QueryError error={q.error} onRetry={() => void q.refetch()} retrying={q.isFetching} />
        ) : rows.length === 0 ? (
          <EmptyState icon={Users} title="No hay usuarios que coincidan" description="Prueba con otro nombre, otro email o cambia el filtro." />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Usuario</th>
                  <th>Rol en la plataforma</th>
                  <th>Negocios</th>
                  <th>Estado</th>
                  <th>Último inicio de sesión</th>
                  <th>Alta</th>
                  <th>
                    <span className="sr-only">Acciones</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((u) => {
                  const isMe = u.id === me?.user?.id;
                  const selfHint = 'No puedes desactivarte ni quitarte el rol de administrador a ti mismo.';
                  return (
                    <tr key={u.id}>
                      <td>
                        <div className="adm-cell-main">
                          {u.name || 'Sin nombre'}
                          {isMe && <span className="subtle small"> (tú)</span>}
                        </div>
                        <div className="subtle xs">{u.email}</div>
                      </td>
                      <td>{u.platformRole === 'admin' ? <span className="badge badge-violet">Administrador</span> : <span className="badge">Usuario</span>}</td>
                      <td>
                        {u.businesses.length === 0 ? (
                          <span className="subtle small">Ninguno</span>
                        ) : (
                          <div className="adm-biz-links">
                            {u.businesses.map((b) => (
                              <Link key={b.businessId} to={`/admin/negocios/${b.businessId}`} className="badge adm-biz-link" title={`${b.businessName} · ${ROLE_LABELS[b.role] ?? b.role}`}>
                                {b.businessName}
                                <span className="subtle">· {ROLE_LABELS[b.role] ?? b.role}</span>
                              </Link>
                            ))}
                          </div>
                        )}
                      </td>
                      <td>{u.isActive ? <span className="badge badge-dot badge-success">Activo</span> : <span className="badge badge-dot badge-danger">Desactivado</span>}</td>
                      <td className="subtle" style={{ whiteSpace: 'nowrap' }}>
                        {u.lastLoginAt ? timeAgo(u.lastLoginAt) : '—'}
                      </td>
                      <td className="subtle" style={{ whiteSpace: 'nowrap' }}>
                        {shortDate(u.createdAt)}
                      </td>
                      <td>
                        <div className="adm-actions">
                          {u.isActive ? (
                            <Button size="sm" variant="ghost" icon={UserX} disabled={isMe} title={isMe ? selfHint : undefined} onClick={() => setPending({ user: u, change: 'deactivate' })} aria-label={`Desactivar a ${u.name || u.email}`}>
                              Desactivar
                            </Button>
                          ) : (
                            <Button size="sm" icon={UserCheck} onClick={() => setPending({ user: u, change: 'activate' })} aria-label={`Activar a ${u.name || u.email}`}>
                              Activar
                            </Button>
                          )}
                          {u.platformRole === 'admin' ? (
                            <Button size="sm" variant="ghost" icon={ShieldMinus} disabled={isMe} title={isMe ? selfHint : undefined} onClick={() => setPending({ user: u, change: 'remove_admin' })} aria-label={`Quitar admin a ${u.name || u.email}`}>
                              Quitar admin
                            </Button>
                          ) : (
                            <Button size="sm" variant="ghost" icon={ShieldPlus} onClick={() => setPending({ user: u, change: 'make_admin' })} aria-label={`Hacer admin a ${u.name || u.email}`}>
                              Hacer admin
                            </Button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {!q.isPending && !q.isError && all.length >= 200 && <p className="subtle xs adm-note">Se muestran los 200 usuarios más recientes: usa la búsqueda para encontrar otros.</p>}
      </Card>

      <ConfirmDialog
        open={!!pending}
        title={copy?.title ?? ''}
        message={copy?.message ?? ''}
        confirmLabel={copy?.label}
        danger={copy?.danger}
        loading={update.isPending}
        onConfirm={() => pending && update.mutate(pending)}
        onClose={() => setPending(null)}
      />
    </div>
  );
}
