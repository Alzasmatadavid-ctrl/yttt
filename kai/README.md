# KAI · AI Setter + CRM + Agenda para entrenadores personales

KAI responde a tus leads de Instagram, WhatsApp, anuncios y formularios; los cualifica con preguntas naturales, les propone una llamada y la agenda en tu calendario real. Tú solo entras cuando hace falta: en la llamada de venta o cuando KAI te avisa con **“KAI necesita tu intervención”**.

> KAI **nunca cierra ventas**, nunca inventa horarios, precios ni resultados, nunca da consejos médicos y siempre deja que tomes el control de cualquier conversación.

---

## Qué incluye

| Área | Dónde está en el menú | Qué hace |
|---|---|---|
| **KAI Setter** | Se configura en **Setter IA** | Conversa, entiende, cualifica, agenda y hace seguimiento. Una sola pregunta por mensaje, con tu tono y tus palabras. Revisa cada mensaje antes de enviarlo (control de calidad) y, si no puede responder con seguridad, te pasa la conversación y te avisa en **Avisos** (la campana de arriba). |
| **CRM** | **Pipeline** y **Leads** | Pipeline visual con 12 etapas (arrastrar y soltar), ficha de cada lead con su memoria (“se casa en septiembre”), puntuación interna 0–100 y temperatura. |
| **Bandeja** | **Bandeja** | Todas las conversaciones en un sitio, con los filtros Todos, Nuevos, Calientes, Cualificados, Pendientes, Agendados, No respondieron y Clientes. En **Pendientes** están las que esperan tu respuesta, incluidas las que KAI te ha pasado. Puedes escribir tú, tomar el control y pausar a KAI en cualquier momento. |
| **Agenda** | **Agenda** (pestañas Semana y Disponibilidad) | Agenda propia de KAI, o Google Calendar o Calendly (se conectan en **Integraciones → Calendario**). KAI solo ofrece huecos libres de verdad. Recordatorios automáticos (al reservar, 24 h antes y 1 h antes) y mensajes de no-show. |
| **Seguimientos** | **Setter IA → Seguimientos** | Si el lead deja de responder, KAI le escribe con contexto (nunca “solo hago seguimiento”), respetando horas de descanso. |
| **Panel y analítica** | **Hoy** y **Analítica** | Leads, respuesta, cualificación, llamadas, asistencia, clientes, ingresos y ROI estimado. En Analítica eliges Hoy, 7 días, 30 días o Personalizado (fechas a medida, en los planes con analítica avanzada). |
| **KAI Copilot** | **KAI Copilot** | Pregúntale “¿A quién debería responder ahora?” o “¿Qué leads están más calientes?”, o pídele “Escribe un seguimiento para Marcos”. En modo simulado (sin clave de IA) entiende peticiones parecidas a estas; con la IA real puedes preguntarle con tus propias palabras. Las acciones sensibles siempre te piden confirmación. |
| **Simulador** | **Simulador** | Habla con KAI como si fueras un lead (botón **Nueva prueba**) para ver cómo responde con tu configuración y tu agenda reales. Los mensajes de prueba no se envían a nadie: no salen por WhatsApp ni por Instagram. |
| **Configuración visual** | **Setter IA**, **Integraciones** y **Ajustes** | **Setter IA**: Personalidad, Cualificación, Puntuación, Servicio y precio, Objeciones, Seguimientos, Escalado y Llamada, sin tocar ningún “prompt”. **Integraciones**: WhatsApp, Instagram y anuncios · Calendario · Formularios y webhooks. **Ajustes**: Negocio, Equipo, Plan y uso y Tu cuenta. |
| **SaaS** | **Ajustes → Equipo** y **Ajustes → Plan y uso**; panel **Administración** | Multi-negocio, roles (Admin, Entrenador, Miembro del equipo), planes Starter / Pro / Agency con límites editables, panel de administración (Resumen, Negocios, Usuarios, Planes y Registros) y registro de auditoría. |

---

## Probar KAI en tu ordenador (paso a paso)

No necesitas ninguna clave para probarlo: sin clave de IA funciona en **modo simulado** (respuestas por reglas) y la base de datos se crea sola.

### 1. Instala Node.js

1. Entra en <https://nodejs.org> y descarga la versión **LTS** (22 o superior).
2. Instálala como cualquier programa (siguiente, siguiente…).
3. Para comprobarlo, abre una terminal (en Mac: aplicación **Terminal**; en Windows: **PowerShell**) y escribe:
   ```bash
   node -v
   ```
   Debe aparecer algo como `v22.x.x`.

### 2. Descarga el código

- Con Git: `git clone <url-del-repositorio>`
- Sin Git: en GitHub, botón verde **Code → Download ZIP**, y descomprímelo.

### 3. Abre una terminal dentro de la carpeta `kai`

- Mac: escribe `cd ` (con espacio) y arrastra la carpeta `kai` a la Terminal. Pulsa Enter.
- Windows: abre la carpeta `kai`, haz clic en la barra de direcciones, escribe `powershell` y pulsa Enter.

### 4. Instala las dependencias (solo la primera vez)

```bash
npm install
```

Tarda uno o dos minutos. Es normal que aparezcan avisos (`warn`); solo importa que no termine con `ERR!`.

### 5. Crea tu archivo de configuración

```bash
# Mac / Linux
cp .env.example .env
# Windows (PowerShell)
copy .env.example .env
```

Puedes dejarlo tal cual para probar. Para activar la IA real, abre `.env` con cualquier editor de texto y pega tu clave en `ANTHROPIC_API_KEY=` (ver [docs/INTEGRACIONES.md](docs/INTEGRACIONES.md#1-inteligencia-artificial-claude)).

### 6. (Opcional) Carga los datos de demostración

```bash
npm run db:seed
```

Hazlo **antes de arrancar KAI** (paso 7). Si ya lo tienes arrancado, páralo primero con `Ctrl + C`, ejecuta el comando y vuelve a arrancarlo con `npm run dev`: mientras KAI está en marcha, la base de datos de tu ordenador no se puede usar desde otra terminal (el comando te avisará y no hará nada).

Crea un negocio de ejemplo (“Demo · David Alzas Coach”, método Kaizen) con leads en todas las etapas, conversaciones y citas. Te mostrará el acceso:

- Email: `demo@kai.local`
- Contraseña: `KaiDemo2026`

Los leads de ejemplo no tienen teléfonos ni cuentas reales: nunca se les envía nada.

### 7. Arranca KAI

```bash
npm run dev
```

Cuando veas `ready`, abre <http://localhost:5173> en el navegador. Para pararlo: `Ctrl + C` en la terminal.

### 8. Comprueba que funciona

1. Entra con la cuenta demo o pulsa **Probar KAI** para crear tu cuenta (te guiará una configuración de 14 pasos).
2. En el menú de la izquierda, abre **Simulador**, pulsa **Nueva prueba** y escribe como si fueras un lead: “Hola, quiero perder grasa”.
3. KAI te responderá, irá haciendo preguntas y, cuando tenga información suficiente, te propondrá horarios de llamada reales según tu disponibilidad.

---

## Siguientes pasos

1. **Activa la IA real** → [docs/INTEGRACIONES.md · Claude](docs/INTEGRACIONES.md#1-inteligencia-artificial-claude)
2. **Conecta WhatsApp, Instagram y anuncios** → [docs/INTEGRACIONES.md · Meta](docs/INTEGRACIONES.md#2-meta-whatsapp-instagram-y-lead-ads)
3. **Conecta tu calendario** → [docs/INTEGRACIONES.md · Google Calendar / Calendly](docs/INTEGRACIONES.md#3-google-calendar)
4. **Publícalo en internet** → [docs/DESPLIEGUE.md](docs/DESPLIEGUE.md)
5. **Cómo está construido** → [docs/ARQUITECTURA.md](docs/ARQUITECTURA.md)

---

## Comandos útiles

Todos se ejecutan dentro de la carpeta `kai`.

| Comando | Para qué sirve |
|---|---|
| `npm run dev` | Arranca KAI en modo desarrollo (servidor en el puerto 3000 y web en el 5173). |
| `npm run db:seed` | Crea la cuenta demo. Con `npm run db:seed -- --reset` la borra y la vuelve a crear (con todos sus datos de ejemplo). Ejecútalo con KAI parado (`Ctrl + C`) y vuelve a arrancarlo después con `npm run dev`. |
| `npm run build` | Prepara la versión de producción (web + servidor). |
| `npm start` | Arranca la versión compilada (después de `npm run build`). Para usarla en producción sin Docker, pon en `.env` `NODE_ENV=production` y `SERVE_FRONTEND=true` (ver `.env.example`). |
| `npm test` | Ejecuta las pruebas automáticas. Para un solo archivo: `npm test -- test/unit/scoring.test.ts`. |
| `npm run typecheck` | Comprueba que el código no tiene errores de tipos. |
| `npm run db:migrate` | Aplica cambios de base de datos (el servidor también lo hace solo al arrancar). Si lo ejecutas tú, hazlo con KAI parado (`Ctrl + C`). |

---

## Estructura de carpetas

```
kai/
├── backend/            Servidor (API, IA, CRM, agenda, integraciones, automatizaciones)
│   ├── src/
│   │   ├── ai/             KAI Setter, Copilot, prompts, memoria, control de calidad
│   │   ├── crm/            Leads, pipeline, puntuación, conversaciones, mensajes
│   │   ├── calendar/       Disponibilidad, citas, Google Calendar, Calendly
│   │   ├── integrations/   WhatsApp, Instagram, Lead Ads, email
│   │   ├── webhooks/       Entrada de mensajes y leads
│   │   ├── automation/     Cola de trabajos: recordatorios, seguimientos, no-shows
│   │   ├── analytics/      Métricas y ROI
│   │   ├── auth/           Cuentas, sesiones, roles y permisos
│   │   ├── business/       Creación de negocios (también los adicionales del plan Agency)
│   │   ├── settings/       Configuración del negocio y del setter, onboarding, equipo
│   │   ├── admin/          Panel de administración del SaaS
│   │   ├── plans/          Planes y límites
│   │   ├── audit/          Registro de auditoría y errores
│   │   ├── config/         Variables de entorno y valores por defecto
│   │   ├── lib/            Dominio compartido con la web (etapas, permisos, etiquetas), cifrado y utilidades
│   │   └── database/       Esquema, migraciones y datos demo
│   └── test/           Pruebas automáticas
├── frontend/           Aplicación web (React)
├── docs/               Documentación
├── scripts/            Arranque conjunto de servidor y web en desarrollo (npm run dev)
├── Dockerfile          Imagen para producción
└── docker-compose.yml  KAI + PostgreSQL en tu propio servidor
```

---

## Transparencia, privacidad y seguridad

- **Transparencia (Reglamento Europeo de IA, art. 50).** Por defecto KAI se presenta en su primer mensaje como asistente automatizado del equipo del entrenador. Puedes cambiarlo a “Solo si se lo preguntan” en **Setter IA → Personalidad**, pero si un lead pregunta si habla con un bot, KAI **nunca lo niega**. Recomendación: mantener la presentación en el primer mensaje.
- **Salud.** KAI no diagnostica ni recomienda nada médico: ante lesiones, enfermedades, medicación o embarazo, responde con un mensaje prudente y te pasa la conversación.
- **Bajas.** Si un lead pide que no le escriban más, KAI se despide y no vuelve a escribirle nunca. Si en ese momento la conversación la llevas tú (o el piloto automático está apagado), la baja se registra igualmente y te avisamos. También se puede dar de baja o de alta a un lead a mano.
- **Datos.** Cada negocio solo ve sus datos. Los tokens de integraciones se guardan cifrados. Todas las acciones importantes quedan registradas (auditoría).
- **Protección de datos (RGPD).** Al usar KAI tratas datos personales de tus leads: incluye en tu política de privacidad que usas un asistente automatizado y qué proveedores intervienen (Meta, Anthropic, Google/Calendly, tu hosting).

---

## Problemas frecuentes

| Problema | Solución |
|---|---|
| `npm: command not found` | Node.js no está instalado o hay que cerrar y abrir la terminal tras instalarlo. |
| `EADDRINUSE: address already in use :::3000` | Ya tienes KAI abierto en otra terminal. Ciérralo con `Ctrl + C` o reinicia el ordenador. |
| La web dice que no conecta con el servidor | Mira la terminal: el servidor (`[servidor]`) debe decir `✔ KAI escuchando en el puerto 3000`. Si muestra un error de configuración, revisa tu `.env`. |
| KAI responde de forma muy básica | Estás en modo simulado. Añade `ANTHROPIC_API_KEY` en `.env` y reinicia (`Ctrl + C` y `npm run dev`). |
| No llegan los mensajes de WhatsApp/Instagram | El webhook de Meta necesita una dirección pública (no funciona con `localhost`). Ver [docs/DESPLIEGUE.md](docs/DESPLIEGUE.md). |
| `npm run db:seed` dice `✖ KAI está arrancado y está usando la base de datos de tu ordenador` | Para KAI con `Ctrl + C`, vuelve a ejecutar el comando y arráncalo otra vez con `npm run dev`. |
| La cuenta demo no funciona (“contraseña incorrecta”) o ha desaparecido al reiniciar | Se creó con KAI arrancado y se perdió. Para KAI (`Ctrl + C`), ejecuta `npm run db:seed -- --reset` y vuelve a arrancarlo con `npm run dev`. |
| Quiero empezar de cero en local | Para KAI y borra la carpeta `backend/.data`. Se creará una base de datos nueva al arrancar. |
