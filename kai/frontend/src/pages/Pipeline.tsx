import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Search, SquareKanban } from 'lucide-react';
import { LEAD_STATUSES, type LeadStatus } from '@shared';
import { api, errorText } from '../lib/api';
import { money, timeAgo } from '../lib/format';
import { Button, EmptyState, Modal, PageHeader, PageLoading, useToast, Field, Input } from '../components/ui';
import { LeadAvatar, ScoreBadge, TemperatureBadge } from '../components/lead-bits';
import type { Lead, SettingsResponse } from '../lib/types';

export default function Pipeline() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const [search, setSearch] = useState('');
  const [dragId, setDragId] = useState<string | null>(null);
  const [overCol, setOverCol] = useState<LeadStatus | null>(null);
  const [clientModal, setClientModal] = useState<{ leadId: string } | null>(null);
  const [deal, setDeal] = useState('');
  const { data, isLoading } = useQuery({ queryKey: ['leads', 'pipeline'], queryFn: () => api.get<{ leads: Lead[] }>('/leads', { limit: 500, sort: 'score' }), refetchInterval: 20_000 });
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => api.get<SettingsResponse>('/settings') });
  const price = settings.data?.services.find((s) => s.isPrimary)?.priceCents ?? 0;
  const currency = settings.data?.business.currency ?? 'EUR';

  const move = useMutation({
    mutationFn: (v: { leadId: string; status: LeadStatus; dealValueCents?: number | null }) => api.post(`/leads/${v.leadId}/status`, { status: v.status, dealValueCents: v.dealValueCents }),
    onMutate: async (v) => {
      await qc.cancelQueries({ queryKey: ['leads', 'pipeline'] });
      const prev = qc.getQueryData<{ leads: Lead[] }>(['leads', 'pipeline']);
      qc.setQueryData<{ leads: Lead[] }>(['leads', 'pipeline'], (old) => (old ? { leads: old.leads.map((l) => (l.id === v.leadId ? { ...l, status: v.status } : l)) } : old));
      return { prev };
    },
    onError: (e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(['leads', 'pipeline'], ctx.prev);
      toast(errorText(e), 'error');
    },
    onSettled: () => void qc.invalidateQueries({ queryKey: ['leads'] }),
  });

  const leads = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (data?.leads ?? []).filter((l) => !q || l.name.toLowerCase().includes(q) || (l.goalSummary ?? '').toLowerCase().includes(q));
  }, [data, search]);
  const byStatus = useMemo(() => {
    const m = new Map<LeadStatus, Lead[]>();
    for (const s of LEAD_STATUSES) m.set(s.key, []);
    for (const l of leads) m.get(l.status)?.push(l);
    return m;
  }, [leads]);

  if (isLoading) return <PageLoading />;

  const drop = (status: LeadStatus) => {
    setOverCol(null);
    const lead = leads.find((l) => l.id === dragId);
    setDragId(null);
    if (!lead || lead.status === status) return;
    if (status === 'client') {
      setDeal('');
      setClientModal({ leadId: lead.id });
      return;
    }
    move.mutate({ leadId: lead.id, status });
  };

  return (
    <div className="page" style={{ maxWidth: 'none' }}>
      <PageHeader
        title="Pipeline"
        description="Arrastra los leads entre etapas. KAI también los mueve solo según lo que pasa en cada conversación."
        actions={
          <div className="input-group" style={{ width: 260 }}>
            <Search />
            <input className="input" placeholder="Filtrar leads" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Filtrar leads" />
          </div>
        }
      />
      {leads.length === 0 && !search ? (
        <EmptyState icon={SquareKanban} title="Tu pipeline está vacío" description="Los leads aparecerán aquí en cuanto entren por cualquier canal." />
      ) : (
        <div className="board">
          {LEAD_STATUSES.map((s) => {
            const col = byStatus.get(s.key) ?? [];
            const value = col.length * price;
            return (
              <section
                key={s.key}
                className={`board-col ${overCol === s.key ? 'drop' : ''}`}
                onDragOver={(e) => {
                  e.preventDefault();
                  setOverCol(s.key);
                }}
                onDragLeave={() => setOverCol((c) => (c === s.key ? null : c))}
                onDrop={(e) => {
                  e.preventDefault();
                  drop(s.key);
                }}
                aria-label={s.label}
              >
                <div className="board-col-header">
                  <strong className="small">{s.label}</strong>
                  <span className="badge tnum">{col.length}</span>
                </div>
                {price > 0 && col.length > 0 && !['lost'].includes(s.key) && (
                  <div className="subtle xs" style={{ padding: '0 12px 6px' }}>
                    {money(value, currency)} potencial
                  </div>
                )}
                <div className="board-cards">
                  {col.map((l) => (
                    <button
                      key={l.id}
                      className={`lead-card ${dragId === l.id ? 'dragging' : ''}`}
                      draggable
                      onDragStart={(e) => {
                        setDragId(l.id);
                        e.dataTransfer.effectAllowed = 'move';
                      }}
                      onDragEnd={() => setDragId(null)}
                      onClick={() => navigate(`/app/leads/${l.id}`)}
                    >
                      <div className="row" style={{ gap: 8 }}>
                        <LeadAvatar name={l.name} url={l.avatarUrl} size={28} channel={l.source} />
                        <strong className="ellipsis grow small">{l.name || 'Sin nombre'}</strong>
                        <ScoreBadge score={l.score} />
                      </div>
                      {l.goalSummary && <div className="muted xs ellipsis">{l.goalSummary}</div>}
                      <div className="row-between">
                        <TemperatureBadge temperature={l.temperature} />
                        <span className="subtle xs">{timeAgo(l.lastInteractionAt ?? l.createdAt)}</span>
                      </div>
                    </button>
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      )}
      <Modal
        open={Boolean(clientModal)}
        onClose={() => setClientModal(null)}
        title="¡Nuevo cliente!"
        footer={
          <>
            <Button onClick={() => setClientModal(null)}>Cancelar</Button>
            <Button
              variant="primary"
              onClick={() => {
                if (clientModal) move.mutate({ leadId: clientModal.leadId, status: 'client', dealValueCents: deal ? Math.round(Number(deal.replace(',', '.')) * 100) : null });
                setClientModal(null);
              }}
            >
              Marcar como cliente
            </Button>
          </>
        }
      >
        <Field label="Importe de la venta (opcional)" hint="Se usa para calcular ingresos y ROI. Si lo dejas vacío, se toma el precio del servicio principal.">
          <Input inputMode="decimal" value={deal} onChange={(e) => setDeal(e.target.value)} placeholder={price ? String(price / 100) : 'Ej. 297'} />
        </Field>
      </Modal>
    </div>
  );
}
