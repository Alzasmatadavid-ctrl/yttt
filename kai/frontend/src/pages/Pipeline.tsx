import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ArrowRightLeft, Check, RotateCw, Search, SquareKanban } from 'lucide-react';
import { LEAD_STATUSES, leadStatusLabel, type LeadStatus } from '@shared';
import { api, errorText } from '../lib/api';
import { money, parseOptionalAmount, timeAgo } from '../lib/format';
import { useBusinessSettings } from '../lib/business';
import { Button, EmptyState, Modal, PageHeader, PageLoading, useToast, Field, Input } from '../components/ui';
import { LeadAvatar, ScoreBadge, TemperatureBadge } from '../components/lead-bits';
import type { Lead } from '../lib/types';

export default function Pipeline() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const [search, setSearch] = useState('');
  const [dragId, setDragId] = useState<string | null>(null);
  const [overCol, setOverCol] = useState<LeadStatus | null>(null);
  const [clientModal, setClientModal] = useState<{ leadId: string } | null>(null);
  // Alternativa a arrastrar (móvil y teclado): botón «Mover» de cada tarjeta.
  const [moveFor, setMoveFor] = useState<Lead | null>(null);
  const [deal, setDeal] = useState('');
  const [dealError, setDealError] = useState<string | null>(null);
  const { data, isLoading, error, refetch, isFetching } = useQuery({ queryKey: ['leads', 'pipeline'], queryFn: () => api.get<{ leads: Lead[] }>('/leads', { limit: 500, sort: 'score' }), refetchInterval: 20_000 });
  const settings = useBusinessSettings();
  const price = settings.data?.services.find((s) => s.isPrimary)?.priceCents ?? 0;
  const currency = settings.data?.business.currency || 'EUR';

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
  if (!data) {
    return (
      <div className="page">
        <EmptyState
          icon={AlertTriangle}
          title="No se pudo cargar el pipeline"
          description={errorText(error)}
          action={
            <Button icon={RotateCw} loading={isFetching} onClick={() => void refetch()}>
              Reintentar
            </Button>
          }
        />
      </div>
    );
  }

  /** Cambia la etapa de un lead (al soltarlo en una columna o desde «Mover»). «Cliente» pide antes el importe. */
  const changeStatus = (lead: Lead, status: LeadStatus) => {
    if (lead.status === status) return;
    if (status === 'client') {
      setDeal('');
      setDealError(null);
      setClientModal({ leadId: lead.id });
      return;
    }
    move.mutate({ leadId: lead.id, status });
  };

  const drop = (status: LeadStatus) => {
    setOverCol(null);
    const lead = leads.find((l) => l.id === dragId);
    setDragId(null);
    if (lead) changeStatus(lead, status);
  };

  /** Desplaza el tablero hasta la columna de una etapa (atajos de la barra de etapas). */
  const goToColumn = (status: LeadStatus) => {
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    document.getElementById(`board-col-${status}`)?.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'nearest', inline: 'start' });
  };

  const confirmClient = () => {
    if (!clientModal) return;
    const amount = parseOptionalAmount(deal, { currency });
    if (amount.error) return setDealError(amount.error);
    move.mutate({ leadId: clientModal.leadId, status: 'client', dealValueCents: amount.cents });
    setClientModal(null);
  };

  return (
    <div className="page" style={{ maxWidth: 'none' }}>
      <PageHeader
        title="Pipeline"
        description="Arrastra los leads entre etapas o usa el botón «Mover» de cada tarjeta. KAI también los mueve solo según lo que pasa en cada conversación."
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
        <>
          {/* Atajos a cada etapa: en el móvil se ve una columna cada vez y así se sabe cuántas hay y cuántos leads tiene cada una. */}
          <nav className="board-nav" aria-label="Ir a una etapa del pipeline">
            {LEAD_STATUSES.map((s) => (
              <button key={s.key} type="button" className="chip" onClick={() => goToColumn(s.key)}>
                {s.label} <span className="count">{byStatus.get(s.key)?.length ?? 0}</span>
              </button>
            ))}
          </nav>
          <div className="board">
            {LEAD_STATUSES.map((s) => {
              const col = byStatus.get(s.key) ?? [];
              const value = col.length * price;
              return (
                <section
                  key={s.key}
                  id={`board-col-${s.key}`}
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
                      <div
                        key={l.id}
                        className={`lead-card ${dragId === l.id ? 'dragging' : ''}`}
                        draggable
                        onDragStart={(e) => {
                          setDragId(l.id);
                          e.dataTransfer.effectAllowed = 'move';
                        }}
                        onDragEnd={() => setDragId(null)}
                      >
                        <button type="button" className="lead-card-main" onClick={() => navigate(`/app/leads/${l.id}`)}>
                          <span className="row" style={{ gap: 8 }}>
                            <LeadAvatar name={l.name} url={l.avatarUrl} size={28} channel={l.source} />
                            <strong className="ellipsis grow small">{l.name || 'Sin nombre'}</strong>
                            <ScoreBadge score={l.score} />
                          </span>
                          {l.goalSummary && <span className="muted xs ellipsis">{l.goalSummary}</span>}
                        </button>
                        <div className="row-between" style={{ gap: 6 }}>
                          <TemperatureBadge temperature={l.temperature} />
                          <span className="row" style={{ gap: 4 }}>
                            <span className="subtle xs">{timeAgo(l.lastInteractionAt ?? l.createdAt)}</span>
                            <Button variant="ghost" size="sm" iconOnly icon={ArrowRightLeft} className="lead-card-move" onClick={() => setMoveFor(l)} title="Mover a otra etapa">
                              {`Mover a ${l.name || 'este lead'} a otra etapa`}
                            </Button>
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                </section>
              );
            })}
          </div>
        </>
      )}
      <Modal open={Boolean(moveFor)} onClose={() => setMoveFor(null)} title={`Mover a ${moveFor?.name || 'este lead'}`}>
        {moveFor && (
          <>
            <p className="muted small" style={{ marginTop: 0, marginBottom: 12 }}>
              Ahora está en <strong>{leadStatusLabel(moveFor.status)}</strong>. Elige la nueva etapa:
            </p>
            <div className="stage-options">
              {LEAD_STATUSES.map((s) => {
                const current = s.key === moveFor.status;
                return (
                  <button
                    key={s.key}
                    type="button"
                    className="option"
                    aria-pressed={current}
                    disabled={current}
                    onClick={() => {
                      const lead = moveFor;
                      setMoveFor(null);
                      changeStatus(lead, s.key);
                    }}
                  >
                    <span>{s.label}</span>
                    {current && <Check aria-label="Etapa actual" />}
                  </button>
                );
              })}
            </div>
          </>
        )}
      </Modal>
      <Modal
        open={Boolean(clientModal)}
        onClose={() => setClientModal(null)}
        title="¡Nuevo cliente!"
        footer={
          <>
            <Button onClick={() => setClientModal(null)}>Cancelar</Button>
            <Button variant="primary" onClick={confirmClient}>
              Marcar como cliente
            </Button>
          </>
        }
      >
        <Field label="Importe de la venta (opcional)" hint="Se usa para calcular ingresos y ROI. Si lo dejas vacío, se toma el precio del servicio principal." error={dealError}>
          <Input
            inputMode="decimal"
            value={deal}
            onChange={(e) => {
              setDeal(e.target.value);
              setDealError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') confirmClient();
            }}
            placeholder={price ? String(price / 100).replace('.', ',') : 'Ej. 297 o 1.200,50'}
          />
        </Field>
      </Modal>
    </div>
  );
}
