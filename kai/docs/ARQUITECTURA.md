# Arquitectura de KAI

Documento técnico para quien mantenga o amplíe KAI.

## Visión general

```
                ┌────────────── Frontend (React 19 + Vite) ──────────────┐
                │ Landing · Acceso · Onboarding · Hoy · Bandeja          │
                │ Pipeline · Leads · Agenda · Analítica · KAI Copilot    │
                │ Simulador · Setter IA · Integraciones · Ajustes        │
                │ Administración                                         │
                └───────────────────────────┬────────────────────────────┘
                                            │ /api (JSON, cookie de sesión)
┌───────────────────────────────── Backend (Fastify 5, TypeScript) ─────────────────────────────────┐
│ auth · settings · crm · calendar · integrations · webhooks · analytics · admin · ai/copilot       │
│                                                                                                    │
│  Webhooks (Meta, Calendly, formularios) ──► inbound ──► cola de trabajos ──► worker               │
│                                                         (scheduled_jobs)     ├─ kai_reply ─► Setter│
│                                                                              ├─ first_contact      │
│                                                                              ├─ followup           │
│                                                                              ├─ recordatorios      │
│                                                                              ├─ no_show / post_call│
│                                                                              └─ analítica/manten.  │
└───────────────────────────────────────────────┬────────────────────────────────────────────────────┘
                                                │ Drizzle ORM
                         PostgreSQL (producción) · PGlite (desarrollo y tests)
```

- **Un solo despliegue**: en producción el backend sirve también la web compilada (`SERVE_FRONTEND=true`).
- **Sin servicios extra**: la cola de trabajos vive en PostgreSQL (no hace falta Redis).
- **Todo funciona sin credenciales**: IA en modo simulado, base de datos embebida, email por consola.

## Módulos del backend (`backend/src`)

| Módulo | Responsabilidad |
|---|---|
| `config/` | Variables de entorno validadas (Zod) y valores por defecto de cada negocio nuevo (cualificación, objeciones, automatizaciones, planes). |
| `database/` | Esquema (32 tablas), cliente (Postgres o PGlite), migraciones SQL, datos mínimos (`bootstrap`) y demo (`seed`). |
| `auth/` | Registro, login, sesiones (cookie `kai_session`, 30 días deslizantes, token guardado como SHA-256), recuperación de contraseña, invitaciones, «Crear mi negocio» para cuentas que se han quedado sin ninguno, guardas de rol/permiso, aislamiento por negocio y límite de peticiones por negocio en las pruebas que gastan IA. |
| `business/`, `plans/` | Creación de negocios con su configuración inicial; límites por plan (leads/mes, mensajes IA/mes, miembros, canales) y contadores de uso. |
| `crm/` | Leads (deduplicación por canal, email y teléfono), pipeline de 12 etapas con transiciones automáticas, puntuación determinista, conversaciones, envío de mensajes, bandeja, avisos y escalado a humano. |
| `ai/` | Proveedor de IA intercambiable, contexto, memoria por lead, análisis, estrategia, agente, herramientas, validación, Copilot. |
| `calendar/` | Disponibilidad, cálculo de huecos libres, citas, Google Calendar y Calendly. |
| `integrations/` | Canales (WhatsApp, Instagram, web), Graph API de Meta, conexiones cifradas, email. |
| `webhooks/` | Entrada de mensajes de Meta, eventos de Calendly, leads de formularios y webhooks externos. |
| `automation/` | Cola de trabajos (`scheduled_jobs`), recordatorios, seguimientos, textos deterministas y el worker. |
| `analytics/` | Embudo por cohortes, series diarias, origen, valor del pipeline, ROI y panel principal. |
| `settings/`, `admin/` | API de configuración, equipo y onboarding; panel de administración del SaaS. |
| `audit/` | Registro de auditoría (`audit_logs`) y de errores (`error_logs`). |
| `lib/` | Dominio compartido con el frontend (`domain.ts`), criptografía, fechas, texto, errores y utilidades HTTP. |

## Flujo de un mensaje entrante

1. **Webhook** (`webhooks/meta.webhook.ts`): verifica la firma `X-Hub-Signature-256` con `META_APP_SECRET`, localiza el negocio por el identificador de la cuenta y descarta duplicados (`messages.external_id` único).
2. **Inbound** (`webhooks/inbound.service.ts`): crea o encuentra el lead y la conversación, guarda el mensaje, cancela seguimientos pendientes y programa un trabajo `kai_reply` con un pequeño retardo “humano” (configurable). Si llegan varios mensajes seguidos, el trabajo se reprograma (`dedupeKey reply:<conversación>`) para responder a todos a la vez.
3. **Worker** (`automation/worker.ts`): reclama trabajos vencidos con `FOR UPDATE SKIP LOCKED`, reintenta con espera creciente y marca los fallidos.
4. **KAI Setter** (`ai/setter/setter-engine.ts`):
   1. Comprobaciones: autopiloto, conversación no pausada, lead sin baja, límite de mensajes del plan.
   2. **Análisis** (`ai/analysis`): extrae cualificación, señales, objeciones, intención de reservar, horario elegido, preguntas médicas, petición de humano, enfado… Con IA (modelo rápido + salida estructurada) o por reglas. Las señales de seguridad (baja, humano, “¿eres un bot?”) siempre se comprueban también por reglas.
   3. **Actualización**: fusiona la cualificación, recalcula la puntuación (`crm/scoring.ts`, pesos configurables; la IA nunca “inventa” la nota), guarda memorias y mueve el pipeline.
   4. **Casos especiales**: baja → despedida y nunca más; salud → mensaje prudente fijo + escalado; humano/enfado/negociación → escalado con aviso “KAI necesita tu intervención”.
   5. **Estrategia** (`ai/setter/strategy.ts`): decide la siguiente acción (saludar, preguntar X, tratar objeción, contextualizar o dar precio, proponer llamada, ofrecer huecos, reservar…).
   6. **Agente** (`ai/setter/agents.ts`): redacta el mensaje (LLM con herramientas `get_available_slots`, `book_call`, `reschedule_call`, `cancel_call`, `request_human`, o por reglas).
   7. **Control de calidad** (`ai/validation/output-validator.ts`): una sola pregunta, longitud, sin markdown ni frases robóticas, sin promesas de resultados ni consejos médicos, sin presión, horas y precios **solo** si existen de verdad, enlaces permitidos, sin repetir mensajes. Opcionalmente, un segundo modelo revisa el tono. Hasta 3 regeneraciones; si no, respuesta por reglas; si tampoco, escalado a humano.
   8. **Envío** (`crm/messaging.service.ts`): respeta la ventana de 24 h (fuera de ella usa plantillas aprobadas o no envía), registra el resultado y programa el siguiente seguimiento.

## Reglas que el código garantiza (no solo el prompt)

| Regla | Dónde se impone |
|---|---|
| Nunca inventar horarios | El agente solo recibe huecos calculados por `calendar/` y el validador rechaza cualquier hora que no esté en la lista. La reserva vuelve a comprobar el hueco. |
| Nunca inventar precios | El validador rechaza importes que no coincidan con el servicio configurado. |
| Nunca inventar datos | El validador rechaza cifras (años, clientes, kilos…) que no estén en los datos del negocio. |
| Nunca prometer resultados ni diagnosticar | Validador + mensaje médico fijo + escalado. |
| Una pregunta por mensaje | Validador. |
| No acosar | Seguimientos limitados, horas de descanso y cancelación automática si el lead responde, se da de baja o un humano interviene. |
| Transparencia | Presentación como asistente en el primer mensaje (por defecto) y nunca niega ser un bot. |
| Intervención humana | Pausar KAI por conversación o globalmente; tomar el control; avisos. |
| Confirmación de acciones sensibles | Copilot crea `pending_actions` que solo se ejecutan tras confirmar (caducan a las 24 h). |

## Proveedor de IA intercambiable

`ai/providers/types.ts` define `LLMProvider` con dos operaciones: `chat` (conversación con herramientas) y `structured` (salida validada con un esquema Zod). Implementaciones:

- `anthropic.provider.ts`: Claude (modelo principal y rápido configurables, *prompt caching*, salidas estructuradas, *fallbacks* de servidor).
- Modo simulado: sin proveedor; todo el pipeline usa las variantes por reglas.

Para añadir otro proveedor: implementa `LLMProvider` y regístralo en `ai/providers/index.ts`. Nada más cambia.

## Canales

`integrations/channels/types.ts` define `ChannelAdapter` (`send`, `sendTemplate`, ventana de mensajería). Hay adaptadores para WhatsApp Cloud API, Instagram Messaging y `web` (simulador). Para añadir un canal (por ejemplo Telegram): crea el adaptador, regístralo en `registry.ts`, añade su webhook en `webhooks/` y su formulario de conexión en la pantalla Integraciones.

## Multi-tenant, roles y permisos

- Toda tabla con datos de un entrenador tiene `business_id` y **todas** las consultas filtran por el negocio activo de la sesión (`requireTenant`).
- Roles de negocio: `trainer` (todo) y `team_member` (bandeja, leads, agenda, analítica y Copilot; no puede cambiar la configuración, las integraciones, el equipo ni la facturación, ni borrar leads). Rol de plataforma: `admin` (panel `/admin`). Permisos en `lib/domain.ts → ROLE_PERMISSIONS`.
- Un usuario puede pertenecer a varios negocios (plan Agency) y cambiar entre ellos.
- Los límites de cada plan están en la tabla `plans` (editables desde `/admin`), nunca en el código.

## Seguridad

- Contraseñas con scrypt; comparación en tiempo constante; protección contra enumeración de usuarios (la recuperación de contraseña responde igual y en el mismo tiempo: el email se envía en segundo plano).
- Límite de intentos por cuenta (login, invitaciones, emails de recuperación) además del límite por IP. La IP real solo se toma de proxies de confianza (`TRUST_PROXY`), nunca de un `X-Forwarded-For` cualquiera.
- Los enlaces de recuperación se consumen de forma atómica y todos se invalidan al cambiar o restablecer la contraseña. Los registros de peticiones no guardan tokens de la URL.
- La cuenta de administración solo se crea al arrancar (`ADMIN_EMAIL` + `ADMIN_PASSWORD`), nunca desde el registro público.
- Cookies `HttpOnly`, `SameSite=Lax` y `Secure` con HTTPS; protección CSRF (cabecera `X-Requested-With: kai` obligatoria en peticiones que modifican datos).
- Tokens de integraciones cifrados con AES-256-GCM (`ENCRYPTION_KEY`).
- Firma de webhooks: Meta (`X-Hub-Signature-256`), Calendly (`Calendly-Webhook-Signature`), leads (`X-KAI-Key` o HMAC).
- Límites de peticiones (global y por ruta), cabeceras de seguridad (Helmet + CSP) y campo trampa en formularios públicos, que además tienen un cupo de leads nuevos por negocio y solo escriben por WhatsApp con consentimiento expreso.
- Auditoría de acciones sensibles (cambios de configuración, accesos de admin a conversaciones, acciones de Copilot…).

## Base de datos

Tablas principales: `users`, `sessions`, `businesses`, `memberships`, `invitations`, `plans`, `trainers`, `services`, `ai_settings`, `qualification_rules`, `objections`, `leads`, `lead_memories`, `lead_events`, `conversations`, `messages`, `availability_settings`, `appointments`, `calendar_connections`, `channel_connections`, `automations`, `follow_ups`, `scheduled_jobs`, `copilot_messages`, `pending_actions`, `alerts`, `analytics_daily`, `usage_counters`, `audit_logs`, `error_logs`, `webhook_events`, `password_reset_tokens`.

Cambiar el esquema:

```bash
# 1. Edita backend/src/database/schema.ts
npm run db:generate      # 2. Genera la migración SQL en backend/src/database/migrations
npm run dev              # 3. Se aplica sola al arrancar
```

## Frontend (`frontend/src`)

- React 19 + React Router 7 + TanStack Query 5. Sin librerías de componentes: sistema de diseño propio en `styles/` (tokens de color claro/oscuro, componentes, layout).
- `lib/api.ts`: cliente HTTP (cookie de sesión + cabecera CSRF + negocio activo). `lib/auth.tsx`: sesión y cambio de negocio.
- `@shared` apunta a `backend/src/lib/domain.ts`: etapas, permisos, etiquetas y tipos son los mismos en ambos lados.
- Rutas (`App.tsx`) y nombre de cada pantalla en el menú:

| Ruta | Pantalla (menú) | Archivo |
|---|---|---|
| `/` | Página de inicio | `pages/Landing.tsx` |
| `/login`, `/registro`, `/recuperar`, `/restablecer`, `/invitacion` | Acceso (entrar, crear cuenta, contraseña, invitación) | `pages/auth/` |
| `/app/onboarding` | Configuración inicial en 14 pasos | `pages/Onboarding.tsx` |
| `/app` | Hoy | `pages/Dashboard.tsx` |
| `/app/inbox` | Bandeja (filtros Todos, Nuevos, Calientes, Cualificados, Pendientes, Agendados, No respondieron y Clientes) | `pages/Inbox.tsx` |
| `/app/pipeline`, `/app/leads` | Pipeline y Leads | `pages/Pipeline.tsx`, `pages/Leads.tsx`, `pages/LeadDetail.tsx` |
| `/app/agenda` | Agenda (Semana y Disponibilidad) | `pages/Agenda.tsx` |
| `/app/analitica` | Analítica | `pages/Analytics.tsx` |
| `/app/copilot` | KAI Copilot | `pages/CopilotPage.tsx` |
| `/app/simulador` | Simulador | `pages/Simulator.tsx` |
| `/app/setter` | Setter IA (Personalidad, Cualificación, Puntuación, Servicio y precio, Objeciones, Seguimientos, Escalado y Llamada) | `pages/setter/` |
| `/app/integraciones` | Integraciones (WhatsApp, Instagram y anuncios · Calendario · Formularios y webhooks) | `pages/Integrations.tsx`, `pages/integrations/` |
| `/app/ajustes` | Ajustes (Negocio, Equipo, Plan y uso, Tu cuenta) | `pages/settings/` |
| `/admin` | Administración (Resumen, Negocios, Usuarios, Planes y Registros) | `pages/admin/` |
| `/sin-negocio` | Aviso para una cuenta con sesión que ya no pertenece a ningún negocio (p. ej., la quitaron del equipo) | `pages/NoBusiness.tsx` |
| `/privacidad`, `/terminos` | Textos legales (plantilla) | `pages/Legal.tsx` |

## Pruebas

```bash
npm test
```

Las pruebas usan PGlite en memoria (no necesitan Postgres) y el modo simulado de IA: cubren puntuación, pipeline, disponibilidad, validador, análisis, estrategia y flujos completos de la API (registro, aislamiento entre negocios, conversación hasta la reserva, webhooks firmados, recordatorios, seguimientos, Copilot con confirmación…).
