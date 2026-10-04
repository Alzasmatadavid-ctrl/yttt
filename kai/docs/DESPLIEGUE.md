# Publicar KAI en internet

Para que WhatsApp, Instagram, Calendly y tus clientes puedan usar KAI, tiene que estar en un servidor con una dirección pública (`https://…`). KAI se publica como **una sola aplicación** (la web y el servidor juntos, con el `Dockerfile` incluido) más una **base de datos PostgreSQL**.

## Opción recomendada: Railway

**Por qué:** despliega el `Dockerfile` directamente desde GitHub, incluye PostgreSQL en el mismo proyecto, el servidor está siempre encendido (necesario para los recordatorios y seguimientos) y da HTTPS automático. Coste orientativo: desde unos 5–10 $/mes con poco tráfico.

### Paso 1 · Sube el código a GitHub

Recomendación: pon KAI en **su propio repositorio** (solo el contenido de la carpeta `kai`). Si lo dejas dentro de otro repositorio, en el paso 3 tendrás que indicar la carpeta.

### Paso 2 · Crea el proyecto y la base de datos

1. Entra en <https://railway.com> y regístrate con tu cuenta de GitHub.
2. **New Project → Deploy from GitHub repo** y elige el repositorio de KAI.
3. En el mismo proyecto: **New → Database → Add PostgreSQL**.

### Paso 3 · Configura el servicio de KAI

Haz clic en el servicio de KAI (no en la base de datos):

1. **Settings → Source → Root Directory**: déjalo vacío si el repositorio es solo KAI, o escribe `kai` si KAI está en una subcarpeta.
2. **Settings → Networking → Generate Domain**. Copia la dirección (por ejemplo `https://kai-production.up.railway.app`). Más adelante puedes poner tu propio dominio (`app.tudominio.com`) en **Custom Domain**.
3. **Variables** → añade estas (botón **New Variable** o **Raw Editor**):

```
NODE_ENV=production
APP_URL=https://kai-production.up.railway.app
DATABASE_URL=${{Postgres.DATABASE_URL}}
ENCRYPTION_KEY=<pega aquí la clave generada>
ADMIN_EMAIL=tu@email.com
ADMIN_PASSWORD=<una contraseña larga>
ANTHROPIC_API_KEY=sk-ant-...
EMAIL_PROVIDER=resend
RESEND_API_KEY=re_...
```

- `DATABASE_URL=${{Postgres.DATABASE_URL}}` se escribe tal cual: Railway lo sustituye por la dirección de tu base de datos.
- Para generar `ENCRYPTION_KEY`, en tu ordenador ejecuta:
  ```bash
  node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
  ```
  Guárdala en un gestor de contraseñas: si la pierdes, habrá que reconectar todas las integraciones.
- Añade también las de Meta, Google y Resend cuando las tengas ([INTEGRACIONES.md](INTEGRACIONES.md)).
- No hace falta `PORT`: Railway la pone sola.
- `ADMIN_EMAIL` y `ADMIN_PASSWORD` crean tu cuenta de administración al arrancar. Registrarse en la web con ese email **no** da acceso al panel. Si ya tenías una cuenta normal con ese email y quieres que sea la de administración, añade `ADMIN_PROMOTE_EXISTING=true` para un arranque y luego quítala.
- Sin `EMAIL_PROVIDER=resend` y `RESEND_API_KEY`, en producción **no se envía ningún email** (recuperar contraseña, invitaciones). Las invitaciones se pueden copiar como enlace desde **Ajustes → Equipo**.
- `TRUST_PROXY` puede quedarse vacío en Railway y Render: KAI confía solo en sus proxies internos para saber la IP real de cada visitante (la necesita para los límites de intentos). Si pones Cloudflare delante, añade sus rangos de IP (ver `.env.example`).

### Paso 4 · Despliega y comprueba

1. Railway construye y arranca KAI solo (tarda 2–4 minutos). Las tablas de la base de datos se crean automáticamente al arrancar.
2. Abre `https://TU_DOMINIO/api/health`. Debe responder `{"ok":true,…}`.
3. Abre `https://TU_DOMINIO` y entra con `ADMIN_EMAIL` / `ADMIN_PASSWORD`. Verás el panel de **Administración** (Resumen, Negocios, Usuarios, Planes y Registros).
4. Para usar KAI tú mismo como entrenador, cierra sesión y crea una cuenta normal con **Probar KAI** usando otro email (el de administración no puede registrarse otra vez).

### Paso 5 · Conecta Meta

Con la dirección pública ya puedes configurar el webhook de Meta: `https://TU_DOMINIO/api/webhooks/meta` ([INTEGRACIONES.md · 2.2](INTEGRACIONES.md#22-configurar-el-webhook-una-vez)).

### Actualizar KAI

Cada vez que subas cambios a la rama principal de GitHub, Railway vuelve a desplegar solo. Los cambios de base de datos (migraciones) se aplican automáticamente al arrancar.

---

## Alternativas

### Render + Neon

1. Base de datos en <https://neon.tech> (plan gratuito disponible): crea un proyecto y copia la *connection string* (incluye `sslmode=require`) → `DATABASE_URL`.
2. En <https://render.com>: **New → Web Service** → tu repositorio → **Runtime: Docker** (Root Directory `kai` si hace falta).
3. Añade las mismas variables que en Railway.
4. Usa un plan **de pago** (Starter): los planes gratuitos se “duermen” y KAI dejaría de enviar recordatorios. Si aun así usas uno que se duerme, configura el cron externo ([INTEGRACIONES.md · 7](INTEGRACIONES.md#7-cron-externo-opcional)).

### Tu propio servidor (VPS) con Docker

En un servidor con Docker instalado (Hetzner, DigitalOcean…):

```bash
git clone <tu-repositorio> kai && cd kai
cp .env.example .env
# Edita .env: APP_URL, ENCRYPTION_KEY, POSTGRES_PASSWORD, ADMIN_EMAIL, ADMIN_PASSWORD…
# (NODE_ENV=production, SERVE_FRONTEND=true y DATABASE_URL ya los pone docker-compose.yml)
docker compose up -d --build
```

KAI queda escuchando en el puerto 3000.

Si ya tienes PostgreSQL en otro sitio y solo quieres la imagen de KAI (sin `docker compose`), añade `DATABASE_URL` a tu `.env` y arranca así:

```bash
docker build -t kai .
docker run -d -p 3000:3000 --env-file .env -e NODE_ENV=production -e SERVE_FRONTEND=true kai
```

Los `-e` del final aseguran el modo producción y que se sirva la web aunque tu `.env` diga otra cosa (con `--env-file`, el `.env` tiene prioridad sobre los valores de la imagen). Pon delante un proxy con HTTPS (por ejemplo Caddy: `app.tudominio.com { reverse_proxy localhost:3000 }`). Con el proxy en la misma máquina no hace falta tocar `TRUST_PROXY`; evita que el puerto 3000 quede abierto a internet sin pasar por el proxy (cortafuegos).

### Supabase como base de datos

Copia la *connection string* de **Project Settings → Database** (modo *Session* o *Direct*, con `sslmode=require`) y úsala como `DATABASE_URL`.

---

## Lista de comprobación antes de vender KAI

- [ ] `NODE_ENV=production`, `ENCRYPTION_KEY` y `DATABASE_URL` configuradas (sin ellas KAI no arranca en producción, a propósito).
- [ ] `APP_URL` con `https://` y tu dominio definitivo (las cookies de sesión se marcan como seguras).
- [ ] `ADMIN_PASSWORD` larga y única. Tras el primer arranque puedes borrarla de las variables: la cuenta ya existe.
- [ ] Email real configurado (Resend) para recuperar contraseñas e invitaciones (sin él, en producción no se envía ningún email).
- [ ] Entra con la cuenta de `ADMIN_EMAIL` y comprueba que ves el panel de **Administración**.
- [ ] Copias de seguridad de la base de datos activadas (Railway, Neon y Supabase las incluyen).
- [ ] App de Meta revisada y aprobada, y negocio verificado en Business Manager.
- [ ] Pantalla de consentimiento de Google publicada (o entrenadores añadidos como usuarios de prueba).
- [ ] Política de privacidad y condiciones de uso completadas: KAI incluye una plantilla en `/privacidad` y `/terminos` (archivo `frontend/src/pages/Legal.tsx`). Sustituye los datos entre [corchetes] y revísala con un profesional.
- [ ] **No** ejecutes `npm run db:seed` en producción (los datos demo son solo para tu ordenador). Si aun así lo haces, exige `--force`, una `DEMO_PASSWORD` propia y un `DEMO_EMAIL` que no sea el de ninguna cuenta real.

## Varias instancias

Puedes ejecutar más de una copia del servidor: la cola de trabajos usa bloqueos de PostgreSQL (`FOR UPDATE SKIP LOCKED`), así que cada recordatorio o respuesta se procesa una sola vez.
