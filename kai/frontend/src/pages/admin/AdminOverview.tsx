/* Resumen global de la plataforma: negocios, usuarios, leads, mensajes, ingresos y salud del sistema. */
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import {
  Bot,
  Building2,
  CircleCheck,
  CreditCard,
  Euro,
  Hourglass,
  Inbox,
  ListChecks,
  ListTodo,
  MessagesSquare,
  ServerCrash,
  TriangleAlert,
  UserCheck,
  UserPlus,
  Users,
  Trophy,
} from 'lucide-react';
import { api } from '../../lib/api';
import { money, pct } from '../../lib/format';
import { Button, Callout, PageHeader, PageLoading, Stat } from '../../components/ui';
import { ADMIN_KEYS, QueryError, num, type AdminOverviewData } from './admin-shared';
import '../../styles/admin.css';

const share = (part: number, total: number) => pct(total > 0 ? (part / total) * 100 : 0);

export default function AdminOverview() {
  const navigate = useNavigate();
  const q = useQuery({ queryKey: ADMIN_KEYS.overview, queryFn: () => api.get<AdminOverviewData>('/admin/overview'), refetchInterval: 60_000 });

  const header = <PageHeader title="Resumen de la plataforma" description="La foto general de KAI: cuántos negocios lo usan, cuánta actividad hay y si todo funciona bien." />;

  if (q.isPending) return <PageLoading />;
  if (q.isError) {
    return (
      <div className="page">
        {header}
        <div className="card">
          <QueryError error={q.error} onRetry={() => void q.refetch()} retrying={q.isFetching} />
        </div>
      </div>
    );
  }

  const d = q.data;
  const biz = d.businesses ?? { total: 0, active: 0, trialing: 0, paying: 0, onboarded: 0 };
  const users = d.users ?? { total: 0, active30: 0 };
  const leads = d.leads ?? { total: 0, last30: 0, clients: 0 };
  const messages = d.messages ?? { last30: 0, kai: 0 };
  const jobs = d.jobs ?? { pending: 0, failed: 0 };
  const suspended = Math.max(0, biz.total - biz.active);
  const healthy = jobs.failed === 0 && d.errorsLast24h === 0;

  return (
    <div className="page">
      {header}

      <section className="adm-section" aria-labelledby="ov-biz">
        <div className="adm-section-head">
          <h2 id="ov-biz" className="section-title">
            Negocios
          </h2>
        </div>
        <div className="grid-5">
          <Stat label="Negocios totales" icon={Building2} value={num(biz.total)} sub="Registrados en KAI" onClick={() => navigate('/admin/negocios')} />
          <Stat label="Activos" icon={CircleCheck} value={num(biz.active)} sub={suspended > 0 ? `${num(suspended)} suspendido${suspended === 1 ? '' : 's'}` : 'Ninguno suspendido'} />
          <Stat label="En periodo de prueba" icon={Hourglass} value={num(biz.trialing)} sub="Probando KAI, aún sin pagar" />
          <Stat label="De pago" icon={CreditCard} value={num(biz.paying)} sub="Con la suscripción activa" />
          <Stat label="Configuración completada" icon={ListChecks} value={num(biz.onboarded)} sub={biz.total > 0 ? `${share(biz.onboarded, biz.total)} del total ha terminado la puesta en marcha inicial` : 'Han terminado la puesta en marcha inicial'} />
        </div>
      </section>

      <section className="adm-section" aria-labelledby="ov-activity">
        <div className="adm-section-head">
          <h2 id="ov-activity" className="section-title">
            Usuarios y leads
          </h2>
        </div>
        <div className="grid-5">
          <Stat label="Usuarios" icon={Users} value={num(users.total)} sub="Cuentas creadas" onClick={() => navigate('/admin/usuarios')} />
          <Stat label="Activos en 30 días" icon={UserCheck} value={num(users.active30)} sub="Han iniciado sesión en el último mes" />
          <Stat label="Leads totales" icon={Inbox} value={num(leads.total)} sub="Sin contar los leads de prueba" />
          <Stat label="Leads nuevos (30 días)" icon={UserPlus} value={num(leads.last30)} sub="Entrados en el último mes" />
          <Stat label="Clientes conseguidos" icon={Trophy} value={num(leads.clients)} sub="Leads marcados como «Cliente»" />
        </div>
      </section>

      <section className="adm-section" aria-labelledby="ov-money">
        <div className="adm-section-head">
          <h2 id="ov-money" className="section-title">
            Mensajes e ingresos
          </h2>
        </div>
        <div className="grid-3">
          <Stat label="Mensajes (30 días)" icon={MessagesSquare} value={num(messages.last30)} sub="Enviados y recibidos en todas las conversaciones" />
          <Stat label="Mensajes de KAI (30 días)" icon={Bot} value={num(messages.kai)} sub={messages.last30 > 0 ? `El ${share(messages.kai, messages.last30)} de todos los mensajes` : 'Respuestas enviadas por KAI'} />
          <Stat label="Ingresos mensuales (MRR)" icon={Euro} value={money(d.mrrCents)} sub="Suma del precio mensual de los negocios activos y de pago" />
        </div>
        <p className="subtle xs mt-8">
          MRR significa «ingresos mensuales recurrentes». Es una estimación a partir del plan asignado a cada negocio activo con suscripción de pago; no refleja cobros reales.
        </p>
      </section>

      <section className="adm-section" aria-labelledby="ov-health">
        <div className="adm-section-head">
          <h2 id="ov-health" className="section-title">
            Salud del sistema
          </h2>
          <Button size="sm" variant="ghost" onClick={() => navigate('/admin/registros')}>
            Ver registros
          </Button>
        </div>
        <div className="grid-3">
          <Stat
            label="Trabajos pendientes"
            icon={ListTodo}
            value={num(jobs.pending)}
            sub="Tareas programadas que aún no se han ejecutado (respuestas, recordatorios…)"
            onClick={() => navigate('/admin/registros?tab=trabajos')}
          />
          <Stat label="Trabajos fallidos" icon={TriangleAlert} value={num(jobs.failed)} sub="Tareas que fallaron tras varios intentos" onClick={() => navigate('/admin/registros?tab=trabajos')} />
          <Stat label="Errores (24 horas)" icon={ServerCrash} value={num(d.errorsLast24h)} sub="Fallos registrados en el último día" onClick={() => navigate('/admin/registros?tab=errores')} />
        </div>
        <div className="mt-12">
          {healthy ? (
            <Callout tone="accent" icon={CircleCheck}>
              Todo en orden: no hay trabajos fallidos ni errores registrados en las últimas 24 horas.
            </Callout>
          ) : (
            <Callout tone="warning">
              {jobs.failed > 0 && (
                <>
                  Hay {num(jobs.failed)} trabajo{jobs.failed === 1 ? '' : 's'} fallido{jobs.failed === 1 ? '' : 's'}: puede que algún lead no haya recibido una respuesta o un recordatorio. Revísalos y reinténtalos desde{' '}
                  <strong>Registros → Cola de trabajos</strong>.{' '}
                </>
              )}
              {d.errorsLast24h > 0 && (
                <>
                  Se han registrado {num(d.errorsLast24h)} error{d.errorsLast24h === 1 ? '' : 'es'} en las últimas 24 horas; los tienes en <strong>Registros → Errores</strong>.
                </>
              )}
            </Callout>
          )}
        </div>
      </section>
    </div>
  );
}
