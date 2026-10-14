import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Plus, RotateCw, Search, Users } from 'lucide-react';
import { LEAD_SOURCES, LEAD_STATUSES, LEAD_TEMPERATURES, leadSourceLabel } from '@shared';
import { api, errorText } from '../lib/api';
import { timeAgo } from '../lib/format';
import { Button, Card, EmptyState, Field, Input, Modal, PageHeader, Select, Spinner, Textarea, useToast } from '../components/ui';
import { LeadAvatar, ScoreBadge, SourceBadge, StatusBadge, TemperatureBadge } from '../components/lead-bits';
import type { Lead } from '../lib/types';

function NewLeadModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const [form, setForm] = useState({ name: '', phone: '', email: '', instagramUsername: '', goal: '', notes: '', source: 'manual' });
  const create = useMutation({
    mutationFn: () => api.post<{ lead: Lead; created: boolean }>('/leads', form),
    onSuccess: (r) => {
      toast(r.created ? 'Lead creado' : 'Ese lead ya existía: te llevamos a su ficha', r.created ? 'success' : 'info');
      void qc.invalidateQueries({ queryKey: ['leads'] });
      onClose();
      navigate(`/app/leads/${r.lead.id}`);
    },
    onError: (e) => toast(errorText(e), 'error'),
  });
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Nuevo lead"
      footer={
        <>
          <Button onClick={onClose}>Cancelar</Button>
          <Button variant="primary" loading={create.isPending} disabled={!form.name.trim()} onClick={() => create.mutate()}>
            Crear lead
          </Button>
        </>
      }
    >
      <div className="col gap-12">
        <Field label="Nombre">
          <Input value={form.name} onChange={set('name')} autoFocus />
        </Field>
        <div className="grid-2" style={{ gap: 12 }}>
          <Field label="Teléfono">
            <Input value={form.phone} onChange={set('phone')} placeholder="+34 600 000 000" />
          </Field>
          <Field label="Email">
            <Input type="email" value={form.email} onChange={set('email')} />
          </Field>
        </div>
        <div className="grid-2" style={{ gap: 12 }}>
          <Field label="Instagram">
            <Input value={form.instagramUsername} onChange={set('instagramUsername')} placeholder="@usuario" />
          </Field>
          <Field label="Origen">
            <Select value={form.source} onChange={set('source')} options={LEAD_SOURCES.filter((s) => s.key !== 'simulator').map((s) => ({ value: s.key, label: s.label }))} />
          </Field>
        </div>
        <Field label="Objetivo">
          <Input value={form.goal} onChange={set('goal')} placeholder="Ej. perder 8 kilos antes del verano" />
        </Field>
        <Field label="Notas">
          <Textarea value={form.notes} onChange={set('notes')} rows={3} />
        </Field>
      </div>
    </Modal>
  );
}

export default function Leads() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [status, setStatus] = useState('');
  const [temperature, setTemperature] = useState('');
  const [source, setSource] = useState('');
  const [sort, setSort] = useState('recent');
  useEffect(() => {
    const t = setTimeout(() => setDebounced(search), 300);
    return () => clearTimeout(t);
  }, [search]);
  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ['leads', 'list', debounced, status, temperature, source, sort],
    queryFn: () => api.get<{ leads: Lead[] }>('/leads', { search: debounced, status, temperature, source, sort, limit: 300 }),
  });
  const leads = data?.leads ?? [];

  return (
    <div className="page">
      <PageHeader
        title="Leads"
        description="Todos tus contactos, con su etapa, temperatura y puntuación interna."
        actions={
          <Button variant="primary" icon={Plus} onClick={() => setParams({ nuevo: '1' })}>
            Nuevo lead
          </Button>
        }
      />
      <Card flush>
        {/* Filtros: en fila en escritorio; en el móvil, rejilla de 2 columnas con el buscador a todo el ancho (layout.css). */}
        <div className="leads-filters">
          <div className="input-group grow" style={{ minWidth: 220 }}>
            <Search />
            <input className="input" placeholder="Buscar por nombre, email, teléfono, objetivo…" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Buscar leads" />
          </div>
          <Select aria-label="Etapa" value={status} onChange={(e) => setStatus(e.target.value)} options={[{ value: '', label: 'Todas las etapas' }, ...LEAD_STATUSES.map((s) => ({ value: s.key, label: s.label }))]} />
          <Select aria-label="Temperatura" value={temperature} onChange={(e) => setTemperature(e.target.value)} options={[{ value: '', label: 'Cualquier temperatura' }, ...LEAD_TEMPERATURES.map((s) => ({ value: s.key, label: s.label }))]} />
          <Select aria-label="Origen" value={source} onChange={(e) => setSource(e.target.value)} options={[{ value: '', label: 'Todos los orígenes' }, ...LEAD_SOURCES.filter((s) => s.key !== 'simulator').map((s) => ({ value: s.key, label: s.label }))]} />
          <Select
            aria-label="Orden"
            value={sort}
            onChange={(e) => setSort(e.target.value)}
            options={[
              { value: 'recent', label: 'Actividad reciente' },
              { value: 'score', label: 'Mayor puntuación' },
              { value: 'created', label: 'Más nuevos' },
            ]}
          />
        </div>
        {isLoading ? (
          <div className="page-loading" style={{ minHeight: 200 }}>
            <Spinner />
          </div>
        ) : !data ? (
          // Un fallo de la API no es lo mismo que «no hay leads»: se explica y se puede reintentar.
          <EmptyState
            icon={AlertTriangle}
            title="No se pudieron cargar los leads"
            description={errorText(error)}
            action={
              <Button icon={RotateCw} loading={isFetching} onClick={() => void refetch()}>
                Reintentar
              </Button>
            }
          />
        ) : leads.length === 0 ? (
          <EmptyState icon={Users} title="No hay leads" description="Prueba a cambiar los filtros o crea un lead manualmente." />
        ) : (
          <>
            <div className="table-wrap leads-table">
              <table className="table">
                <thead>
                  <tr>
                    <th>Lead</th>
                    <th>Etapa</th>
                    <th>Temperatura</th>
                    <th className="num">Puntuación</th>
                    <th>Origen</th>
                    <th>Objetivo</th>
                    <th>Última interacción</th>
                  </tr>
                </thead>
                <tbody>
                  {leads.map((l) => (
                    // Toda la fila se puede pulsar con el ratón; con teclado o lector de pantalla, el nombre es un enlace a la ficha.
                    <tr key={l.id} className="clickable" onClick={() => navigate(`/app/leads/${l.id}`)}>
                      <td>
                        <div className="row">
                          <LeadAvatar name={l.name} url={l.avatarUrl} size={30} />
                          <div style={{ minWidth: 0 }}>
                            <Link to={`/app/leads/${l.id}`} className="cell-link" onClick={(e) => e.stopPropagation()}>
                              {l.name || 'Sin nombre'}
                            </Link>
                            <div className="subtle xs">{l.phone ?? l.email ?? (l.instagramUsername ? `@${l.instagramUsername}` : '')}</div>
                          </div>
                        </div>
                      </td>
                      <td>
                        <StatusBadge status={l.status} />
                      </td>
                      <td>
                        <TemperatureBadge temperature={l.temperature} />
                      </td>
                      <td className="num">
                        <ScoreBadge score={l.score} />
                      </td>
                      <td>
                        <SourceBadge source={l.source} />
                      </td>
                      <td className="muted ellipsis" style={{ maxWidth: 240 }}>
                        {l.goalSummary ?? '—'}
                      </td>
                      <td className="subtle">{timeAgo(l.lastInteractionAt ?? l.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {/* En el móvil la tabla de 7 columnas no cabe: cada lead se muestra como una tarjeta con los mismos datos. */}
            <div className="leads-cards">
              {leads.map((l) => (
                <Link key={l.id} to={`/app/leads/${l.id}`} className="lead-row-card">
                  <LeadAvatar name={l.name} url={l.avatarUrl} size={36} channel={l.source} />
                  <span className="col grow" style={{ gap: 6 }}>
                    <span className="row" style={{ gap: 8 }}>
                      <strong className="ellipsis grow">{l.name || 'Sin nombre'}</strong>
                      <ScoreBadge score={l.score} />
                    </span>
                    <span className="row wrap" style={{ gap: 6 }}>
                      <StatusBadge status={l.status} />
                      <TemperatureBadge temperature={l.temperature} />
                    </span>
                    {l.goalSummary && <span className="muted xs ellipsis">{l.goalSummary}</span>}
                    <span className="subtle xs">
                      {leadSourceLabel(l.source)} · {timeAgo(l.lastInteractionAt ?? l.createdAt)}
                    </span>
                  </span>
                </Link>
              ))}
            </div>
          </>
        )}
      </Card>
      <NewLeadModal open={params.get('nuevo') === '1'} onClose={() => setParams({})} />
    </div>
  );
}
