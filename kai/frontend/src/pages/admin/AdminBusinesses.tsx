/* Listado de todos los negocios (tenants) con su plan, estado, suscripción y uso del mes. */
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Building2, Search } from 'lucide-react';
import { api } from '../../lib/api';
import { timeAgo } from '../../lib/format';
import { Card, EmptyState, PageHeader, Select, Spinner } from '../../components/ui';
import {
  ADMIN_KEYS,
  BUSINESS_LIST_LIMIT as LIMIT,
  BusinessStatusBadge,
  QueryError,
  businessListQuery,
  SubscriptionBadge,
  num,
  shortDate,
  usageText,
  type AdminBusinessRow,
  type AdminPlan,
} from './admin-shared';
import '../../styles/admin.css';

type Filter = 'all' | 'active' | 'suspended' | 'trialing' | 'paying' | 'past_due' | 'canceled' | 'onboarding';

const FILTERS: { value: Filter; label: string }[] = [
  { value: 'all', label: 'Todos los negocios' },
  { value: 'active', label: 'Activos' },
  { value: 'suspended', label: 'Suspendidos' },
  { value: 'trialing', label: 'En prueba' },
  { value: 'paying', label: 'De pago' },
  { value: 'past_due', label: 'Con pago pendiente' },
  { value: 'canceled', label: 'Con suscripción cancelada' },
  { value: 'onboarding', label: 'Sin terminar la configuración' },
];

function matches(b: AdminBusinessRow, f: Filter) {
  switch (f) {
    case 'all':
      return true;
    case 'active':
    case 'suspended':
      return b.status === f;
    case 'paying':
      return b.subscriptionStatus === 'active';
    case 'onboarding':
      return !b.onboardingCompletedAt;
    default:
      return b.subscriptionStatus === f;
  }
}

function TrialInfo({ b }: { b: AdminBusinessRow }) {
  if (b.subscriptionStatus !== 'trialing' || !b.trialEndsAt) return null;
  const ended = new Date(b.trialEndsAt).getTime() < Date.now();
  return (
    <div className="xs mt-4" style={{ color: ended ? 'var(--warning)' : 'var(--text-3)' }}>
      {ended ? `Prueba terminada el ${shortDate(b.trialEndsAt)}` : `Hasta el ${shortDate(b.trialEndsAt)}`}
    </div>
  );
}

export default function AdminBusinesses() {
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  useEffect(() => {
    const t = setTimeout(() => setDebounced(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  const q = useQuery({ ...businessListQuery(debounced), placeholderData: (prev) => prev });
  const plans = useQuery({ queryKey: ADMIN_KEYS.plans, queryFn: () => api.get<{ plans: AdminPlan[] }>('/admin/plans') });
  const planById = useMemo(() => new Map((plans.data?.plans ?? []).map((p) => [p.id, p])), [plans.data]);

  const all = q.data?.businesses ?? [];
  const rows = all.filter((b) => matches(b, filter));

  return (
    <div className="page">
      <PageHeader title="Negocios" description="Cada negocio es la cuenta de un entrenador (o estudio) en KAI, con sus propios leads, equipo y configuración. Pulsa en uno para ver su ficha." />
      <Card flush>
        <div className="adm-toolbar">
          <div className="input-group">
            <Search aria-hidden />
            <input className="input" type="search" placeholder="Buscar por nombre del negocio…" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Buscar negocios por nombre" />
          </div>
          <Select aria-label="Filtrar negocios" value={filter} onChange={(e) => setFilter(e.target.value as Filter)} options={FILTERS} />
          {q.isFetching && !q.isPending ? <Spinner size={16} /> : null}
          {!q.isPending && !q.isError && (
            <span className="subtle small adm-toolbar-count">
              {rows.length === all.length ? `${num(all.length)} negocio${all.length === 1 ? '' : 's'}` : `${num(rows.length)} de ${num(all.length)}`}
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
          <EmptyState
            icon={Building2}
            title={all.length === 0 && !debounced ? 'Todavía no hay negocios' : 'No hay negocios que coincidan'}
            description={all.length === 0 && !debounced ? 'Cuando un entrenador se registre en KAI, su negocio aparecerá aquí.' : 'Prueba con otro nombre o cambia el filtro.'}
          />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Negocio</th>
                  <th>Propietario</th>
                  <th>Plan</th>
                  <th>Estado</th>
                  <th>Suscripción</th>
                  <th className="num">Leads</th>
                  <th>Uso del mes</th>
                  <th>Última actividad</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((b) => {
                  const plan = b.planId ? planById.get(b.planId) : undefined;
                  const limits = plan?.limits;
                  return (
                    <tr key={b.id} className="clickable" onClick={() => navigate(`/admin/negocios/${b.id}`)}>
                      <td>
                        <Link to={`/admin/negocios/${b.id}`} className="adm-cell-link" onClick={(e) => e.stopPropagation()}>
                          {b.name}
                        </Link>
                        <div className="subtle xs">Alta: {shortDate(b.createdAt)}</div>
                      </td>
                      <td>
                        {b.owner ? (
                          <>
                            <div>{b.owner.name}</div>
                            <div className="subtle xs">{b.owner.email}</div>
                          </>
                        ) : (
                          <span className="subtle">Sin propietario</span>
                        )}
                      </td>
                      <td>{b.plan ? b.plan.name : <span className="subtle">Sin plan</span>}</td>
                      <td>
                        <BusinessStatusBadge status={b.status} />
                        {!b.onboardingCompletedAt && <div className="subtle xs mt-4">Configurando (paso {b.onboardingStep})</div>}
                      </td>
                      <td>
                        <SubscriptionBadge status={b.subscriptionStatus} />
                        <TrialInfo b={b} />
                      </td>
                      <td className="num">{num(b.leads)}</td>
                      <td className="xs" style={{ whiteSpace: 'nowrap' }}>
                        <div>
                          <span className="subtle">Leads:</span> <span className="tnum">{usageText(b.usage.leads ?? 0, limits ? limits.maxLeadsPerMonth : undefined)}</span>
                        </div>
                        <div>
                          <span className="subtle">KAI:</span> <span className="tnum">{usageText(b.usage.ai_messages ?? 0, limits ? limits.maxAiMessagesPerMonth : undefined)}</span>
                        </div>
                      </td>
                      <td className="subtle" style={{ whiteSpace: 'nowrap' }}>
                        {b.lastActivityAt ? timeAgo(b.lastActivityAt) : 'Sin actividad'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {!q.isPending && !q.isError && (
          <p className="subtle xs adm-note">
            «Uso del mes» muestra los leads nuevos y los mensajes enviados por KAI este mes frente al límite de su plan (∞ = sin límite). «Última actividad» es la última interacción con alguno de sus leads.
            {all.length >= LIMIT && ` Se muestran los ${LIMIT} negocios más recientes: usa la búsqueda para encontrar otros.`}
          </p>
        )}
      </Card>
    </div>
  );
}
