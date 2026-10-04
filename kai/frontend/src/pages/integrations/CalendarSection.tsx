/* Calendario: Google Calendar (OAuth), Calendly (token personal) y la agenda interna de KAI. Solo un calendario externo activo a la vez. */
import { useId, useState } from 'react';
import { useNavigate } from 'react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { BookOpen, CalendarCheck, CalendarClock, CalendarDays, Eye, EyeOff, Link2, Lock, Plug, RefreshCw, Unplug } from 'lucide-react';
import { api, errorText } from '../../lib/api';
import { timeAgo } from '../../lib/format';
import { Button, Callout, ConfirmDialog, Field, Input, Select, useToast } from '../../components/ui';
import { ConnBadge, connState, ExtLink, Guide, INTEGRATIONS_KEY, IntegrationHead, Steps, UiLabel, type CalendarRow, type IntegrationsResponse } from './shared';

interface CalendlyEventType {
  uri: string;
  name: string;
  duration: number;
}

interface CalendlyConnectResponse {
  connectionId: string;
  eventTypes: CalendlyEventType[];
  selected: string | null;
  webhookError: string | null;
}

/** Claves de React Query que dependen del calendario conectado. */
function useInvalidateCalendar() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: INTEGRATIONS_KEY });
    void qc.invalidateQueries({ queryKey: ['availability'] });
    void qc.invalidateQueries({ queryKey: ['slots'] });
  };
}

function CalendarErrorBox({ row }: { row: CalendarRow }) {
  if (row.status !== 'error') return null;
  return (
    <Callout tone="danger">
      <strong>Hay un problema con esta conexión.</strong> {row.lastError ? <span className="intg-break">«{row.lastError}»</span> : null}
      <br />
      Prueba a desconectarla y volver a conectarla.
    </Callout>
  );
}

// ───────────── Google Calendar ─────────────

function GoogleCard({ data, google, calendly, canManage }: { data: IntegrationsResponse; google: CalendarRow | undefined; calendly: CalendarRow | undefined; canManage: boolean }) {
  const toast = useToast();
  const invalidate = useInvalidateCalendar();
  const [confirmSwitch, setConfirmSwitch] = useState(false);
  const [confirmOff, setConfirmOff] = useState(false);
  const available = data.server.google;

  const connect = useMutation({
    mutationFn: async () => {
      // Calendly sigue conectado hasta que Google confirme: el servidor lo sustituye al guardar la conexión de Google,
      // así que si el entrenador cancela en la pantalla de Google no se queda sin calendario.
      const { url } = await api.get<{ url: string }>('/integrations/google/connect');
      return url;
    },
    onSuccess: (url) => {
      window.location.href = url;
    },
    onError: (e) => {
      setConfirmSwitch(false);
      toast(errorText(e), 'error');
      invalidate();
    },
  });
  const disconnect = useMutation({
    mutationFn: () => api.del('/integrations/calendar/google'),
    onSuccess: () => {
      toast('Google Calendar desconectado. KAI usará su propia agenda.');
      setConfirmOff(false);
      invalidate();
    },
    onError: (e) => toast(errorText(e), 'error'),
  });

  const start = () => (calendly ? setConfirmSwitch(true) : connect.mutate());

  return (
    <section className="card" aria-labelledby="intg-google">
      <IntegrationHead
        logo={<CalendarDays />}
        title={<span id="intg-google">Google Calendar</span>}
        subtitle="Tu calendario de Google"
        status={google ? <ConnBadge state={connState([google])} /> : available ? <ConnBadge state="none" /> : <span className="badge badge-warning badge-dot">No disponible</span>}
      />
      <p className="intg-desc">
        KAI consulta las horas que tienes ocupadas en tu Google Calendar para no proponer llamadas encima de otros compromisos, y apunta allí las llamadas que
        agenda.
      </p>
      {google ? (
        <div className="col gap-12 mt-16">
          <div className="intg-account">
            <dl className="kv">
              <dt>Cuenta</dt>
              <dd>
                <strong>{google.accountEmail ?? '—'}</strong>
              </dd>
              <dt>Calendario</dt>
              <dd>{!google.calendarId || google.calendarId === 'primary' ? 'Calendario principal' : google.calendarId}</dd>
              {google.lastSyncAt && (
                <>
                  <dt>Última consulta</dt>
                  <dd>{timeAgo(google.lastSyncAt)}</dd>
                </>
              )}
            </dl>
          </div>
          <CalendarErrorBox row={google} />
          {canManage && (
            <div className="row wrap">
              <Button icon={RefreshCw} loading={connect.isPending} disabled={!available} onClick={() => connect.mutate()}>
                Volver a conectar
              </Button>
              <Button variant="ghost" icon={Unplug} onClick={() => setConfirmOff(true)}>
                Desconectar
              </Button>
            </div>
          )}
        </div>
      ) : (
        <div className="col gap-12 mt-16">
          {!available && (
            <Callout tone="warning">
              Google Calendar no está activado en este servidor de KAI: faltan las claves <code className="code-inline">GOOGLE_CLIENT_ID</code> y{' '}
              <code className="code-inline">GOOGLE_CLIENT_SECRET</code>. Si no administras el servidor, pide a quien lo haga que las configure. Mientras tanto,
              KAI usa su propia agenda.
            </Callout>
          )}
          <div className="row wrap">
            <Button variant="primary" icon={Plug} loading={connect.isPending} disabled={!canManage || !available} onClick={start}>
              Conectar Google Calendar
            </Button>
          </div>
          {available && (
            <p className="xs subtle">
              Te llevaremos a Google para que elijas tu cuenta y aceptes los permisos. Después volverás aquí automáticamente. Si Google te dice que la app no
              está verificada o que no tienes acceso, pide a quien administra KAI que añada tu email como usuario de prueba.
            </p>
          )}
        </div>
      )}
      <ConfirmDialog
        open={confirmSwitch}
        title="¿Cambiar de Calendly a Google Calendar?"
        message="Solo puede haber un calendario conectado a la vez. Te llevamos a Google para conectar tu calendario y, cuando lo confirmes, sustituirá a Calendly. Si cancelas en Google, Calendly sigue conectado como hasta ahora."
        confirmLabel="Continuar con Google"
        loading={connect.isPending}
        onConfirm={() => connect.mutate()}
        onClose={() => setConfirmSwitch(false)}
      />
      <ConfirmDialog
        open={confirmOff}
        title="¿Desconectar Google Calendar?"
        message="KAI dejará de mirar tus horas ocupadas en Google y de apuntar allí las llamadas. Seguirá agendando con su propia agenda y tu disponibilidad. Las llamadas ya agendadas no se borran."
        confirmLabel="Desconectar"
        danger
        loading={disconnect.isPending}
        onConfirm={() => disconnect.mutate()}
        onClose={() => setConfirmOff(false)}
      />
    </section>
  );
}

// ───────────── Calendly ─────────────

function CalendlyCard({
  google,
  calendly,
  canManage,
  eventTypes,
  setEventTypes,
}: {
  google: CalendarRow | undefined;
  calendly: CalendarRow | undefined;
  canManage: boolean;
  eventTypes: CalendlyEventType[] | null;
  setEventTypes: (v: CalendlyEventType[] | null) => void;
}) {
  const toast = useToast();
  const invalidate = useInvalidateCalendar();
  const tokenId = useId();
  const typeId = useId();
  const [formOpen, setFormOpen] = useState(false);
  const [token, setToken] = useState('');
  const [showToken, setShowToken] = useState(false);
  const [touched, setTouched] = useState(false);
  const [confirmConnect, setConfirmConnect] = useState(false);
  const [confirmOff, setConfirmOff] = useState(false);
  const [lastWebhookError, setLastWebhookError] = useState<string | null>(null);

  const tokenClean = token.trim();
  const tokenError = !tokenClean ? 'Pega tu token de Calendly.' : tokenClean.length < 20 ? 'Parece incompleto: el token es un texto muy largo. Cópialo entero.' : null;

  const connect = useMutation({
    mutationFn: () => {
      const previousType = calendly?.calendarId && /^https?:\/\//.test(calendly.calendarId) ? calendly.calendarId : undefined;
      // Al volver a conectar NO se desconecta antes la conexión actual: el servidor comprueba primero el token nuevo y, solo si
      // Calendly lo acepta, sustituye la conexión (y su aviso de reservas). Si el token está mal, la conexión anterior sigue funcionando.
      return api.post<CalendlyConnectResponse>('/integrations/calendly', { token: tokenClean, ...(previousType ? { eventTypeUri: previousType } : {}) });
    },
    onSuccess: (r) => {
      setEventTypes(r.eventTypes);
      setLastWebhookError(r.webhookError);
      setToken('');
      setTouched(false);
      setFormOpen(false);
      setConfirmConnect(false);
      if (r.webhookError) toast('Calendly conectado, pero sin aviso automático de reservas. Revisa el mensaje de la tarjeta.', 'info');
      else if (!r.selected && r.eventTypes.length > 1) toast('Calendly conectado. Ahora elige qué tipo de evento debe ofrecer KAI.', 'info');
      else toast('Calendly conectado');
      invalidate();
    },
    onError: (e) => {
      setConfirmConnect(false);
      toast(errorText(e), 'error');
      invalidate();
    },
  });

  const chooseType = useMutation({
    mutationFn: (eventTypeUri: string) => api.patch<{ ok: true }>('/integrations/calendly', { eventTypeUri }),
    onSuccess: () => {
      toast('Tipo de evento guardado');
      invalidate();
    },
    onError: (e) => toast(errorText(e), 'error'),
  });

  const disconnect = useMutation({
    mutationFn: () => api.del('/integrations/calendar/calendly'),
    onSuccess: () => {
      toast('Calendly desconectado. KAI usará su propia agenda.');
      setConfirmOff(false);
      setEventTypes(null);
      setLastWebhookError(null);
      invalidate();
    },
    onError: (e) => toast(errorText(e), 'error'),
  });

  const submit = () => {
    setTouched(true);
    if (tokenError) return;
    if (google && !calendly) setConfirmConnect(true);
    else connect.mutate();
  };

  const storedWebhookError = typeof calendly?.config.webhookError === 'string' && calendly.config.webhookError ? calendly.config.webhookError : null;
  const webhookError = lastWebhookError ?? storedWebhookError;
  const selectedType = eventTypes?.find((t) => t.uri === calendly?.calendarId);
  const showForm = !calendly || formOpen;

  return (
    <section className="card" aria-labelledby="intg-calendly">
      <IntegrationHead logo={<CalendarCheck />} title={<span id="intg-calendly">Calendly</span>} subtitle="Tu página de reservas de Calendly" status={<ConnBadge state={calendly ? connState([calendly]) : 'none'} />} />
      <p className="intg-desc">
        Si ya usas Calendly, KAI ofrece al lead los huecos libres de tu Calendly y le envía el enlace para confirmar la reserva. En ese caso se usan los
        horarios de Calendly en lugar de la disponibilidad de la Agenda de KAI.
      </p>

      {calendly && (
        <div className="col gap-12 mt-16">
          <div className="intg-account">
            <dl className="kv">
              <dt>Cuenta</dt>
              <dd>
                <strong>{calendly.accountEmail ?? '—'}</strong>
              </dd>
              <dt>Tipo de evento</dt>
              <dd>
                {selectedType ? (
                  `${selectedType.name} (${selectedType.duration} min)`
                ) : calendly.calendarId ? (
                  calendly.schedulingUrl ? 'Elegido (es el del enlace de reserva)' : 'Elegido'
                ) : (
                  <span className="subtle">Sin elegir</span>
                )}
              </dd>
              {calendly.schedulingUrl && (
                <>
                  <dt>Enlace de reserva</dt>
                  <dd>
                    <ExtLink href={calendly.schedulingUrl}>{calendly.schedulingUrl.replace(/^https?:\/\//, '')}</ExtLink>
                  </dd>
                </>
              )}
            </dl>
          </div>
          <CalendarErrorBox row={calendly} />
          {webhookError && (
            <Callout tone="warning">
              <strong>Calendly no ha permitido crear el aviso automático de reservas (webhook).</strong> Suele pasar por dos motivos: tu plan de Calendly
              no incluye webhooks (hace falta el plan Standard o superior) o KAI todavía no está publicado en una dirección pública de internet. KAI seguirá
              enviando tu enlace de reserva, pero no se enterará solo cuando alguien reserve o cancele: tendrás que apuntar esas llamadas tú en la Agenda.
              Cuando lo soluciones, pulsa «Volver a conectar». <span className="xs subtle intg-break">Detalle: {webhookError}</span>
            </Callout>
          )}
          {eventTypes && eventTypes.length === 0 && (
            <Callout tone="warning">
              No tienes tipos de evento activos en Calendly. Crea uno en Calendly (por ejemplo, tu llamada de valoración) y vuelve a conectar.
            </Callout>
          )}
          {eventTypes && eventTypes.length > 0 && (
            <Field label="¿Qué tipo de evento debe ofrecer KAI?" htmlFor={typeId} hint="Es la llamada que KAI propondrá a tus leads. Se guarda al elegirlo.">
              <Select
                id={typeId}
                value={calendly.calendarId ?? ''}
                disabled={!canManage || chooseType.isPending}
                onChange={(e) => e.target.value && chooseType.mutate(e.target.value)}
                options={[
                  ...(calendly.calendarId && eventTypes.some((t) => t.uri === calendly.calendarId) ? [] : [{ value: '', label: 'Elige un tipo de evento…' }]),
                  ...eventTypes.map((t) => ({ value: t.uri, label: `${t.name} (${t.duration} min)` })),
                ]}
              />
            </Field>
          )}
          {!eventTypes && !calendly.calendarId && (
            <Callout tone="warning">
              Todavía no has elegido qué tipo de evento debe ofrecer KAI. Pulsa «Cambiar tipo de evento» para elegirlo.
            </Callout>
          )}
          {canManage && !formOpen && (
            <div className="row wrap">
              {!eventTypes && (
                <Button icon={CalendarClock} onClick={() => setFormOpen(true)}>
                  Cambiar tipo de evento
                </Button>
              )}
              <Button icon={RefreshCw} variant={eventTypes ? 'secondary' : 'ghost'} onClick={() => setFormOpen(true)}>
                Volver a conectar
              </Button>
              <Button variant="ghost" icon={Unplug} onClick={() => setConfirmOff(true)}>
                Desconectar
              </Button>
            </div>
          )}
        </div>
      )}

      {showForm && (
        <form
          className="col gap-12 mt-16"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          {calendly && (
            <p className="small muted">
              Por seguridad, KAI no muestra tu token guardado. Para ver tus tipos de evento o cambiar de cuenta, pega de nuevo tu token (el mismo u otro nuevo).
              Si Calendly no acepta el token, no se cambia nada: KAI seguirá usando tu conexión actual.
            </p>
          )}
          <Field label="Token de acceso personal de Calendly" htmlFor={tokenId} error={touched ? tokenError : null} hint="Lo generas en Calendly en un minuto: abre la guía de abajo.">
            <div className="intg-copy">
              <Input
                id={tokenId}
                type={showToken ? 'text' : 'password'}
                autoComplete="off"
                spellCheck={false}
                className="intg-mono"
                value={token}
                disabled={!canManage}
                onChange={(e) => setToken(e.target.value)}
              />
              <Button iconOnly icon={showToken ? EyeOff : Eye} onClick={() => setShowToken((s) => !s)} aria-pressed={showToken}>
                {showToken ? 'Ocultar token' : 'Mostrar token'}
              </Button>
            </div>
          </Field>
          <div className="row wrap">
            <Button type="submit" variant="primary" icon={Plug} loading={connect.isPending} disabled={!canManage}>
              {calendly ? 'Volver a conectar' : 'Conectar Calendly'}
            </Button>
            {calendly && (
              <Button
                variant="ghost"
                onClick={() => {
                  setFormOpen(false);
                  setToken('');
                  setTouched(false);
                }}
              >
                Cancelar
              </Button>
            )}
          </div>
        </form>
      )}

      <div className="mt-16">
        <Guide icon={BookOpen} title="Cómo conseguir el token de Calendly">
          <Steps>
            <li>
              Entra en <ExtLink href="https://calendly.com/integrations/api_webhooks">Calendly → Integraciones y aplicaciones → API y webhooks</ExtLink> con
              tu cuenta.
            </li>
            <li>
              En <UiLabel>Tokens de acceso personal</UiLabel>, pulsa <UiLabel>Generar nuevo token</UiLabel>, ponle un nombre (por ejemplo, KAI) y cópialo.
              Calendly solo lo enseña una vez.
            </li>
            <li>Pégalo aquí y pulsa «Conectar Calendly». Si tienes varios tipos de evento, elige después cuál debe ofrecer KAI.</li>
            <li>
              Para que KAI se entere solo de las reservas y cancelaciones, KAI crea un webhook (aviso automático) en tu Calendly. Para eso tu plan de Calendly
              tiene que incluir webhooks (Standard o superior) y KAI debe estar publicado en una dirección pública. Si no se puede crear, aquí te lo
              indicaremos.
            </li>
          </Steps>
        </Guide>
      </div>

      <ConfirmDialog
        open={confirmConnect}
        title="¿Cambiar de Google Calendar a Calendly?"
        message="Solo puede haber un calendario conectado a la vez: al conectar Calendly se desconectará Google Calendar."
        confirmLabel="Conectar Calendly"
        loading={connect.isPending}
        onConfirm={() => connect.mutate()}
        onClose={() => setConfirmConnect(false)}
      />
      <ConfirmDialog
        open={confirmOff}
        title="¿Desconectar Calendly?"
        message="KAI dejará de ofrecer los huecos de tu Calendly y volverá a usar su propia agenda con tu disponibilidad. Las llamadas ya agendadas no se borran."
        confirmLabel="Desconectar"
        danger
        loading={disconnect.isPending}
        onConfirm={() => disconnect.mutate()}
        onClose={() => setConfirmOff(false)}
      />
    </section>
  );
}

// ───────────── Sección ─────────────

export function CalendarSection({ data, canManage }: { data: IntegrationsResponse; canManage: boolean }) {
  const navigate = useNavigate();
  // Los tipos de evento de Calendly solo los devuelve el servidor al conectar: se guardan aquí mientras sigas en la página.
  const [eventTypes, setEventTypes] = useState<CalendlyEventType[] | null>(null);
  const active = data.calendars.filter((c) => c.status !== 'disconnected');
  const google = active.find((c) => c.provider === 'google');
  const calendly = active.find((c) => c.provider === 'calendly');
  const current = calendly ? 'Calendly' : google ? 'Google Calendar' : null;

  return (
    <div className="intg-section">
      <section className="card" aria-labelledby="intg-internal">
        <IntegrationHead
          logo={<CalendarClock />}
          title={<span id="intg-internal">Agenda de KAI</span>}
          subtitle="Incluida, no hace falta conectar nada"
          status={current ? <span className="badge badge-dot">Disponible</span> : <span className="badge badge-dot badge-accent">En uso</span>}
        />
        <p className="intg-desc">
          KAI siempre tiene su propia agenda: ofrece huecos según la disponibilidad que configures en <strong>Agenda</strong> y guarda allí las llamadas.
          {current === 'Google Calendar' && ' Como tienes Google Calendar conectado, además descuenta tus horas ocupadas en Google.'}
          {current === 'Calendly' && ' Ahora mismo tienes Calendly conectado, así que los huecos salen de tu Calendly.'}
        </p>
        <div className="row wrap mt-12">
          <Button icon={CalendarClock} onClick={() => navigate('/app/agenda')}>
            Configurar disponibilidad
          </Button>
          <span className="small muted row">
            <Link2 aria-hidden size={14} />
            Calendario en uso: <strong>{current ?? 'Agenda de KAI'}</strong>
          </span>
        </div>
      </section>

      <Callout tone="info">
        <strong>Solo un calendario externo a la vez.</strong> Puedes conectar Google Calendar <em>o</em> Calendly. Si conectas uno, el otro se desconecta.
      </Callout>

      <div className="grid-2 intg-grid-top">
        <GoogleCard data={data} google={google} calendly={calendly} canManage={canManage} />
        <CalendlyCard google={google} calendly={calendly} canManage={canManage} eventTypes={calendly ? eventTypes : null} setEventTypes={setEventTypes} />
      </div>
      <p className="xs subtle row">
        <Lock aria-hidden size={12} />
        Las conexiones se guardan cifradas. KAI nunca te vuelve a mostrar los tokens que pegas.
      </p>
    </div>
  );
}
