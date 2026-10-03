/* Formularios web y webhook de leads: formulario público con generador de código y entrada para Zapier/Make con clave secreta. */
import { useId, useMemo, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { BookOpen, CodeXml, Eye, EyeOff, Globe, KeyRound, RotateCw, Webhook } from 'lucide-react';
import { api, errorText } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { Button, Callout, ConfirmDialog, Field, Input, Switch, useToast } from '../../components/ui';
import { CopyButton, CopyField, ExtLink, Guide, IntegrationHead, Steps, UiLabel, type IntegrationsResponse } from './shared';

// ───────────── Generador del formulario HTML ─────────────

interface FormOptions {
  title: string;
  buttonText: string;
  thanksText: string;
  businessName: string;
  privacyUrl: string;
  sourceDetail: string;
  askGoal: boolean;
  whatsapp: boolean;
  color: string;
}

const escHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
/** Literal de JavaScript seguro dentro de una etiqueta <script>. */
const jsStr = (s: string) => JSON.stringify(s).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
const isHttpUrl = (s: string) => /^https?:\/\/[^\s"'<>]+$/i.test(s.trim());
const safeColor = (s: string) => (/^#[0-9a-f]{6}$/i.test(s) ? s : '#c6ff3d');

/** Color de texto legible sobre el color del botón. */
function inkFor(hex: string) {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.4 ? '#111111' : '#ffffff';
}

export function buildFormHtml(endpoint: string, o: FormOptions, uid: string): string {
  const color = safeColor(o.color);
  const ink = inkFor(color);
  const biz = o.businessName.trim() || 'El responsable de esta web';
  const button = o.buttonText.trim() || 'Enviar';
  const thanks = o.thanksText.trim() || '¡Gracias! Te contactaremos muy pronto.';
  const privacy = isHttpUrl(o.privacyUrl) ? o.privacyUrl.trim() : '';
  const policy = privacy ? `<a href="${escHtml(privacy)}" target="_blank" rel="noopener">política de privacidad</a>` : 'política de privacidad';
  const id = `kai-form-${uid}`;
  const lines = [
    `<!-- Formulario de contacto conectado con KAI. Pégalo donde quieras que aparezca. -->`,
    `<div class="kai-lead-form" id="${id}">`,
    `<style>`,
    `#${id}{max-width:480px;color:inherit;font-family:inherit}`,
    `#${id} form{display:grid;gap:12px}`,
    `#${id} h3{margin:0 0 4px;font-size:1.3em}`,
    `#${id} label{display:grid;gap:4px;font-size:.95em}`,
    `#${id} input,#${id} textarea{font:inherit;padding:10px 12px;border:1px solid #c9ced6;border-radius:8px;background:#fff;color:#111;width:100%;box-sizing:border-box}`,
    `#${id} textarea{min-height:84px;resize:vertical}`,
    `#${id} .kai-consent{display:flex;gap:8px;align-items:flex-start;font-size:.85em}`,
    `#${id} .kai-consent input{width:auto;margin-top:3px;flex-shrink:0}`,
    `#${id} .kai-info{font-size:.75em;opacity:.75;margin:0}`,
    `#${id} .kai-hp{position:absolute;left:-9999px;width:1px;height:1px;overflow:hidden}`,
    `#${id} button{font:inherit;font-weight:600;padding:12px 16px;border:0;border-radius:8px;background:${color};color:${ink};cursor:pointer}`,
    `#${id} button[disabled]{opacity:.6;cursor:wait}`,
    `#${id} .kai-msg{font-size:.9em;min-height:1.2em;margin:0}`,
    `#${id} .kai-error{color:#b42318}`,
    `#${id} .kai-thanks{padding:16px;border-radius:8px;background:#ecfdf3;color:#05603a;margin:0}`,
    `</style>`,
    `<form novalidate>`,
    ...(o.title.trim() ? [`  <h3>${escHtml(o.title.trim())}</h3>`] : []),
    `  <label>Nombre<input name="name" type="text" autocomplete="name" maxlength="120" required></label>`,
    `  <label>${o.whatsapp ? 'Teléfono (WhatsApp)' : 'Teléfono'}<input name="phone" type="tel" autocomplete="tel" maxlength="40" placeholder="+34 600 000 000"></label>`,
    `  <label>Email<input name="email" type="email" autocomplete="email" maxlength="200"></label>`,
    ...(o.askGoal ? [`  <label>¿Qué te gustaría conseguir?<textarea name="goal" maxlength="500"></textarea></label>`] : []),
    `  <div class="kai-hp" aria-hidden="true"><label>No rellenes este campo<input name="website" type="text" tabindex="-1" autocomplete="off"></label></div>`,
    `  <label class="kai-consent"><input name="privacy" type="checkbox" required><span>He leído y acepto la ${policy}. ${escHtml(biz)} tratará mis datos para responder a mi solicitud y contactarme por teléfono, WhatsApp o email.</span></label>`,
    `  <p class="kai-info">Responsable: ${escHtml(biz)}. Finalidad: atender tu solicitud y enviarte información sobre nuestros servicios. Puedes ejercer tus derechos de acceso, rectificación, supresión y demás como se explica en la política de privacidad.</p>`,
    `  <button type="submit">${escHtml(button)}</button>`,
    `  <p class="kai-msg" role="status" aria-live="polite"></p>`,
    `</form>`,
    `</div>`,
    `<script>`,
    `(function () {`,
    `  var root = document.getElementById(${jsStr(id)});`,
    `  if (!root) return;`,
    `  var form = root.querySelector('form');`,
    `  var msg = root.querySelector('.kai-msg');`,
    `  var btn = root.querySelector('button[type="submit"]');`,
    `  function val(n) { var el = form.querySelector('[name="' + n + '"]'); return el ? el.value.trim() : ''; }`,
    `  function show(t, err) { msg.textContent = t; msg.className = 'kai-msg' + (err ? ' kai-error' : ''); }`,
    `  form.addEventListener('submit', function (e) {`,
    `    e.preventDefault();`,
    `    var email = val('email');`,
    `    if (!val('name')) return show('Escribe tu nombre.', true);`,
    `    if (!val('phone') && !email) return show('Indica tu teléfono o tu email para que podamos contactarte.', true);`,
    `    if (email && !/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(email)) return show('Revisa tu email: parece que no está bien escrito.', true);`,
    `    if (!form.querySelector('[name="privacy"]').checked) return show('Para enviar el formulario tienes que aceptar la política de privacidad.', true);`,
    `    var data = {`,
    `      name: val('name'),`,
    `      website: val('website'),`,
    `      contact_via_whatsapp: ${o.whatsapp ? 'true' : 'false'},`,
    `      extra: { consentimiento_privacidad: 'Aceptado el ' + new Date().toLocaleString('es-ES'), pagina: location.href.slice(0, 300) }`,
    `    };`,
    `    if (val('phone')) data.phone = val('phone');`,
    `    if (email) data.email = email;`,
    `    if (val('goal')) data.goal = val('goal');`,
    ...(o.sourceDetail.trim() ? [`    data.source_detail = ${jsStr(o.sourceDetail.trim().slice(0, 120))};`] : []),
    `    var label = btn.textContent;`,
    `    btn.disabled = true; btn.textContent = 'Enviando…'; show('');`,
    `    fetch(${jsStr(endpoint)}, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) })`,
    `      .then(function (r) {`,
    `        return r.json().catch(function () { return {}; }).then(function (j) {`,
    `          if (!r.ok) { var fail = new Error((j && (j.message || (String(j.error || '').indexOf(' ') > 0 ? j.error : ''))) || ''); fail.kai = true; throw fail; }`,
    `        });`,
    `      })`,
    `      .then(function () {`,
    `        var p = document.createElement('p');`,
    `        p.className = 'kai-thanks'; p.setAttribute('role', 'status');`,
    `        p.textContent = ${jsStr(thanks)};`,
    `        form.parentNode.replaceChild(p, form);`,
    `      })`,
    `      .catch(function (err) {`,
    `        btn.disabled = false; btn.textContent = label;`,
    `        show((err && err.kai && err.message) || 'No se ha podido enviar. Revisa tu conexión e inténtalo de nuevo.', true);`,
    `      });`,
    `  });`,
    `})();`,
    `</script>`,
  ];
  return lines.join('\n');
}

function FormGenerator({ endpoint, publicKey }: { endpoint: string; publicKey: string }) {
  const { activeBusiness } = useAuth();
  const ids = { title: useId(), button: useId(), thanks: useId(), biz: useId(), privacy: useId(), source: useId(), color: useId() };
  const [o, setO] = useState<FormOptions>({
    title: '¿Hablamos?',
    buttonText: 'Quiero información',
    thanksText: '¡Gracias! Te contactaremos muy pronto.',
    businessName: activeBusiness?.name ?? '',
    privacyUrl: '',
    sourceDetail: '',
    askGoal: true,
    whatsapp: true,
    color: '#c6ff3d',
  });
  const set = <K extends keyof FormOptions>(k: K, v: FormOptions[K]) => setO((prev) => ({ ...prev, [k]: v }));
  const uid = (publicKey.replace(/[^a-z0-9]/gi, '').slice(-6) || 'kai').toLowerCase();
  const html = useMemo(() => buildFormHtml(endpoint, o, uid), [endpoint, o, uid]);
  const preview = useMemo(
    () =>
      `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;padding:20px;background:#fff;color:#111;font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif}</style></head><body>${html}</body></html>`,
    [html],
  );
  const privacyInvalid = o.privacyUrl.trim() !== '' && !isHttpUrl(o.privacyUrl);

  return (
    <div className="col gap-16">
      <div className="grid-2">
        <Field label="Título del formulario (opcional)" htmlFor={ids.title}>
          <Input id={ids.title} maxLength={80} value={o.title} onChange={(e) => set('title', e.target.value)} />
        </Field>
        <Field label="Texto del botón" htmlFor={ids.button}>
          <Input id={ids.button} maxLength={40} value={o.buttonText} onChange={(e) => set('buttonText', e.target.value)} />
        </Field>
        <Field label="Mensaje de agradecimiento" htmlFor={ids.thanks} hint="Lo que ve la persona después de enviar el formulario.">
          <Input id={ids.thanks} maxLength={200} value={o.thanksText} onChange={(e) => set('thanksText', e.target.value)} />
        </Field>
        <Field label="Color del botón" htmlFor={ids.color}>
          <div className="row">
            <input id={ids.color} type="color" className="intg-color" value={safeColor(o.color)} onChange={(e) => set('color', e.target.value)} />
            <span className="small muted intg-mono">{safeColor(o.color)}</span>
          </div>
        </Field>
        <Field label="Responsable de los datos" htmlFor={ids.biz} hint="Tu nombre o el de tu negocio, tal como aparece en tu política de privacidad.">
          <Input id={ids.biz} maxLength={120} value={o.businessName} onChange={(e) => set('businessName', e.target.value)} />
        </Field>
        <Field
          label="Enlace a tu política de privacidad"
          htmlFor={ids.privacy}
          error={privacyInvalid ? 'Escribe la dirección completa, empezando por https://' : null}
          hint="La dirección de la página de tu web donde explicas cómo tratas los datos."
        >
          <Input id={ids.privacy} type="url" placeholder="https://tuweb.com/privacidad" value={o.privacyUrl} onChange={(e) => set('privacyUrl', e.target.value)} />
        </Field>
        <Field label="Origen (opcional)" htmlFor={ids.source} hint="Para saber desde qué página llegó el lead. Ej.: Landing de verano.">
          <Input id={ids.source} maxLength={120} value={o.sourceDetail} onChange={(e) => set('sourceDetail', e.target.value)} />
        </Field>
        <div className="col gap-12 intg-switches">
          <Switch checked={o.askGoal} onChange={(v) => set('askGoal', v)} label="Preguntar su objetivo" />
          <Switch checked={o.whatsapp} onChange={(v) => set('whatsapp', v)} label="Que KAI le escriba por WhatsApp" />
          <span className="xs subtle">
            Si tienes WhatsApp conectado y la persona deja su teléfono, KAI le envía el primer mensaje con tu plantilla de «Primer contacto».
          </span>
        </div>
      </div>

      {!o.privacyUrl.trim() && (
        <Callout tone="warning">
          Añade el enlace a tu política de privacidad: según el RGPD (la ley europea de protección de datos), la persona debe poder leerla antes de enviar sus
          datos. El formulario ya incluye la casilla de consentimiento obligatoria.
        </Callout>
      )}

      <div className="grid-2 intg-grid-top">
        <div className="col">
          <div className="row-between wrap">
            <span className="label">Código para pegar en tu web</span>
            <CopyButton text={html} what="Código del formulario copiado" label="Copiar código" variant="primary" />
          </div>
          <pre className="code intg-code" tabIndex={0} aria-label="Código HTML del formulario">
            {html}
          </pre>
        </div>
        <div className="col">
          <span className="label">Vista previa</span>
          <iframe className="intg-preview" title="Vista previa del formulario (no envía datos)" sandbox="" srcDoc={preview} />
          <span className="xs subtle">La vista previa es solo para ver el aspecto: desde aquí no se envía nada.</span>
        </div>
      </div>

      <Guide icon={BookOpen} title="Dónde pegar el código en tu web">
        <Steps>
          <li>Copia el código con el botón «Copiar código».</li>
          <li>
            <strong>WordPress:</strong> edita la página, añade un bloque <UiLabel>HTML personalizado</UiLabel> y pega el código.
          </li>
          <li>
            <strong>Wix:</strong> <UiLabel>Añadir</UiLabel> → <UiLabel>Insertar código</UiLabel> → <UiLabel>Insertar HTML</UiLabel> y pega el código.
          </li>
          <li>
            <strong>Webflow, Framer, Squarespace, Shopify y similares:</strong> usa el bloque de código o «Embed» y pega el código.
          </li>
          <li>
            Publica los cambios y haz una prueba rellenando el formulario: el lead aparecerá en <strong>Leads</strong> en unos segundos. Si te lleva la web
            otra persona, pásale este código.
          </li>
        </Steps>
        <p className="xs subtle mt-12">
          Incluye una casilla oculta (llamada «website») que las personas no ven: si un robot de spam la rellena, KAI ignora el envío. Revisa el texto legal
          con tu asesor si tienes dudas.
        </p>
      </Guide>
    </div>
  );
}

// ───────────── Webhook de leads (Zapier / Make) ─────────────

const FIELDS: { name: string; text: string }[] = [
  { name: 'name', text: 'Nombre de la persona.' },
  { name: 'email', text: 'Email (tiene que ser válido).' },
  { name: 'phone', text: 'Teléfono, mejor con prefijo de país (+34…). Es el que KAI usa para WhatsApp.' },
  { name: 'instagram', text: 'Usuario de Instagram, con o sin @.' },
  { name: 'goal', text: 'Objetivo que ha indicado (hasta 500 caracteres).' },
  { name: 'message', text: 'Mensaje o comentario libre (hasta 2000 caracteres).' },
  { name: 'source_detail', text: 'De dónde viene, para reconocerlo luego. Ej.: «Typeform» (hasta 120 caracteres).' },
  { name: 'contact_via_whatsapp', text: 'true o false, sin comillas. Si no lo envías se considera true: si tienes WhatsApp conectado, KAI le escribe.' },
  { name: 'extra', text: 'Otros datos, como un objeto con pares «nombre»: «texto». Ej.: {"edad": "34"}.' },
];

const EXAMPLE_BODY = `{
  "name": "Nombre Apellido",
  "phone": "+34 600 000 000",
  "email": "nombre@ejemplo.com",
  "goal": "Ganar fuerza y mejorar mi forma física",
  "source_detail": "Formulario de Typeform",
  "contact_via_whatsapp": true
}`;

function SecretBox({ canManage }: { canManage: boolean }) {
  const toast = useToast();
  const inputId = useId();
  const [secret, setSecret] = useState<string | null>(null);
  const [visible, setVisible] = useState(false);
  const [confirmRotate, setConfirmRotate] = useState(false);
  const reveal = useMutation({
    mutationFn: () => api.get<{ secret: string }>('/integrations/webhook-secret'),
    onSuccess: (r) => {
      setSecret(r.secret);
      setVisible(true);
    },
    onError: (e) => toast(errorText(e), 'error'),
  });
  const rotate = useMutation({
    mutationFn: () => api.post<{ secret: string }>('/integrations/webhook-secret/rotate'),
    onSuccess: (r) => {
      setSecret(r.secret);
      setVisible(true);
      setConfirmRotate(false);
      toast('Clave cambiada. Recuerda ponerla en Zapier o Make.');
    },
    onError: (e) => toast(errorText(e), 'error'),
  });
  const shown = visible && secret;

  return (
    <div className="field">
      <label htmlFor={inputId}>Clave secreta (cabecera X-KAI-Key)</label>
      <div className="intg-copy">
        <Input id={inputId} readOnly className="intg-mono" value={shown ? secret : 'kai_sk_••••••••••••••••••••'} onFocus={(e) => shown && e.currentTarget.select()} />
        {shown ? (
          <>
            <CopyButton text={secret} what="Clave secreta copiada" />
            <Button size="sm" variant="ghost" icon={EyeOff} onClick={() => setVisible(false)}>
              Ocultar
            </Button>
          </>
        ) : (
          <Button size="sm" icon={Eye} loading={reveal.isPending} disabled={!canManage} onClick={() => (secret ? setVisible(true) : reveal.mutate())}>
            Mostrar
          </Button>
        )}
      </div>
      <span className="hint">Trátala como una contraseña: no la pongas en el código de tu web (para eso está el formulario de arriba). Por seguridad, cada vez que alguien la ve queda registrado.</span>
      {canManage && (
        <div className="row wrap mt-8">
          <Button size="sm" variant="ghost" icon={RotateCw} onClick={() => setConfirmRotate(true)}>
            Cambiar la clave
          </Button>
        </div>
      )}
      <ConfirmDialog
        open={confirmRotate}
        title="¿Cambiar la clave secreta?"
        message="Se creará una clave nueva y la actual dejará de funcionar al momento. Las herramientas que la usen (Zapier, Make…) no podrán enviar leads hasta que pongas la nueva. Hazlo si crees que alguien más la conoce."
        confirmLabel="Cambiar la clave"
        danger
        loading={rotate.isPending}
        onConfirm={() => rotate.mutate()}
        onClose={() => setConfirmRotate(false)}
      />
    </div>
  );
}

// ───────────── Sección ─────────────

export function WebSection({ data, canManage }: { data: IntegrationsResponse; canManage: boolean }) {
  const { endpoints } = data;
  return (
    <div className="intg-section">
      <section className="card" aria-labelledby="intg-form">
        <IntegrationHead logo={<Globe />} title={<span id="intg-form">Formulario de tu web</span>} subtitle="Para tu landing o página de captación" status={<span className="badge badge-dot badge-success">Siempre disponible</span>} />
        <p className="intg-desc">
          Los contactos que dejen sus datos en tu web entran directamente en KAI. No necesitas contraseñas: está pensado para formularios públicos y tiene
          protección contra el spam. Tienes dos opciones: usar el formulario que generamos aquí abajo o enviar los datos de tu propio formulario a esta
          dirección.
        </p>
        <div className="mt-16">
          <CopyField
            label="Dirección del formulario público"
            value={endpoints.publicFormUrl}
            what="Dirección del formulario copiada"
            hint={
              <>
                Para quien te lleve la web: acepta peticiones <code className="code-inline">POST</code> con cuerpo JSON (los mismos campos que el webhook de
                abajo) y necesita al menos un teléfono o un email. El campo <code className="code-inline">website</code> debe ir vacío (es la trampa
                anti-spam).
              </>
            }
          />
        </div>
        <div className="divider" />
        <h3 className="row intg-h3">
          <CodeXml aria-hidden className="intg-h-icon" />
          Generador de formulario listo para pegar
        </h3>
        <p className="small muted intg-gap-b">
          Personaliza los textos y copia el código. Pide nombre, teléfono, email y (si quieres) su objetivo, e incluye la casilla de consentimiento de
          privacidad.
        </p>
        <FormGenerator endpoint={endpoints.publicFormUrl} publicKey={endpoints.publicKey} />
      </section>

      <section className="card" aria-labelledby="intg-hook">
        <IntegrationHead logo={<Webhook />} title={<span id="intg-hook">Webhook para Zapier o Make</span>} subtitle="Para conectar otras herramientas" status={<span className="badge badge-dot badge-success">Siempre disponible</span>} />
        <p className="intg-desc">
          Zapier y Make son herramientas que conectan aplicaciones entre sí sin programar. Úsalas si tus contactos llegan por otra vía (Typeform, Google
          Forms, Tally, tu CRM…) y quieres que entren solos en KAI. Este acceso sí está protegido con una clave secreta.
        </p>
        <div className="grid-2 intg-grid-top mt-16">
          <div className="col gap-12">
            <CopyField label="Dirección del webhook (URL)" value={endpoints.leadsWebhookUrl} what="Dirección del webhook copiada" hint="Método POST · Cabecera Content-Type: application/json" />
            <SecretBox canManage={canManage} />
            <Callout tone="info" icon={KeyRound}>
              Cada petición debe llevar la cabecera <code className="code-inline">X-KAI-Key</code> con tu clave secreta. Si no la lleva o no coincide, KAI
              la rechaza.
            </Callout>
          </div>
          <div className="col">
            <div className="row-between wrap">
              <span className="label">Ejemplo de cuerpo JSON</span>
              <CopyButton text={EXAMPLE_BODY} what="Ejemplo copiado" />
            </div>
            <pre className="code intg-code-sm" tabIndex={0} aria-label="Ejemplo de cuerpo JSON">
              {EXAMPLE_BODY}
            </pre>
            <p className="xs subtle">
              Hace falta al menos uno de estos datos: <code className="code-inline">name</code>, <code className="code-inline">email</code>,{' '}
              <code className="code-inline">phone</code> o <code className="code-inline">instagram</code>. KAI responde{' '}
              <code className="code-inline">{'{"ok": true, "leadId": "…", "created": true}'}</code> (<code className="code-inline">created</code> es false si ese
              lead ya existía).
            </p>
          </div>
        </div>

        <h3 className="intg-small-h mt-16">Campos que acepta</h3>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Campo</th>
                <th scope="col">Qué es</th>
              </tr>
            </thead>
            <tbody>
              {FIELDS.map((f) => (
                <tr key={f.name}>
                  <td>
                    <code className="code-inline">{f.name}</code>
                  </td>
                  <td className="small">{f.text}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="col gap-12 mt-16">
          <Guide icon={BookOpen} title="Cómo configurarlo en Zapier">
            <Steps>
              <li>Crea un Zap y elige como disparador tu herramienta (por ejemplo, «Nueva respuesta» en Typeform).</li>
              <li>
                Añade una acción <UiLabel>Webhooks by Zapier</UiLabel> con el evento <UiLabel>POST</UiLabel> (es una función de los planes de pago de
                Zapier).
              </li>
              <li>
                En <UiLabel>URL</UiLabel> pega la dirección del webhook y en <UiLabel>Payload Type</UiLabel> elige <UiLabel>Json</UiLabel>.
              </li>
              <li>
                En <UiLabel>Data</UiLabel> añade los campos que quieras enviar (<code className="code-inline">name</code>,{' '}
                <code className="code-inline">phone</code>, <code className="code-inline">email</code>…) y asígnales las respuestas de tu formulario.
              </li>
              <li>
                En <UiLabel>Headers</UiLabel> añade <code className="code-inline">X-KAI-Key</code> con tu clave secreta como valor.
              </li>
              <li>Prueba el paso: el lead aparecerá en KAI. Después, activa el Zap.</li>
            </Steps>
          </Guide>
          <Guide icon={BookOpen} title="Cómo configurarlo en Make">
            <Steps>
              <li>En tu escenario, después del módulo de tu formulario, añade el módulo <UiLabel>HTTP</UiLabel> → <UiLabel>Make a request</UiLabel>.</li>
              <li>
                <UiLabel>URL</UiLabel>: la dirección del webhook. <UiLabel>Method</UiLabel>: <UiLabel>POST</UiLabel>.
              </li>
              <li>
                En <UiLabel>Headers</UiLabel> añade uno con nombre <code className="code-inline">X-KAI-Key</code> y tu clave secreta como valor.
              </li>
              <li>
                <UiLabel>Body type</UiLabel>: <UiLabel>Raw</UiLabel>; <UiLabel>Content type</UiLabel>: <UiLabel>JSON (application/json)</UiLabel>. En{' '}
                <UiLabel>Request content</UiLabel> pega el ejemplo de cuerpo JSON y cambia los valores por los datos de tu formulario.
              </li>
              <li>Ejecuta el escenario una vez para probarlo: el lead aparecerá en KAI.</li>
            </Steps>
          </Guide>
          <p className="xs subtle">
            Opción avanzada: en lugar de <code className="code-inline">X-KAI-Key</code> puedes firmar el cuerpo con HMAC-SHA256 usando la clave secreta y
            enviarlo en la cabecera <code className="code-inline">X-KAI-Signature: sha256=&lt;firma&gt;</code>. Más información sobre las herramientas en{' '}
            <ExtLink href="https://zapier.com">zapier.com</ExtLink> y <ExtLink href="https://www.make.com">make.com</ExtLink>.
          </p>
        </div>
      </section>
    </div>
  );
}

