/* Canales de Meta: WhatsApp Business (Cloud API), Instagram (mensajes directos) y anuncios con formulario (Lead Ads). */
import { useId, useState, type ReactNode } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { BookOpen, Eye, EyeOff, Info, KeyRound, ListChecks, Megaphone, Pencil, Plug, Save, ServerCog, ShieldCheck, Unplug, Webhook } from 'lucide-react';
import type { ChannelConfig, TemplateRef } from '@shared';
import { api, errorText } from '../../lib/api';
import { timeAgo } from '../../lib/format';
import { Button, Callout, Card, ConfirmDialog, Field, Input, Modal, Select, Switch, TagInput, useToast } from '../../components/ui';
import { InstagramIcon, WhatsAppIcon } from '../../components/lead-bits';
import { cleanConfig, ConnBadge, connState, CopyField, ExtLink, Guide, INTEGRATIONS_KEY, IntegrationHead, Steps, UiLabel, type ChannelRow, type IntegrationsResponse } from './shared';

type MetaChannel = ChannelRow['channel'];

interface ChannelDef {
  key: MetaChannel;
  title: string;
  subtitle: string;
  logo: ReactNode;
  description: ReactNode;
  idLabel: string;
  idHint: ReactNode;
  idPlaceholder: string;
  tokenHint: ReactNode;
  activityLabel: string;
  disconnectMessage: string;
}

const DEFS: Record<MetaChannel, ChannelDef> = {
  whatsapp: {
    key: 'whatsapp',
    title: 'WhatsApp Business',
    subtitle: 'API oficial de Meta (Cloud API)',
    logo: <WhatsAppIcon size={22} />,
    description: (
      <>
        KAI lee y responde los mensajes que llegan a tu número de WhatsApp Business. También puede escribir primero a los leads nuevos usando
        plantillas aprobadas por Meta (más abajo te explicamos qué son).
      </>
    ),
    idLabel: 'Identificador del número (Phone number ID)',
    idHint: 'Es un número largo que da Meta (unos 15 dígitos). No es tu número de teléfono.',
    idPlaceholder: 'Ej.: 123456789012345',
    tokenHint: 'Usa un token permanente de un «usuario del sistema» (en la guía te explicamos cómo crearlo). El temporal caduca en 24 horas.',
    activityLabel: 'Último mensaje recibido',
    disconnectMessage:
      'KAI dejará de recibir y de enviar mensajes por este número de WhatsApp. Tus leads y conversaciones no se borran y podrás volver a conectarlo cuando quieras.',
  },
  instagram: {
    key: 'instagram',
    title: 'Instagram',
    subtitle: 'Mensajes directos (DM) de tu cuenta profesional',
    logo: <InstagramIcon size={22} />,
    description: (
      <>
        KAI contesta los mensajes directos que llegan a tu cuenta de Instagram. Tu cuenta tiene que ser <strong>profesional</strong> (de empresa o de
        creador).
      </>
    ),
    idLabel: 'ID de la cuenta profesional de Instagram',
    idHint: 'Es un número largo que aparece junto a tu cuenta en el panel de la app de Meta de KAI. No es tu nombre de usuario.',
    idPlaceholder: 'Ej.: 17841400000000000',
    tokenHint: 'El token de acceso que generas en la app de Meta de KAI para tu cuenta de Instagram. Suele caducar pasados unos 60 días: cuando caduque, genera otro y pégalo con «Editar datos».',
    activityLabel: 'Último mensaje recibido',
    disconnectMessage:
      'KAI dejará de recibir y de contestar los mensajes directos de esta cuenta de Instagram. Tus leads y conversaciones no se borran y podrás volver a conectarla cuando quieras.',
  },
  meta_lead_ads: {
    key: 'meta_lead_ads',
    title: 'Meta Lead Ads',
    subtitle: 'Anuncios con formulario de Facebook e Instagram',
    logo: <Megaphone />,
    description: (
      <>
        Si haces anuncios con formulario (la persona deja sus datos sin salir de Facebook o Instagram), cada contacto entra solo en KAI al momento y
        KAI puede escribirle por WhatsApp.
      </>
    ),
    idLabel: 'ID de la página de Facebook',
    idHint: 'El número de la página de Facebook desde la que publicas los anuncios. Lo ves en tu página → Información → ID de la página.',
    idPlaceholder: 'Ej.: 104000000000000',
    tokenHint: 'Un token de página con los permisos leads_retrieval, pages_manage_metadata, pages_show_list y pages_read_engagement.',
    activityLabel: 'Último lead recibido',
    disconnectMessage:
      'Los contactos de tus anuncios con formulario dejarán de entrar en KAI. Los leads que ya tienes no se borran y podrás volver a conectarlo cuando quieras.',
  },
};

// ───────────── Conectar / editar ─────────────

/** Solo en desarrollo: permite conectar un canal de prueba sin comprobarlo con Meta (el servidor lo ignora en producción). */
const TEST_MODE_AVAILABLE = import.meta.env.DEV;

function ConnectChannelModal({ def, existing, onClose }: { def: ChannelDef; existing: ChannelRow | null; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const idId = useId();
  const tokenId = useId();
  const nameId = useId();
  const [accountId, setAccountId] = useState(existing?.externalAccountId ?? '');
  const [token, setToken] = useState('');
  const [showToken, setShowToken] = useState(false);
  const [displayName, setDisplayName] = useState(existing?.displayName ?? '');
  const [apiHost, setApiHost] = useState<NonNullable<ChannelConfig['apiHost']>>(existing?.config.apiHost ?? 'graph.instagram.com');
  const [testMode, setTestMode] = useState(false);
  const [touched, setTouched] = useState(false);

  const idClean = accountId.replace(/\s+/g, '');
  const tokenClean = token.trim();
  const changingAccount = Boolean(existing && idClean && idClean !== existing.externalAccountId);
  // Al editar la misma cuenta, el token es opcional: sin token solo se guardan el nombre y los ajustes (sin volver a comprobar con Meta).
  const tokenOptional = Boolean(existing) && !changingAccount;
  const onlyRename = tokenOptional && !tokenClean;
  const idError = !idClean ? 'Escribe el identificador.' : !/^\d+$/.test(idClean) ? 'Solo puede llevar números (sin letras, espacios ni guiones).' : idClean.length < 3 ? 'Es demasiado corto.' : null;
  const tokenError =
    !tokenClean && !tokenOptional
      ? changingAccount
        ? 'Para conectar otra cuenta, pega su token de acceso.'
        : 'Pega el token de acceso.'
      : tokenClean && tokenClean.length < 20
        ? 'Parece incompleto: un token es un texto muy largo. Cópialo entero.'
        : null;
  const submitLabel = !existing ? 'Conectar' : onlyRename || testMode ? 'Guardar' : 'Guardar y comprobar';

  const save = useMutation({
    mutationFn: async () => {
      const config = cleanConfig({ ...(existing?.config ?? {}), ...(def.key === 'instagram' ? { apiHost } : {}) });
      if (existing && onlyRename) {
        const res = await api.patch<{ connection: ChannelRow }>(`/integrations/channels/${existing.id}`, { config, displayName: displayName.trim() || undefined });
        return res.connection;
      }
      const typedName = displayName.trim() && !(changingAccount && displayName === existing?.displayName) ? displayName.trim() : undefined;
      const res = await api.post<{ connection: ChannelRow }>('/integrations/channels', {
        channel: def.key,
        externalAccountId: idClean,
        accessToken: tokenClean,
        // Al cambiar de cuenta, el nombre anterior no vale: dejamos que Meta dé el de la nueva (salvo que se haya escrito otro).
        displayName: typedName ?? (testMode ? `${def.title} (prueba)` : undefined),
        config,
        ...(testMode ? { skipVerification: true } : {}),
        // Si ha cambiado de cuenta, el servidor desconecta la anterior en la misma operación (y no la cuenta para el límite del plan),
        // así nunca quedan dos activas ni falla por el límite de canales al sustituir una cuenta por otra.
        ...(existing && changingAccount ? { replacesConnectionId: existing.id } : {}),
      });
      return res.connection;
    },
    onSuccess: (c) => {
      toast(existing ? `${def.title}: datos guardados` : `${def.title} conectado${c.displayName ? ` (${c.displayName})` : ''}`);
      void qc.invalidateQueries({ queryKey: INTEGRATIONS_KEY });
      onClose();
    },
    onError: (e) => {
      toast(errorText(e), 'error');
      void qc.invalidateQueries({ queryKey: INTEGRATIONS_KEY });
    },
  });

  const submit = () => {
    setTouched(true);
    if (idError || tokenError) return;
    save.mutate();
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={existing ? `Editar ${def.title}` : `Conectar ${def.title}`}
      footer={
        <>
          <Button onClick={onClose}>Cancelar</Button>
          <Button variant="primary" icon={existing ? Save : Plug} loading={save.isPending} onClick={submit}>
            {submitLabel}
          </Button>
        </>
      }
    >
      <form
        className="col gap-12"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <p className="muted small">
          {existing
            ? 'Si pegas un token, KAI lo comprueba con Meta antes de guardarlo. Si solo quieres cambiar el nombre visible, deja el token vacío.'
            : 'Al pulsar «Conectar», KAI comprueba con Meta que los datos son correctos antes de guardarlos.'}{' '}
          Si no sabes de dónde sacarlos, cierra esta ventana y abre «Cómo conseguir estos datos» en la tarjeta de {def.title}.
        </p>
        <Field label={def.idLabel} htmlFor={idId} hint={def.idHint} error={touched ? idError : null}>
          <Input id={idId} inputMode="numeric" autoComplete="off" placeholder={def.idPlaceholder} value={accountId} onChange={(e) => setAccountId(e.target.value)} />
        </Field>
        {changingAccount && (
          <Callout tone="warning">Has cambiado el identificador: se conectará esa otra cuenta y la actual ({existing?.displayName || existing?.externalAccountId}) se desconectará.</Callout>
        )}
        <Field
          label={tokenOptional ? 'Token de acceso (opcional)' : 'Token de acceso'}
          htmlFor={tokenId}
          hint={
            existing ? (
              <>Por seguridad, KAI nunca muestra el token guardado. Pega uno nuevo solo si el anterior ha caducado o quieres cambiarlo. {def.tokenHint}</>
            ) : (
              def.tokenHint
            )
          }
          error={touched ? tokenError : null}
        >
          <div className="intg-copy">
            <Input
              id={tokenId}
              type={showToken ? 'text' : 'password'}
              autoComplete="off"
              spellCheck={false}
              placeholder="Empieza normalmente por EAA… o IG…"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              className="intg-mono"
            />
            <Button iconOnly icon={showToken ? EyeOff : Eye} onClick={() => setShowToken((s) => !s)} aria-pressed={showToken}>
              {showToken ? 'Ocultar token' : 'Mostrar token'}
            </Button>
          </div>
        </Field>
        {def.key === 'instagram' && (
          <Field label="¿Cómo has creado el token? (servidor de la API)" hint="Si no lo sabes, deja la opción recomendada.">
            <ApiHostPicker value={apiHost} onChange={setApiHost} />
          </Field>
        )}
        <Field label="Nombre visible (opcional)" htmlFor={nameId} hint="Solo para reconocerlo en KAI. Si lo dejas vacío, usaremos el nombre que nos dé Meta.">
          <Input id={nameId} maxLength={120} placeholder={def.key === 'meta_lead_ads' ? 'Ej.: Página de mi estudio' : 'Ej.: WhatsApp del estudio'} value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
        </Field>
        {TEST_MODE_AVAILABLE && !onlyRename && (
          <div className="intg-testmode">
            <Switch checked={testMode} onChange={setTestMode} label={<strong>Modo de prueba: conectar sin comprobar con Meta</strong>} />
            <p className="xs muted">
              Solo aparece en el entorno de desarrollo y el servidor lo ignora en producción. Sirve para probar la pantalla con un identificador y un token
              inventados (el token debe tener al menos 20 caracteres). Ese canal no podrá enviar ni recibir mensajes reales.
            </p>
          </div>
        )}
      </form>
    </Modal>
  );
}

function ApiHostPicker({ value, onChange }: { value: NonNullable<ChannelConfig['apiHost']>; onChange: (v: NonNullable<ChannelConfig['apiHost']>) => void }) {
  const options: { value: NonNullable<ChannelConfig['apiHost']>; title: string; text: string }[] = [
    {
      value: 'graph.instagram.com',
      title: 'Inicio de sesión con Instagram (recomendado)',
      text: 'Generaste el token en la app de Meta de KAI, en Instagram → «Configuración de la API con inicio de sesión de Instagram».',
    },
    {
      value: 'graph.facebook.com',
      title: 'Inicio de sesión con Facebook',
      text: 'Tu Instagram está vinculado a una página de Facebook y el token es de Facebook (método antiguo).',
    },
  ];
  return (
    <div className="option-grid" role="group" aria-label="Tipo de conexión de Instagram">
      {options.map((o) => (
        <button key={o.value} type="button" className="option" aria-pressed={value === o.value} onClick={() => onChange(o.value)}>
          <strong>{o.title}</strong>
          <span className="small muted">{o.text}</span>
          <span className="xs subtle intg-mono">{o.value}</span>
        </button>
      ))}
    </div>
  );
}

// ───────────── Ajustes de WhatsApp: plantillas ─────────────

type TemplateKey = keyof NonNullable<ChannelConfig['templates']>;

const TEMPLATE_SLOTS: { key: TemplateKey; label: string; when: string; vars: string; example: string }[] = [
  {
    key: 'firstContact',
    label: 'Primer contacto',
    when: 'Cuando entra un lead nuevo (de tu web o de un anuncio) y KAI le escribe primero.',
    vars: '{{1}} = nombre del lead',
    example: 'Hola {{1}}, gracias por dejarnos tus datos. ¿Te cuento por aquí cómo podemos ayudarte?',
  },
  {
    key: 'followUp',
    label: 'Seguimiento',
    when: 'Cuando el lead deja de responder y ya han pasado más de 24 horas.',
    vars: '{{1}} = nombre del lead',
    example: 'Hola {{1}}, ¿pudiste ver mi último mensaje? Si te sigue interesando, seguimos por aquí.',
  },
  {
    key: 'reminder',
    label: 'Recordatorio de la llamada',
    when: 'Para confirmar la llamada agendada y recordársela antes, si han pasado más de 24 horas desde su último mensaje.',
    vars: '{{1}} = nombre del lead · {{2}} = día y hora de la llamada (por ejemplo, «martes 14 de octubre a las 18:00»)',
    example: 'Hola {{1}}, te recuerdo tu llamada de valoración el {{2}}. Si necesitas cambiarla, respóndeme por aquí.',
  },
  {
    key: 'noShow',
    label: 'No-show (no se presentó)',
    when: 'Cuando el lead no se conecta a la llamada y KAI intenta recuperarlo.',
    vars: '{{1}} = nombre del lead',
    example: 'Hola {{1}}, hoy no hemos podido hablar. ¿Quieres que busquemos otro hueco?',
  },
];

const LANGUAGES = [
  { value: 'es', label: 'Español (es)' },
  { value: 'es_ES', label: 'Español de España (es_ES)' },
  { value: 'es_MX', label: 'Español de México (es_MX)' },
  { value: 'es_AR', label: 'Español de Argentina (es_AR)' },
  { value: 'ca', label: 'Catalán (ca)' },
  { value: 'en', label: 'Inglés (en)' },
  { value: 'en_US', label: 'Inglés de EE. UU. (en_US)' },
  { value: 'en_GB', label: 'Inglés del Reino Unido (en_GB)' },
  { value: 'pt_BR', label: 'Portugués de Brasil (pt_BR)' },
  { value: 'pt_PT', label: 'Portugués de Portugal (pt_PT)' },
  { value: 'fr', label: 'Francés (fr)' },
  { value: 'it', label: 'Italiano (it)' },
  { value: 'de', label: 'Alemán (de)' },
];

type TemplateDraft = Record<TemplateKey, TemplateRef>;

function templatesDraft(config: ChannelConfig): TemplateDraft {
  const t = config.templates ?? {};
  const one = (k: TemplateKey): TemplateRef => ({ name: t[k]?.name ?? '', language: t[k]?.language ?? 'es' });
  return { firstContact: one('firstContact'), followUp: one('followUp'), reminder: one('reminder'), noShow: one('noShow') };
}

const TEMPLATE_NAME_RX = /^[a-z0-9_]+$/;

/** Forma comparable del borrador: sin espacios sobrantes y sin idioma en las plantillas vacías (no se guardan). */
function normalizeDraft(d: TemplateDraft): TemplateDraft {
  const one = (r: TemplateRef): TemplateRef => (r.name.trim() ? { name: r.name.trim(), language: r.language } : { name: '', language: 'es' });
  return { firstContact: one(d.firstContact), followUp: one(d.followUp), reminder: one(d.reminder), noShow: one(d.noShow) };
}
const draftKey = (d: TemplateDraft) => JSON.stringify(normalizeDraft(d));

function WhatsAppSettings({ row, canManage }: { row: ChannelRow; canManage: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const baseId = useId();
  const initial = templatesDraft(row.config);
  const [draft, setDraft] = useState<TemplateDraft>(initial);
  const [baseKey, setBaseKey] = useState(() => draftKey(initial));
  const serverKey = draftKey(initial);
  // Si cambia lo guardado en el servidor y no hay cambios pendientes, actualizamos el borrador.
  if (serverKey !== baseKey) {
    const pending = draftKey(draft) !== baseKey;
    setBaseKey(serverKey);
    if (!pending) setDraft(initial);
  }
  const dirty = draftKey(draft) !== serverKey;
  const errors: Partial<Record<TemplateKey, string>> = {};
  for (const s of TEMPLATE_SLOTS) {
    const name = draft[s.key].name.trim();
    if (name && !TEMPLATE_NAME_RX.test(name)) errors[s.key] = 'Solo minúsculas, números y guiones bajos (_), sin espacios ni tildes. Cópialo tal cual de WhatsApp Manager.';
    else if (name.length > 512) errors[s.key] = 'Es demasiado largo.';
  }
  const hasErrors = Object.keys(errors).length > 0;

  const save = useMutation({
    mutationFn: () => {
      const templates: NonNullable<ChannelConfig['templates']> = {};
      for (const s of TEMPLATE_SLOTS) {
        const name = draft[s.key].name.trim();
        if (name) templates[s.key] = { name, language: draft[s.key].language };
      }
      return api.patch<{ connection: ChannelRow }>(`/integrations/channels/${row.id}`, { config: cleanConfig({ ...row.config, templates }) });
    },
    onSuccess: () => {
      toast('Plantillas de WhatsApp guardadas');
      setDraft((d) => normalizeDraft(d));
      void qc.invalidateQueries({ queryKey: INTEGRATIONS_KEY });
    },
    onError: (e) => toast(errorText(e), 'error'),
  });

  const set = (key: TemplateKey, patch: Partial<TemplateRef>) => setDraft((d) => ({ ...d, [key]: { ...d[key], ...patch } }));
  const configured = TEMPLATE_SLOTS.filter((s) => row.config.templates?.[s.key]?.name).length;

  return (
    <div className="intg-sub">
      <div className="row-between wrap">
        <h3 className="row">
          <ListChecks aria-hidden className="intg-h-icon" />
          Plantillas para escribir fuera de las 24 horas
        </h3>
        <span className={`badge ${configured === TEMPLATE_SLOTS.length ? 'badge-success' : configured ? 'badge-warning' : ''}`}>
          {configured} de {TEMPLATE_SLOTS.length} configuradas
        </span>
      </div>
      <Callout tone="info" icon={Info}>
        <strong>La regla de las 24 horas de WhatsApp.</strong> WhatsApp solo deja enviar mensajes libres durante las 24 horas siguientes al último mensaje
        del lead. Fuera de ese plazo, o para escribir tú primero a alguien que aún no te ha escrito, solo se pueden enviar <strong>plantillas</strong>:
        mensajes que creas en WhatsApp Manager y que Meta revisa y aprueba antes. Si falta una plantilla, KAI no podrá enviar ese mensaje y te avisará.
      </Callout>
      <div className="intg-vars small">
        <strong>Variables:</strong> en el texto de la plantilla escribe <code className="code-inline">{'{{1}}'}</code> donde quieras el nombre del lead (KAI lo
        rellena solo). En la plantilla de recordatorio añade también <code className="code-inline">{'{{2}}'}</code> para la fecha y hora de la llamada. Usa
        exactamente esas variables: si la plantilla tiene otras, WhatsApp rechazará el envío.
      </div>
      <div className="col gap-12">
        {TEMPLATE_SLOTS.map((s) => {
          const nameId = `${baseId}-${s.key}-name`;
          const langId = `${baseId}-${s.key}-lang`;
          const lang = draft[s.key].language;
          const langOptions = LANGUAGES.some((l) => l.value === lang) ? LANGUAGES : [...LANGUAGES, { value: lang, label: lang }];
          return (
            <fieldset key={s.key} className="intg-template">
              <legend className="row wrap">
                <strong>{s.label}</strong>
                {row.config.templates?.[s.key]?.name ? <span className="badge badge-success">Configurada</span> : <span className="badge">Sin configurar</span>}
              </legend>
              <p className="small muted">{s.when}</p>
              <p className="xs subtle">
                {s.vars} · Ejemplo de texto: <em>«{s.example}»</em>
              </p>
              <div className="intg-template-fields">
                <Field label="Nombre de la plantilla" htmlFor={nameId} error={errors[s.key]}>
                  <Input
                    id={nameId}
                    className="intg-mono"
                    placeholder={s.key === 'firstContact' ? 'Ej.: primer_contacto' : s.key === 'followUp' ? 'Ej.: seguimiento' : s.key === 'reminder' ? 'Ej.: recordatorio_llamada' : 'Ej.: no_presentado'}
                    value={draft[s.key].name}
                    disabled={!canManage}
                    onChange={(e) => set(s.key, { name: e.target.value })}
                  />
                </Field>
                <Field label="Idioma de la plantilla" htmlFor={langId}>
                  <Select id={langId} value={lang} disabled={!canManage} options={langOptions} onChange={(e) => set(s.key, { language: e.target.value })} />
                </Field>
              </div>
            </fieldset>
          );
        })}
      </div>
      <p className="xs subtle">
        El idioma debe ser exactamente el que elegiste al crear la plantilla. Deja el nombre vacío si todavía no tienes esa plantilla aprobada.
      </p>
      <div className="row wrap">
        <Button variant="primary" icon={Save} disabled={!canManage || !dirty || hasErrors} loading={save.isPending} onClick={() => save.mutate()}>
          Guardar plantillas
        </Button>
        {dirty && (
          <Button variant="ghost" onClick={() => setDraft(initial)}>
            Descartar cambios
          </Button>
        )}
      </div>
      <Guide title="Cómo crear una plantilla en WhatsApp Manager" icon={BookOpen}>
        <Steps>
          <li>
            Entra en <ExtLink href="https://business.facebook.com/wa/manage/message-templates/">WhatsApp Manager → Plantillas de mensajes</ExtLink> con tu
            cuenta de Meta Business.
          </li>
          <li>
            Pulsa <UiLabel>Crear plantilla</UiLabel>. Como categoría, elige <UiLabel>Utilidad</UiLabel> para la de recordatorio y <UiLabel>Marketing</UiLabel>{' '}
            para las de primer contacto, seguimiento y no-show.
          </li>
          <li>
            Ponle un nombre en minúsculas y con guiones bajos (por ejemplo <code className="code-inline">primer_contacto</code>), elige el idioma y escribe
            el texto usando <code className="code-inline">{'{{1}}'}</code> para el nombre (y <code className="code-inline">{'{{2}}'}</code> para la fecha en
            la de recordatorio). Meta te pedirá un ejemplo de cada variable.
          </li>
          <li>Envíala a revisión. Cuando aparezca como «Activa» o «Aprobada», copia aquí su nombre y su idioma y pulsa «Guardar plantillas».</li>
        </Steps>
      </Guide>
    </div>
  );
}

// ───────────── Ajustes de Instagram ─────────────

function InstagramSettings({ row, canManage }: { row: ChannelRow; canManage: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const current = row.config.apiHost ?? 'graph.instagram.com';
  const [host, setHost] = useState(current);
  const save = useMutation({
    mutationFn: () => api.patch(`/integrations/channels/${row.id}`, { config: cleanConfig({ ...row.config, apiHost: host }) }),
    onSuccess: () => {
      toast('Ajustes de Instagram guardados');
      void qc.invalidateQueries({ queryKey: INTEGRATIONS_KEY });
    },
    onError: (e) => toast(errorText(e), 'error'),
  });
  return (
    <div className="intg-sub">
      <h3>Tipo de conexión</h3>
      <p className="small muted">Debe coincidir con la forma en la que creaste el token. Si los mensajes no se envían, revisa esta opción.</p>
      {canManage ? <ApiHostPicker value={host} onChange={setHost} /> : <p className="intg-mono small">{current}</p>}
      {host !== current && (
        <div className="row wrap">
          <Button variant="primary" icon={Save} loading={save.isPending} onClick={() => save.mutate()}>
            Guardar
          </Button>
          <Button variant="ghost" onClick={() => setHost(current)}>
            Descartar
          </Button>
        </div>
      )}
      <Callout tone="info">
        <strong>Plazo para responder en Instagram.</strong> Instagram solo deja contestar durante las 24 horas siguientes al último mensaje del lead y no admite
        plantillas, así que KAI no puede escribir pasado ese plazo. Una persona de tu equipo sí puede responder hasta 7 días después si Meta ha aprobado a tu
        app el permiso «Human Agent» (agente humano).
      </Callout>
      <p className="xs subtle">
        Si contestas tú desde la app de Instagram, KAI lo detecta y se pausa en esa conversación para no pisarte.
      </p>
    </div>
  );
}

// ───────────── Ajustes de Lead Ads ─────────────

function LeadAdsSettings({ row, whatsapp, canManage }: { row: ChannelRow; whatsapp: ChannelRow | undefined; canManage: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const currentForms = row.config.formIds ?? [];
  const currentChannel = row.config.firstContactChannel ?? 'whatsapp';
  const [forms, setForms] = useState<string[]>(currentForms);
  const [channel, setChannel] = useState<'whatsapp' | 'none'>(currentChannel);
  const badForms = forms.filter((f) => !/^\d{1,64}$/.test(f));
  const dirty = JSON.stringify(forms) !== JSON.stringify(currentForms) || channel !== currentChannel;
  const save = useMutation({
    mutationFn: () => api.patch(`/integrations/channels/${row.id}`, { config: cleanConfig({ ...row.config, formIds: forms, firstContactChannel: channel }) }),
    onSuccess: () => {
      toast('Ajustes de los anuncios guardados');
      void qc.invalidateQueries({ queryKey: INTEGRATIONS_KEY });
    },
    onError: (e) => toast(errorText(e), 'error'),
  });
  const hasFirstTemplate = Boolean(whatsapp?.config.templates?.firstContact?.name);
  const options: { value: 'whatsapp' | 'none'; title: string; text: string }[] = [
    { value: 'whatsapp', title: 'Escribirle por WhatsApp (recomendado)', text: 'KAI le envía un primer mensaje por WhatsApp en cuanto deja sus datos.' },
    { value: 'none', title: 'Solo guardarlo en KAI', text: 'El lead entra en tu CRM, pero nadie le escribe automáticamente.' },
  ];

  return (
    <div className="intg-sub">
      <h3>¿Qué hace KAI cuando entra un lead de un anuncio?</h3>
      <div className="option-grid" role="group" aria-label="Primer contacto con los leads de anuncios">
        {options.map((o) => (
          <button key={o.value} type="button" className="option" aria-pressed={channel === o.value} disabled={!canManage} onClick={() => setChannel(o.value)}>
            <strong>{o.title}</strong>
            <span className="small muted">{o.text}</span>
          </button>
        ))}
      </div>
      {channel === 'whatsapp' && (
        <>
          <p className="small muted">
            Como el lead todavía no te ha escrito, WhatsApp solo permite que el primer mensaje sea una <strong>plantilla aprobada</strong>: KAI usará tu
            plantilla de «Primer contacto». Además, el formulario del anuncio tiene que pedir el teléfono.
          </p>
          {!whatsapp ? (
            <Callout tone="warning">No tienes WhatsApp conectado. Hasta que lo conectes, los leads de tus anuncios se guardarán en KAI sin escribirles.</Callout>
          ) : !hasFirstTemplate ? (
            <Callout tone="warning">
              Falta la plantilla de «Primer contacto» en la tarjeta de WhatsApp. Sin ella, KAI no podrá escribir a estos leads y te avisará.
            </Callout>
          ) : null}
        </>
      )}
      <Field
        label="Formularios de los que recibir leads (opcional)"
        hint="Déjalo vacío para recibir los leads de todos los formularios de la página. Si solo quieres algunos, escribe su ID y pulsa Enter. Lo encontrarás en la biblioteca de formularios instantáneos de tu página (Meta Business Suite)."
        error={badForms.length ? `Estos valores no parecen un ID de formulario (solo números): ${badForms.join(', ')}` : null}
      >
        {canManage ? (
          <TagInput value={forms} onChange={(v) => setForms(v.map((x) => x.replace(/\s+/g, '')).filter(Boolean).slice(0, 50))} placeholder="ID del formulario y Enter" />
        ) : (
          <p className="small">{currentForms.length ? currentForms.join(', ') : 'Todos los formularios'}</p>
        )}
      </Field>
      {dirty && (
        <div className="row wrap">
          <Button variant="primary" icon={Save} disabled={badForms.length > 0} loading={save.isPending} onClick={() => save.mutate()}>
            Guardar
          </Button>
          <Button
            variant="ghost"
            onClick={() => {
              setForms(currentForms);
              setChannel(currentChannel);
            }}
          >
            Descartar
          </Button>
        </div>
      )}
    </div>
  );
}

// ───────────── Guías ─────────────

/**
 * KAI usa UNA sola app de Meta (la que configura quien administra KAI, con META_APP_ID y META_APP_SECRET): Meta firma
 * cada aviso con el secreto de la app del token, así que con un token de otra app no llegaría ningún mensaje (el
 * servidor lo rechaza al conectar). El entrenador no crea ninguna app ni configura webhooks: KAI suscribe sola cada
 * cuenta al conectarla.
 */
function KaiAppNote({ appId }: { appId: string | null }) {
  return (
    <Callout tone="info" icon={Info}>
      <strong>No crees ninguna app de Meta ni configures ningún webhook.</strong> KAI recibe tus mensajes a través de su propia app de Meta
      {appId ? (
        <>
          {' '}
          (identificador <code className="code-inline">{appId}</code>)
        </>
      ) : null}
      , que configura una sola vez quien administra KAI. Genera siempre los tokens eligiendo esa app: si usas otra, KAI no aceptará el token, porque no te
      llegaría ningún mensaje.
    </Callout>
  );
}

/** Paso común: acceso a la app de Meta de KAI. */
function KaiAppAccessStep({ appId, business }: { appId: string | null; business?: boolean }) {
  return (
    <>
      <h4 className="intg-guide-h">1. Consigue acceso a la app de Meta de KAI</h4>
      <Steps>
        <li>
          Pide a quien administra KAI que te añada como <UiLabel>Desarrollador</UiLabel> de la app de Meta de KAI{appId ? <> ({appId})</> : null}. Te
          llegará una invitación: acéptala en <ExtLink href="https://developers.facebook.com/requests">Meta for Developers → Solicitudes</ExtLink>.
        </li>
        {business && (
          <li>
            Pídele también que comparta la app con tu portfolio empresarial (tu cuenta de Business Manager). Para eso necesita su identificador: lo ves en{' '}
            <ExtLink href="https://business.facebook.com/settings/info">Configuración del negocio → Información del negocio</ExtLink>. Cuando lo haga, la app
            de KAI aparecerá en <UiLabel>Configuración del negocio</UiLabel> → <UiLabel>Cuentas</UiLabel> → <UiLabel>Apps</UiLabel>.
          </li>
        )}
        <li>Si administras tú KAI, la app es la que creaste al configurarlo: sáltate este paso.</li>
      </Steps>
    </>
  );
}

function WhatsAppGuide({ appId }: { appId: string | null }) {
  return (
    <Guide icon={BookOpen}>
      <p className="small muted">Necesitas un ordenador y unos 20 minutos. Solo hay que hacerlo una vez.</p>
      <KaiAppNote appId={appId} />
      <KaiAppAccessStep appId={appId} business />
      <h4 className="intg-guide-h">2. Añade tu número y copia su identificador</h4>
      <Steps>
        <li>
          Entra en <ExtLink href="https://developers.facebook.com/apps">Meta for Developers</ExtLink>, abre la app de KAI y, en el menú de la izquierda, ve
          a <UiLabel>WhatsApp</UiLabel> → <UiLabel>Configuración de la API</UiLabel> (API Setup).
        </li>
        <li>
          Añade tu número de empresa con <UiLabel>Añadir número de teléfono</UiLabel>, eligiendo tu portfolio empresarial, y verifícalo con el código que te
          llegará por SMS o llamada. Si ese número ya está en la aplicación de WhatsApp, Meta te indicará los pasos para pasarlo a la API.
        </li>
        <li>
          Elige tu número en el desplegable: justo debajo verás <UiLabel>Identificador del número de teléfono</UiLabel> (Phone number ID). Ese es el número
          que tienes que pegar en KAI. <strong>No es tu número de teléfono.</strong>
        </li>
      </Steps>
      <h4 className="intg-guide-h">3. Crea un token permanente</h4>
      <p className="small muted">
        El token que aparece en «Configuración de la API» es temporal y caduca en 24 horas. Para que KAI funcione siempre, crea uno permanente con un
        «usuario del sistema» (un usuario especial para aplicaciones, no una persona):
      </p>
      <Steps>
        <li>
          Entra en <ExtLink href="https://business.facebook.com/settings/system-users">Configuración del negocio → Usuarios del sistema</ExtLink> y pulsa{' '}
          <UiLabel>Añadir</UiLabel>. Ponle un nombre (por ejemplo, KAI) y el rol <UiLabel>Administrador</UiLabel>.
        </li>
        <li>
          Con ese usuario seleccionado, pulsa <UiLabel>Asignar activos</UiLabel>: en <UiLabel>Apps</UiLabel> elige la app de KAI y en{' '}
          <UiLabel>Cuentas de WhatsApp</UiLabel> tu cuenta, ambas con control total.
        </li>
        <li>
          Pulsa <UiLabel>Generar nuevo token</UiLabel>, elige la app de KAI, en caducidad marca <UiLabel>Nunca</UiLabel> y activa estos permisos:{' '}
          <code className="code-inline">whatsapp_business_messaging</code> y <code className="code-inline">whatsapp_business_management</code>.
        </li>
        <li>Copia el token (empieza por «EAA…») y pégalo en KAI. Meta solo lo enseña una vez: si lo pierdes, genera otro.</li>
      </Steps>
      <h4 className="intg-guide-h">4. Conecta</h4>
      <p className="small muted">
        Pulsa «Conectar WhatsApp Business» y pega el identificador y el token. KAI comprueba con Meta que son correctos y que el token es de su app, y activa
        él mismo los avisos de tus mensajes. No tienes que configurar ningún webhook.
      </p>
    </Guide>
  );
}

function InstagramGuide({ appId }: { appId: string | null }) {
  return (
    <Guide icon={BookOpen}>
      <KaiAppNote appId={appId} />
      <KaiAppAccessStep appId={appId} />
      <h4 className="intg-guide-h">2. Prepara tu cuenta de Instagram</h4>
      <Steps>
        <li>
          Tu cuenta debe ser profesional. En la app de Instagram: <UiLabel>Configuración</UiLabel> → <UiLabel>Tipo de cuenta y herramientas</UiLabel> →{' '}
          <UiLabel>Cambiar a cuenta profesional</UiLabel> (de empresa o de creador).
        </li>
        <li>
          En la app de Instagram: <UiLabel>Configuración</UiLabel> → <UiLabel>Mensajes y respuestas a historias</UiLabel> →{' '}
          <UiLabel>Herramientas de mensajes</UiLabel> y activa <UiLabel>Permitir acceso a los mensajes</UiLabel>. Sin esto, ninguna herramienta puede leer tus
          mensajes directos.
        </li>
      </Steps>
      <h4 className="intg-guide-h">3. Conecta tu cuenta en la app de KAI</h4>
      <Steps>
        <li>
          Entra en <ExtLink href="https://developers.facebook.com/apps">Meta for Developers</ExtLink>, abre la app de KAI y ve a <UiLabel>Instagram</UiLabel>{' '}
          → <UiLabel>Configuración de la API con inicio de sesión de Instagram</UiLabel> (API setup with Instagram login).
        </li>
        <li>
          En <UiLabel>Generar tokens de acceso</UiLabel>, pulsa <UiLabel>Añadir cuenta</UiLabel>, inicia sesión con tu Instagram profesional y acepta los
          permisos <code className="code-inline">instagram_business_basic</code> e <code className="code-inline">instagram_business_manage_messages</code>.
        </li>
        <li>
          Junto a tu cuenta aparecerá un número largo: es el <strong>ID de la cuenta profesional</strong>. Cópialo en KAI.
        </li>
        <li>
          Pulsa <UiLabel>Generar token</UiLabel>, copia el token y pégalo en KAI. En «¿Cómo has creado el token?» elige{' '}
          <strong>Inicio de sesión con Instagram (recomendado)</strong>.
        </li>
      </Steps>
      <p className="small muted">
        Al conectar, KAI activa él mismo los avisos de tus mensajes: no tienes que configurar ningún webhook. ¿Usas el método antiguo, con tu Instagram
        vinculado a una página de Facebook y un token de Facebook? Entonces elige <strong>Inicio de sesión con Facebook</strong> (
        <code className="code-inline">graph.facebook.com</code>) al conectar y pide a quien administra KAI que active los avisos de mensajes de tu página.
      </p>
    </Guide>
  );
}

function LeadAdsGuide({ appId }: { appId: string | null }) {
  return (
    <Guide icon={BookOpen}>
      <p className="small muted">
        Necesitas ser administrador de la página de Facebook desde la que publicas los anuncios. Con estos pasos conseguirás a la vez el ID de la página y
        un token de página que no caduca.
      </p>
      <KaiAppNote appId={appId} />
      <KaiAppAccessStep appId={appId} />
      <h4 className="intg-guide-h">2. Genera un token con los permisos necesarios</h4>
      <Steps>
        <li>
          Abre el <ExtLink href="https://developers.facebook.com/tools/explorer/">Explorador de la API Graph</ExtLink> (una herramienta de Meta para
          desarrolladores; no hace falta saber programar).
        </li>
        <li>
          A la derecha, en <UiLabel>Meta App</UiLabel>, elige la app de KAI. En <UiLabel>Permissions</UiLabel> añade:{' '}
          <code className="code-inline">leads_retrieval</code>, <code className="code-inline">pages_manage_metadata</code>,{' '}
          <code className="code-inline">pages_show_list</code> y <code className="code-inline">pages_read_engagement</code>.
        </li>
        <li>
          Pulsa <UiLabel>Generate Access Token</UiLabel>; en la ventana de Facebook, marca tu página y acepta.
        </li>
      </Steps>
      <h4 className="intg-guide-h">3. Haz que no caduque</h4>
      <Steps>
        <li>
          Copia el token, pégalo en el <ExtLink href="https://developers.facebook.com/tools/debug/accesstoken/">Depurador de tokens de acceso</ExtLink> y pulsa{' '}
          <UiLabel>Depurar</UiLabel>. Abajo del todo, pulsa <UiLabel>Extender token de acceso</UiLabel> y copia el token nuevo.
        </li>
        <li>
          Vuelve al Explorador, pega ese token nuevo en <UiLabel>Access Token</UiLabel>, escribe <code className="code-inline">me/accounts</code> en la barra
          de consulta y pulsa <UiLabel>Submit</UiLabel>.
        </li>
        <li>
          En la respuesta busca tu página: su <code className="code-inline">id</code> es el <strong>ID de la página</strong> y su{' '}
          <code className="code-inline">access_token</code> es el <strong>token de página</strong>. Copia ambos en KAI.
        </li>
      </Steps>
      <h4 className="intg-guide-h">4. Conecta</h4>
      <Steps>
        <li>
          Pulsa «Conectar Meta Lead Ads» y pega el ID de la página y el token. KAI comprueba que el token es de su app y suscribe tu página para recibir los
          contactos de tus anuncios. No tienes que configurar ningún webhook.
        </li>
        <li>
          Si en tu Business Manager tienes restringido el acceso a los clientes potenciales (<UiLabel>Configuración del negocio</UiLabel> →{' '}
          <UiLabel>Integraciones</UiLabel> → <UiLabel>Acceso a clientes potenciales</UiLabel>), da acceso también a la app de KAI.
        </li>
      </Steps>
    </Guide>
  );
}

const GUIDES: Record<MetaChannel, (props: { appId: string | null }) => ReactNode> = {
  whatsapp: WhatsAppGuide,
  instagram: InstagramGuide,
  meta_lead_ads: LeadAdsGuide,
};

// ───────────── Tarjeta de canal ─────────────

function AccountBox({ row, def }: { row: ChannelRow; def: ChannelDef }) {
  return (
    <div className="intg-account">
      <dl className="kv">
        <dt>Cuenta</dt>
        <dd>
          <strong>{row.displayName || '—'}</strong>
        </dd>
        {row.config.phoneNumber && (
          <>
            <dt>Número</dt>
            <dd className="tnum">{row.config.phoneNumber}</dd>
          </>
        )}
        <dt>Identificador</dt>
        <dd className="intg-mono">{row.externalAccountId}</dd>
        <dt>{def.activityLabel}</dt>
        <dd>{row.lastEventAt ? timeAgo(row.lastEventAt) : <span className="subtle">Todavía no ha llegado nada</span>}</dd>
      </dl>
      {row.status === 'error' && (
        <div className="mt-12">
          <Callout tone="danger">
            <strong>Meta ha devuelto un error con esta conexión.</strong> {row.lastError ? <span className="intg-break">«{row.lastError}»</span> : null}
            <br />
            Normalmente se soluciona generando un token nuevo y pegándolo con «Editar datos».
          </Callout>
        </div>
      )}
    </div>
  );
}

function ChannelCard({
  def,
  rows,
  whatsapp,
  canManage,
  appId,
}: {
  def: ChannelDef;
  rows: ChannelRow[];
  whatsapp: ChannelRow | undefined;
  canManage: boolean;
  appId: string | null;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const [modal, setModal] = useState<{ existing: ChannelRow | null } | null>(null);
  const [toDisconnect, setToDisconnect] = useState<ChannelRow | null>(null);
  const disconnect = useMutation({
    mutationFn: (id: string) => api.del(`/integrations/channels/${id}`),
    onSuccess: () => {
      toast(`${def.title} desconectado`);
      setToDisconnect(null);
      void qc.invalidateQueries({ queryKey: INTEGRATIONS_KEY });
    },
    onError: (e) => toast(errorText(e), 'error'),
  });
  const GuideComp = GUIDES[def.key];

  return (
    <section className="card" aria-labelledby={`intg-${def.key}`}>
      <IntegrationHead logo={def.logo} title={<span id={`intg-${def.key}`}>{def.title}</span>} subtitle={def.subtitle} status={<ConnBadge state={connState(rows)} />} />
      <p className="intg-desc">{def.description}</p>

      {rows.length === 0 ? (
        <div className="row wrap mt-16">
          <Button variant="primary" icon={Plug} disabled={!canManage} onClick={() => setModal({ existing: null })}>
            Conectar {def.title}
          </Button>
        </div>
      ) : (
        rows.map((row) => (
          <div key={row.id} className="col gap-12 mt-16">
            <AccountBox row={row} def={def} />
            {canManage && (
              <div className="row wrap">
                <Button icon={Pencil} onClick={() => setModal({ existing: row })}>
                  Editar datos
                </Button>
                <Button variant="ghost" icon={Unplug} onClick={() => setToDisconnect(row)}>
                  Desconectar
                </Button>
              </div>
            )}
            {def.key === 'whatsapp' && <WhatsAppSettings row={row} canManage={canManage} />}
            {def.key === 'instagram' && <InstagramSettings key={row.config.apiHost ?? 'default'} row={row} canManage={canManage} />}
            {def.key === 'meta_lead_ads' && (
              <LeadAdsSettings key={JSON.stringify([row.config.formIds, row.config.firstContactChannel])} row={row} whatsapp={whatsapp} canManage={canManage} />
            )}
          </div>
        ))
      )}

      <div className="mt-16">
        <GuideComp appId={appId} />
      </div>

      {modal && <ConnectChannelModal def={def} existing={modal.existing} onClose={() => setModal(null)} />}
      <ConfirmDialog
        open={Boolean(toDisconnect)}
        title={`¿Desconectar ${def.title}?`}
        message={def.disconnectMessage}
        confirmLabel="Desconectar"
        danger
        loading={disconnect.isPending}
        onConfirm={() => toDisconnect && disconnect.mutate(toDisconnect.id)}
        onClose={() => setToDisconnect(null)}
      />
    </section>
  );
}

// ───────────── Webhook de Meta ─────────────

function MetaWebhookCard({ data }: { data: IntegrationsResponse }) {
  const { endpoints, server } = data;
  return (
    <Card title="Webhook de Meta" icon={Webhook}>
      <div className="col gap-12">
        <p className="small muted">
          Un <strong>webhook</strong> es la dirección a la que Meta avisa a KAI cada vez que llega un mensaje o un lead. Lo configura{' '}
          <strong>una sola vez quien administra KAI</strong>, en la app de Meta de KAI, y sirve para todos los negocios y los tres canales. Si no administras
          KAI, no tienes que hacer nada aquí: al conectar cada canal, KAI se suscribe solo.
        </p>
        {endpoints.metaAppId ? (
          <CopyField label="Identificador de la app de Meta de KAI" value={endpoints.metaAppId} what="Identificador de la app copiado" />
        ) : null}
        <CopyField label="URL de devolución de llamada (Callback URL)" value={endpoints.metaWebhookUrl} what="Dirección del webhook copiada" />
        <div className="field">
          <span className="label">Token de verificación (Verify token)</span>
          <p className="small">
            No lo inventas tú: es el valor de la variable <code className="code-inline">META_VERIFY_TOKEN</code> configurada en el servidor de KAI. Si no
            administras el servidor, pídeselo a quien lo haga.
          </p>
          <div className="row wrap mt-4">
            {endpoints.metaVerifyTokenConfigured ? (
              <span className="badge badge-success badge-dot">Configurado en el servidor</span>
            ) : (
              <span className="badge badge-danger badge-dot">Sin configurar en el servidor</span>
            )}
          </div>
        </div>
        {server.meta ? (
          <Callout tone="accent" icon={ShieldCheck}>
            El servidor está listo para recibir avisos de Meta.
          </Callout>
        ) : endpoints.metaVerifyTokenConfigured ? (
          <Callout tone="warning" icon={ServerCog}>
            Falta <code className="code-inline">META_APP_SECRET</code> (el «secreto de la app» de Meta) en el servidor. Sin él, KAI no puede comprobar que
            los avisos vienen de verdad de Meta y, en producción, los rechaza.
          </Callout>
        ) : (
          <Callout tone="warning" icon={ServerCog}>
            Falta <code className="code-inline">META_VERIFY_TOKEN</code> en el servidor (revisa también <code className="code-inline">META_APP_SECRET</code>).
            Hasta que se configure, Meta no podrá verificar la dirección y no llegarán mensajes ni leads.
          </Callout>
        )}
        <div>
          <h3 className="intg-small-h">Campos que debes suscribir</h3>
          <ul className="intg-list small">
            <li>
              <WhatsAppIcon size={14} /> <span>
                <strong>WhatsApp:</strong> en la app de KAI → WhatsApp → Configuración → Webhook, el campo <code className="code-inline">messages</code>.
              </span>
            </li>
            <li>
              <InstagramIcon size={14} /> <span>
                <strong>Instagram:</strong> en la app de KAI → Instagram → Configuración de la API con inicio de sesión de Instagram → Configurar webhooks, el
                campo{' '}
                <code className="code-inline">messages</code>.
              </span>
            </li>
            <li>
              <Megaphone size={14} aria-hidden /> <span>
                <strong>Lead Ads:</strong> en la app de KAI → Webhooks → objeto «Page» (página), el campo <code className="code-inline">leadgen</code>.
              </span>
            </li>
          </ul>
        </div>
        <Callout tone="info" icon={KeyRound}>
          La app de Meta de KAI es la misma cuyo «secreto de la app» está configurado en el servidor (<code className="code-inline">META_APP_SECRET</code>) y
          los tokens de todos los canales tienen que ser de ella: KAI rechaza los de otras apps al conectar, porque sus mensajes no le llegarían.
          Mientras la app esté en modo desarrollo, Meta solo envía los mensajes de personas con un rol en la app (administradores o testers). Para usarla con
          clientes reales hay que pasar la revisión de la app de Meta (App Review) con los permisos de cada guía, verificar el negocio en Business Manager y
          ponerla en modo «Activo» (Live).
        </Callout>
      </div>
    </Card>
  );
}

// ───────────── Sección ─────────────

export function ChannelsSection({ data, canManage }: { data: IntegrationsResponse; canManage: boolean }) {
  const byChannel = (c: MetaChannel) => data.channels.filter((r) => r.channel === c && r.status !== 'disconnected');
  const whatsapp = byChannel('whatsapp').find((r) => r.status === 'connected') ?? byChannel('whatsapp')[0];
  return (
    <div className="intg-section">
      <p className="intg-lead">
        WhatsApp, Instagram y los anuncios con formulario pertenecen a <strong>Meta</strong> (la empresa de Facebook). KAI se conecta a ellos con su propia
        «app» de Meta, que configura una sola vez quien administra KAI: tú no tienes que crear ninguna app ni configurar webhooks. Solo das acceso a tu cuenta
        y pegas aquí los datos. Cada tarjeta tiene una guía paso a paso.
      </p>
      <div className="grid-split">
        <div className="col gap-16">
          {(['whatsapp', 'instagram', 'meta_lead_ads'] as const).map((c) => (
            <ChannelCard key={c} def={DEFS[c]} rows={byChannel(c)} whatsapp={whatsapp} canManage={canManage} appId={data.endpoints.metaAppId ?? null} />
          ))}
        </div>
        <div className="intg-aside">
          <MetaWebhookCard data={data} />
        </div>
      </div>
    </div>
  );
}
