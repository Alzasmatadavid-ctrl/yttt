# Integraciones: dónde se configura cada cosa

KAI tiene dos tipos de configuración:

- **Del servidor** (archivo `.env` o variables de entorno del hosting): las claves de *tu* plataforma KAI. Las configuras una vez, como propietario del SaaS.
- **De cada entrenador** (pantalla **Integraciones** dentro de la app): su número de WhatsApp, su cuenta de Instagram, su calendario… Cada negocio conecta lo suyo.

Ninguna integración es obligatoria para arrancar. Si falta algo, la pantalla **Integraciones** lo indica.

| Integración | `.env` (servidor) | Pantalla Integraciones (cada entrenador) |
|---|---|---|
| Claude (IA) | `ANTHROPIC_API_KEY` | — |
| WhatsApp Business | `META_APP_ID`, `META_APP_SECRET`, `META_VERIFY_TOKEN` | Identificador del número + token |
| Instagram | (las mismas de Meta) | ID de la cuenta de Instagram + token |
| Meta Lead Ads | (las mismas de Meta) | ID de la página de Facebook + token |
| Google Calendar | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Botón “Conectar Google Calendar” |
| Calendly | — | Token personal de Calendly |
| Email (Resend) | `EMAIL_PROVIDER=resend`, `RESEND_API_KEY`, `EMAIL_FROM` | — |
| Formularios / landing / Zapier | — | Clave pública y secreto del webhook |

> Después de cambiar el `.env`, reinicia el servidor (`Ctrl + C` y `npm run dev`, o “Redeploy” en tu hosting).

---

## 1. Inteligencia artificial (Claude)

Sin esta clave KAI funciona en **modo simulado**: responde con reglas fijas (útil para probar, pero menos natural).

1. Entra en <https://console.anthropic.com> y crea una cuenta.
2. Ve a **Settings → Billing** y añade un método de pago (se paga por uso).
3. Ve a **API Keys → Create Key**, ponle un nombre (por ejemplo `kai-produccion`) y copia la clave (empieza por `sk-ant-`).
4. Pégala en `.env`:
   ```
   ANTHROPIC_API_KEY=sk-ant-...
   ```
5. Reinicia. En **Integraciones** verás “IA: Claude”.

Ajustes opcionales (ya vienen bien configurados):

| Variable | Valor por defecto | Qué hace |
|---|---|---|
| `AI_MODEL_MAIN` | `claude-opus-5-5` | Modelo que escribe los mensajes. |
| `AI_MODEL_FAST` | `claude-haiku-4-5` | Modelo rápido que analiza los mensajes y revisa la calidad. |
| `AI_SETTER_EFFORT` | `low` | Cuánto razona antes de responder. `low` es rápido y suficiente para conversaciones. |
| `AI_JUDGE_ENABLED` | `true` | Segunda revisión de cada mensaje antes de enviarlo. |

**Consejo de costes:** en **Ajustes → Plan** verás los mensajes de IA usados en el mes. Los límites de cada plan se editan en el panel `/admin`.

---

## 2. Meta: WhatsApp, Instagram y Lead Ads

Las tres integraciones usan **una sola app de Meta** (la tuya, como propietario de KAI).

### 2.1. Crear la app de Meta (una vez)

1. Entra en <https://developers.facebook.com> → **Mis apps → Crear app**.
2. Tipo de app: **Empresa** (Business). Asóciala a tu Business Manager.
3. En el panel de la app, añade los productos **WhatsApp**, **Instagram** y **Webhooks**.
4. En **Configuración de la app → Básica** copia:
   - **Identificador de la app** → `META_APP_ID`
   - **Clave secreta de la app** → `META_APP_SECRET`
5. Inventa una palabra secreta larga (por ejemplo `kai-verifica-7f3a9c`) y ponla en `META_VERIFY_TOKEN`.
6. Reinicia KAI.

### 2.2. Configurar el webhook (una vez)

Meta necesita una dirección **pública** para avisar a KAI de cada mensaje nuevo, así que primero publica KAI ([DESPLIEGUE.md](DESPLIEGUE.md)).

1. En la app de Meta → **Webhooks**.
2. **URL de devolución de llamada**: la que aparece en KAI → **Integraciones → URL del webhook de Meta** (es `https://tu-dominio/api/webhooks/meta`).
3. **Token de verificación**: el mismo `META_VERIFY_TOKEN`.
4. Pulsa **Verificar y guardar**.
5. Suscríbete a estos campos:
   - **WhatsApp Business Account** → `messages`
   - **Instagram** → `messages` (y `messaging_seen` si quieres)
   - **Page** → `leadgen` (para Lead Ads)

KAI comprueba la firma de cada aviso con `META_APP_SECRET`, así que nadie puede enviar mensajes falsos.

### 2.3. Conectar WhatsApp (cada entrenador)

1. En la app de Meta → **WhatsApp → Configuración de la API**, añade y verifica el número de teléfono del negocio.
2. Copia el **Identificador del número de teléfono** (Phone number ID, solo números).
3. Crea un **token permanente**: en Business Manager → **Configuración del negocio → Usuarios del sistema** → crea un usuario del sistema (Administrador) → **Generar token** con los permisos `whatsapp_business_messaging` y `whatsapp_business_management`. Asígnale la cuenta de WhatsApp en **Activos**.
4. En KAI → **Integraciones → WhatsApp → Conectar**: pega el identificador y el token. KAI lo comprueba con Meta antes de guardarlo.

**Plantillas (importante).** WhatsApp solo permite escribir libremente durante las 24 h siguientes al último mensaje del lead. Fuera de esa ventana hay que usar **plantillas aprobadas** por Meta. Créalas en **WhatsApp Manager → Plantillas de mensajes** (categoría *Utilidad* para recordatorios, *Marketing* para seguimientos) y escribe su nombre e idioma en KAI → Integraciones → WhatsApp → Plantillas:

| Plantilla en KAI | Cuándo se usa | Variables que rellena KAI |
|---|---|---|
| Primer contacto | Lead de formulario o anuncio que aún no ha escrito | `{{1}}` = nombre |
| Seguimiento | Seguimiento fuera de las 24 h | `{{1}}` = nombre |
| Recordatorio | Confirmación y recordatorios de la llamada | `{{1}}` = nombre, `{{2}}` = día y hora (“martes 14 de octubre a las 18:00”) |
| No-show | Mensaje tras no presentarse | `{{1}}` = nombre |

Ejemplo de plantilla de recordatorio: *“Hola {{1}}, te recuerdo tu llamada de valoración el {{2}}. Si necesitas cambiarla, respóndeme por aquí.”*

Si falta una plantilla y la ventana está cerrada, KAI **no envía nada** y te deja un aviso. Nunca se salta las reglas de WhatsApp.

### 2.4. Conectar Instagram (cada entrenador)

Requisitos: cuenta de Instagram **profesional** (empresa o creador).

1. En la app de Meta → **Instagram → Configuración de la API con inicio de sesión de Instagram**.
2. Añade la cuenta de Instagram y genera un **token de acceso** con los permisos `instagram_business_basic` e `instagram_business_manage_messages`.
3. Copia el **ID de la cuenta de Instagram** (solo números).
4. En la app de Instagram del entrenador: **Configuración → Mensajes y respuestas a historias → Herramientas de mensajes → Permitir acceso a los mensajes** (activado).
5. En KAI → **Integraciones → Instagram → Conectar**: pega el ID y el token.

Si usas la API antigua con página de Facebook, elige `graph.facebook.com` como servidor de la API en el formulario.

Notas:
- Igual que WhatsApp, Instagram solo permite responder durante 24 h desde el último mensaje del lead. Cuando el entrenador responde a mano desde KAI, se usa la etiqueta de “agente humano” (hasta 7 días).
- Si el entrenador responde desde la app de Instagram, KAI lo detecta y se pausa en esa conversación para no pisarle.

### 2.5. Conectar Meta Lead Ads (cada entrenador)

1. Necesitas el **ID de la página de Facebook** asociada a los anuncios (Página → Información → ID de la página).
2. Genera un token de página (o de usuario del sistema) con los permisos `leads_retrieval`, `pages_manage_metadata`, `pages_show_list` y `pages_read_engagement`.
3. En KAI → **Integraciones → Meta Lead Ads → Conectar**: pega el ID y el token. KAI suscribe la página automáticamente al aviso `leadgen`.
4. Si tiene WhatsApp conectado y el formulario pide teléfono, KAI escribirá al lead por WhatsApp con la plantilla de primer contacto.

### 2.6. Revisión de la app (para clientes reales)

Mientras la app de Meta está en **modo desarrollo** solo funciona con cuentas que sean administradoras o testers de la app. Para usarla con entrenadores reales tienes que pasar la **revisión de la app** de Meta (App Review) pidiendo los permisos anteriores y verificar tu negocio en Business Manager.

---

## 3. Google Calendar

KAI consulta los huecos ocupados del calendario y crea el evento (con enlace de Google Meet) al reservar.

### En el servidor (una vez)

1. Entra en <https://console.cloud.google.com> y crea un proyecto (por ejemplo “KAI”).
2. **APIs y servicios → Biblioteca** → busca **Google Calendar API** → **Habilitar**.
3. **APIs y servicios → Pantalla de consentimiento de OAuth**: tipo **Externo**, nombre de la app “KAI”, tu email. En *Permisos* añade `.../auth/calendar.events` y `.../auth/calendar.readonly` (o `.../auth/calendar`). Mientras esté en modo prueba, añade como usuarios de prueba los emails de los entrenadores.
4. **Credenciales → Crear credenciales → ID de cliente de OAuth** → tipo **Aplicación web**.
   - **URI de redireccionamiento autorizado**: `https://tu-dominio/api/integrations/google/callback`
   - En local: `http://localhost:5173/api/integrations/google/callback`
5. Copia el **ID de cliente** → `GOOGLE_CLIENT_ID` y el **secreto** → `GOOGLE_CLIENT_SECRET`. Reinicia.

> La dirección de redirección se construye con `API_URL` (o `APP_URL` si está vacía). Debe coincidir exactamente con la que pongas en Google.

### Cada entrenador

**Integraciones → Google Calendar → Conectar** y aceptar los permisos. A partir de ahí, KAI cruza su disponibilidad (Agenda → Disponibilidad) con los eventos que ya tenga en el calendario.

---

## 4. Calendly

Si el entrenador ya usa Calendly, KAI le ofrece los huecos reales de Calendly al lead y le envía el enlace de reserva; cuando el lead reserva, la cita aparece en KAI automáticamente.

1. En Calendly: **Integraciones → API y webhooks → Generar token** (token personal de acceso). Copia el token.
2. En KAI → **Integraciones → Calendly → Conectar**: pega el token y elige el tipo de evento (por ejemplo “Llamada de valoración”).
3. KAI crea automáticamente el webhook en Calendly. Necesita que KAI esté publicado (dirección pública) y un plan de Calendly que permita webhooks (Standard o superior). Si no se puede crear, la pantalla lo indica y KAI seguirá ofreciendo el enlace, pero tendrás que registrar las citas a mano.

---

## 5. Email (Resend)

Se usa para recuperar contraseñas e invitar a miembros del equipo. Con `EMAIL_PROVIDER=console` los emails solo se muestran en la terminal del servidor (útil para probar).

1. Crea una cuenta en <https://resend.com>.
2. **Domains → Add domain** y añade los registros DNS que te indica en tu proveedor de dominio. Espera a que salga “Verified”.
3. **API Keys → Create API key** y cópiala.
4. En `.env`:
   ```
   EMAIL_PROVIDER=resend
   RESEND_API_KEY=re_...
   EMAIL_FROM=KAI <no-reply@tudominio.com>
   ```

---

## 6. Formularios, landing pages y herramientas externas

Cada negocio tiene una **clave pública** (empieza por `kai_pk_`) y un **secreto** (empieza por `kai_sk_`). Los ves en **Integraciones → Formularios y webhooks**.

### 6.1. Formulario de tu web (sin programar el servidor)

Pega esto en tu landing (por ejemplo, en un bloque HTML de WordPress, Webflow o Framer) y cambia `TU_DOMINIO` y `TU_CLAVE_PUBLICA`:

```html
<form id="kai-form">
  <input name="name" placeholder="Nombre" required />
  <input name="phone" placeholder="WhatsApp (con prefijo, ej. +34…)" required />
  <input name="email" type="email" placeholder="Email" />
  <textarea name="goal" placeholder="¿Qué te gustaría conseguir?"></textarea>
  <!-- Campo trampa anti-spam: no lo quites y déjalo oculto -->
  <input name="website" style="display:none" tabindex="-1" autocomplete="off" />
  <button type="submit">Quiero información</button>
  <p id="kai-ok" style="display:none">¡Gracias! Te escribimos en unos minutos.</p>
</form>
<script>
  document.getElementById('kai-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(e.target));
    const res = await fetch('https://TU_DOMINIO/api/public/forms/TU_CLAVE_PUBLICA', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    if (res.ok) document.getElementById('kai-ok').style.display = 'block';
  });
</script>
```

Campos admitidos: `name`, `phone`, `email`, `instagram`, `goal`, `message`, `source_detail` (por ejemplo, el nombre de la campaña) y `extra` (pares clave/valor). Hace falta al menos `phone` o `email`.

Si el entrenador tiene WhatsApp conectado y el lead deja su teléfono, KAI le escribe por WhatsApp en segundos.

### 6.2. Webhook de servidor (Zapier, Make, Typeform, tu CRM…)

```
POST https://TU_DOMINIO/api/webhooks/leads/TU_CLAVE_PUBLICA
Content-Type: application/json
X-KAI-Key: TU_SECRETO
```

```json
{ "name": "Ana López", "phone": "+34600111222", "email": "ana@example.com", "goal": "Perder 5 kg", "source_detail": "Typeform enero" }
```

En lugar de `X-KAI-Key` puedes firmar el cuerpo: cabecera `X-KAI-Signature: sha256=<HMAC-SHA256 del cuerpo con el secreto, en hexadecimal>`.

Si crees que el secreto se ha filtrado, pulsa **Regenerar secreto** en Integraciones (el anterior deja de funcionar al momento).

---

## 7. Cron externo (opcional)

KAI procesa recordatorios y seguimientos él solo cada pocos segundos (`RUN_WORKER=true`). Si tu hosting “duerme” el servidor cuando no hay visitas, configura un cron externo (por ejemplo <https://cron-job.org>) que cada minuto haga:

```
POST https://TU_DOMINIO/api/internal/cron
Authorization: Bearer TU_CRON_SECRET
```

y define `CRON_SECRET` en el `.env` con una palabra secreta larga.
