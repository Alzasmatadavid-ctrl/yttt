# Integraciones: dónde se configura cada cosa

KAI tiene dos tipos de configuración:

- **Del servidor** (archivo `.env` o variables de entorno del hosting): las claves de *tu* plataforma KAI. Las configuras una vez, como propietario del SaaS.
- **De cada entrenador** (pantalla **Integraciones** del menú de la app, con tres pestañas: **WhatsApp, Instagram y anuncios**, **Calendario** y **Formularios y webhooks**): su número de WhatsApp, su cuenta de Instagram, su calendario… Cada negocio conecta lo suyo.

Ninguna integración es obligatoria para arrancar. Si falta algo, la pantalla **Integraciones** lo indica.

| Integración | `.env` (servidor) | Pantalla Integraciones (cada entrenador) |
|---|---|---|
| Claude (IA) | `ANTHROPIC_API_KEY` | — |
| WhatsApp Business | `META_APP_ID`, `META_APP_SECRET`, `META_VERIFY_TOKEN` | Identificador del número + token |
| Instagram | (las mismas de Meta) | ID de la cuenta de Instagram + token |
| Meta Lead Ads | (las mismas de Meta) | ID de la página de Facebook + token |
| Google Calendar | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Pestaña Calendario → botón “Conectar Google Calendar” |
| Calendly | — | Pestaña Calendario → token personal de Calendly |
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
5. Reinicia. En **Integraciones**, en la tarjeta **Inteligencia artificial de KAI**, verás “IA: Claude”.

Ajustes opcionales (ya vienen bien configurados):

| Variable | Valor por defecto | Qué hace |
|---|---|---|
| `AI_MODEL_MAIN` | `claude-opus-5-5` | Modelo que escribe los mensajes. |
| `AI_MODEL_FAST` | `claude-haiku-4-5` | Modelo rápido que analiza los mensajes y revisa la calidad. |
| `AI_SETTER_EFFORT` | `low` | Cuánto razona antes de responder. `low` es rápido y suficiente para conversaciones. |
| `AI_JUDGE_ENABLED` | `true` | Segunda revisión de cada mensaje antes de enviarlo. |

**Consejo de costes:** en **Ajustes → Plan y uso** verás los mensajes de IA usados en el mes. Los límites de cada plan se editan en **Administración → Planes** (`/admin/planes`).

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
2. **URL de devolución de llamada**: la que aparece en KAI → **Integraciones → WhatsApp, Instagram y anuncios**, recuadro **Webhook de Meta** → **URL de devolución de llamada (Callback URL)** (es `https://tu-dominio/api/webhooks/meta`).
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
4. En KAI → **Integraciones → WhatsApp, Instagram y anuncios**, tarjeta **WhatsApp Business** → **Conectar WhatsApp Business**: pega el identificador y el token. KAI lo comprueba con Meta antes de guardarlo.

**Plantillas (importante).** WhatsApp solo permite escribir libremente durante las 24 h siguientes al último mensaje del lead. Fuera de esa ventana hay que usar **plantillas aprobadas** por Meta. Créalas en **WhatsApp Manager → Plantillas de mensajes** (categoría *Utilidad* para recordatorios, *Marketing* para seguimientos). Después, en KAI → **Integraciones → WhatsApp, Instagram y anuncios**, en la tarjeta **WhatsApp Business** (ya conectada) busca el apartado **Plantillas para escribir fuera de las 24 horas**, escribe el nombre y el idioma de cada una y pulsa **Guardar plantillas**:

| Plantilla en KAI | Cuándo se usa | Variables que rellena KAI |
|---|---|---|
| Primer contacto | Lead de formulario o anuncio que aún no ha escrito | `{{1}}` = nombre |
| Seguimiento | Seguimiento fuera de las 24 h | `{{1}}` = nombre |
| Recordatorio de la llamada | Confirmación y recordatorios de la llamada | `{{1}}` = nombre, `{{2}}` = día y hora (“martes 14 de octubre a las 18:00”) |
| No-show (no se presentó) | Mensaje tras no presentarse | `{{1}}` = nombre |

Ejemplo de plantilla de recordatorio: *“Hola {{1}}, te recuerdo tu llamada de valoración el {{2}}. Si necesitas cambiarla, respóndeme por aquí.”*

Si falta una plantilla y la ventana está cerrada, KAI **no envía nada** y te deja un aviso. Nunca se salta las reglas de WhatsApp.

### 2.4. Conectar Instagram (cada entrenador)

Requisitos: cuenta de Instagram **profesional** (empresa o creador).

1. En la app de Meta → **Instagram → Configuración de la API con inicio de sesión de Instagram**.
2. Añade la cuenta de Instagram y genera un **token de acceso** con los permisos `instagram_business_basic` e `instagram_business_manage_messages`.
3. Copia el **ID de la cuenta de Instagram** (solo números).
4. En la app de Instagram del entrenador: **Configuración → Mensajes y respuestas a historias → Herramientas de mensajes → Permitir acceso a los mensajes** (activado).
5. En KAI → **Integraciones → WhatsApp, Instagram y anuncios**, tarjeta **Instagram** → **Conectar Instagram**: pega el ID y el token.

Si usas la API antigua con página de Facebook, en el formulario, en «¿Cómo has creado el token? (servidor de la API)», elige **Inicio de sesión con Facebook** (`graph.facebook.com`) en lugar de **Inicio de sesión con Instagram (recomendado)**.

Notas:
- Igual que WhatsApp, Instagram solo permite responder durante 24 h desde el último mensaje del lead. Cuando el entrenador responde a mano desde KAI, se usa la etiqueta de “agente humano” (hasta 7 días).
- Si el entrenador responde desde la app de Instagram, KAI lo detecta y se pausa en esa conversación para no pisarle.

### 2.5. Conectar Meta Lead Ads (cada entrenador)

1. Necesitas el **ID de la página de Facebook** asociada a los anuncios (Página → Información → ID de la página).
2. Genera un token de página (o de usuario del sistema) con los permisos `leads_retrieval`, `pages_manage_metadata`, `pages_show_list` y `pages_read_engagement`.
3. En KAI → **Integraciones → WhatsApp, Instagram y anuncios**, tarjeta **Meta Lead Ads** → **Conectar Meta Lead Ads**: pega el ID y el token. KAI suscribe la página automáticamente al aviso `leadgen`.
4. En la misma tarjeta eliges qué hacer con cada lead nuevo: **Escribirle por WhatsApp (recomendado)**, que usa la plantilla de «Primer contacto» (hace falta WhatsApp conectado y que el formulario del anuncio pida el teléfono), o **Solo guardarlo en KAI**.

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

**Integraciones → Calendario**, tarjeta **Google Calendar** → **Conectar Google Calendar**, y aceptar los permisos. A partir de ahí, KAI cruza su disponibilidad (**Agenda → Disponibilidad**) con los eventos que ya tenga en el calendario.

---

## 4. Calendly

Si el entrenador ya usa Calendly, KAI le ofrece los huecos reales de Calendly al lead y le envía el enlace de reserva; cuando el lead reserva, la cita aparece en KAI automáticamente (gracias al webhook del paso 4).

1. En Calendly: **Integraciones y aplicaciones → API y webhooks → Tokens de acceso personal → Generar nuevo token**. Copia el token (Calendly solo lo enseña una vez).
2. En KAI → **Integraciones → Calendario**, tarjeta **Calendly**: pega el token, pulsa **Conectar Calendly** y, si tienes varios tipos de evento, elige cuál debe ofrecer KAI (por ejemplo “Llamada de valoración”).
3. Para cambiar de cuenta o de tipo de evento, pulsa **Volver a conectar** o **Cambiar tipo de evento** y pega de nuevo el token. Si Calendly no lo acepta, no se cambia nada: sigue funcionando la conexión anterior.
4. KAI crea automáticamente el webhook en Calendly. Necesita que KAI esté publicado (dirección pública) y un plan de Calendly que permita webhooks (Standard o superior). Si no se puede crear, la pantalla lo indica.

> **Sin webhook, Calendly no le sirve a KAI.** KAI seguiría enviando tu enlace de reserva, pero no sabría cuándo alguien reserva o cancela: esas llamadas no aparecerían en la Agenda (y con Calendly conectado no se pueden apuntar a mano), los leads no recibirían confirmación ni recordatorios y el panel y Analítica no las contarían. Lo único que podrías hacer es pasar tú al lead a “Llamada agendada” desde su ficha. Mientras no tengas webhooks, **usa la agenda de KAI o Google Calendar**: pulsa **Desconectar** en la tarjeta de Calendly y KAI volverá a ofrecer los huecos de su propia agenda. Cuando lo soluciones, vuelve a conectar Calendly.

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

La forma más sencilla: en **Integraciones → Formularios y webhooks**, tarjeta **Formulario de tu web**, usa el **Generador de formulario listo para pegar**. Personaliza los textos (título, botón, mensaje de agradecimiento, responsable de los datos y enlace a tu política de privacidad), pulsa copiar y pega el código en tu landing (por ejemplo, en un bloque HTML de WordPress, Webflow o Framer). El código ya incluye la casilla de consentimiento de privacidad y la protección contra el spam.

Si prefieres tu propio formulario, envía los datos desde el navegador a la **Dirección del formulario público** que aparece en esa misma tarjeta:

```
POST https://TU_DOMINIO/api/public/forms/TU_CLAVE_PUBLICA
Content-Type: application/json

{ "name": "Ana López", "phone": "+34600111222", "email": "ana@example.com", "goal": "Perder 5 kg", "contact_via_whatsapp": true, "website": "" }
```

- Campos admitidos: `name`, `phone`, `email`, `instagram`, `goal`, `message`, `source_detail` (por ejemplo, el nombre de la campaña), `contact_via_whatsapp` (`true` o `false`) y `extra` (pares clave/valor, hasta 20). Hace falta al menos `phone` o `email`.
- `website` es la trampa anti-spam: déjalo oculto y vacío. Si llega relleno, KAI ignora el envío sin avisar.
- Pide el consentimiento de privacidad en tu formulario antes de enviar los datos.

Si el entrenador tiene WhatsApp conectado, el lead deja su teléfono **y** el formulario envía `"contact_via_whatsapp": true` (por ejemplo, con una casilla «Acepto que me escribáis por WhatsApp»), KAI le escribe por WhatsApp en segundos. Si no se envía, el lead se guarda igualmente pero KAI no le escribe: así nadie puede usar tu formulario para que KAI escriba a números ajenos. El formulario del generador ya lo envía cuando activas WhatsApp.

Para protegerte del spam, el formulario público acepta como mucho 30 leads nuevos por hora y 200 por día en cada negocio (`PUBLIC_FORM_MAX_PER_HOUR` y `PUBLIC_FORM_MAX_PER_DAY`). Si se supera, el formulario muestra un aviso para intentarlo más tarde y KAI te avisa a ti.

En el webhook de servidor (6.2), que va firmado con tu secreto, `contact_via_whatsapp` sigue siendo `true` si no se envía.

### 6.2. Webhook de servidor (Zapier, Make, Typeform, tu CRM…)

En **Integraciones → Formularios y webhooks**, tarjeta **Webhook para Zapier o Make**, tienes la dirección, el secreto y una guía para Zapier y Make.

```
POST https://TU_DOMINIO/api/webhooks/leads/TU_CLAVE_PUBLICA
Content-Type: application/json
X-KAI-Key: TU_SECRETO
```

```json
{ "name": "Ana López", "phone": "+34600111222", "email": "ana@example.com", "goal": "Perder 5 kg", "source_detail": "Typeform enero" }
```

Hace falta al menos uno de estos datos: `name`, `email`, `phone` o `instagram`. En lugar de `X-KAI-Key` puedes firmar el cuerpo: cabecera `X-KAI-Signature: sha256=<HMAC-SHA256 del cuerpo con el secreto, en hexadecimal>`.

Si crees que el secreto se ha filtrado, pulsa **Regenerar secreto** en Integraciones (el anterior deja de funcionar al momento).

---

## 7. Cron externo (opcional)

KAI procesa recordatorios y seguimientos él solo cada pocos segundos (`RUN_WORKER=true`). Si tu hosting “duerme” el servidor cuando no hay visitas, configura un cron externo (por ejemplo <https://cron-job.org>) que cada minuto haga:

```
POST https://TU_DOMINIO/api/internal/cron
Authorization: Bearer TU_CRON_SECRET
```

y define `CRON_SECRET` en el `.env` con una palabra secreta larga.
