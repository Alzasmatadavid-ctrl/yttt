/*
 * Datos de demostración. Uso: npm run db:seed            (crea la cuenta demo si no existe)
 *                              npm run db:seed -- --reset (la borra y la vuelve a crear)
 *
 * Crea una cuenta con un negocio de ejemplo ("Demo · David Alzas Coach", método Kaizen) con leads en
 * todas las etapas, conversaciones, citas, memoria y avisos, para enseñar KAI sin datos reales.
 *
 * Seguridad: los leads demo NO tienen teléfono, WhatsApp ni ID de Instagram reales, así que aunque
 * conectes un canal real a este negocio nunca se enviará un mensaje a una persona de verdad.
 * No crea trabajos programados: nada se envía solo.
 */
import { eq, inArray, sql } from 'drizzle-orm';
import { DateTime } from 'luxon';
import { closeDatabase, getDb, initDatabase } from './client.js';
import { bootstrapData } from './bootstrap.js';
import {
  aiSettings,
  alerts,
  appointments,
  businesses,
  conversations,
  leadEvents,
  leadMemories,
  leads,
  memberships,
  messages,
  plans,
  services,
  trainers,
  users,
} from './schema.js';
import { createBusiness } from '../business/business.service.js';
import { MEDICAL_MESSAGE } from '../ai/setter/setter-engine.js';
import { DEFAULT_QUALIFICATION_RULES } from '../config/defaults.js';
import { env, isProduction } from '../config/env.js';
import { planDemoReset, PUBLIC_DEMO_PASSWORD, seedEnvironmentProblem } from './seed-safety.js';
import { computeScore, temperatureFor } from '../crm/scoring.js';
import { hashPassword } from '../lib/crypto.js';
import type {
  AppointmentOutcome,
  AppointmentStatus,
  ChannelKey,
  ConversationState,
  LeadQualification,
  LeadSignals,
  LeadSource,
  LeadStatus,
} from '../lib/domain.js';
import { DEFAULT_SCORE_BANDS, DEFAULT_TONE } from '../lib/domain.js';

const DEMO_EMAIL = (process.env.DEMO_EMAIL ?? 'demo@kai.local').trim().toLowerCase();
const DEMO_PASSWORD = process.env.DEMO_PASSWORD?.trim() || PUBLIC_DEMO_PASSWORD;
const BUSINESS_NAME = 'Demo · David Alzas Coach';
const TZ = 'Europe/Madrid';
const DEMO_TAG = 'demo';

const reset = process.argv.includes('--reset');
const force = process.argv.includes('--force');

// ───────────────────────── Utilidades de fechas ─────────────────────────

const nowLocal = () => DateTime.now().setZone(TZ);

/** Un día laborable (lun–jue) a `daysOffset` días de hoy, a la hora local indicada. */
function workdayAt(daysOffset: number, hour: number, minute = 0): Date {
  let d = nowLocal().plus({ days: daysOffset }).set({ hour, minute, second: 0, millisecond: 0 });
  const step = daysOffset >= 0 ? 1 : -1;
  while (d.weekday > 4) d = d.plus({ days: step });
  return d.toJSDate();
}

const minutesAfter = (base: Date, minutes: number) => new Date(base.getTime() + minutes * 60_000);

// ───────────────────────── Guion de los leads demo ─────────────────────────

type Who = 'lead' | 'kai' | 'human';

interface DemoLead {
  name: string;
  email?: string;
  instagramUsername?: string;
  source: LeadSource;
  sourceDetail?: string;
  channel: ChannelKey;
  status: LeadStatus;
  /** Hace cuántos días entró el lead (y cuándo empieza la conversación). */
  daysAgo: number;
  startHour?: number;
  qualification?: Record<string, { value: string; level?: string }>;
  signals?: LeadSignals;
  goalSummary?: string;
  /** Conversación: [quién, texto, minutos desde el primer mensaje]. */
  thread: [Who, string, number][];
  memories?: { kind: 'fact' | 'event' | 'preference' | 'constraint' | 'personal'; content: string; importance?: number }[];
  appointment?: { daysOffset: number; hour: number; minute?: number; status: AppointmentStatus; outcome?: AppointmentOutcome; notes?: string };
  dealValueCents?: number;
  lostReason?: string;
  handoff?: { reason: string; title: string; body: string };
  outcomeAlert?: boolean;
  optedOut?: boolean;
  state?: Partial<ConversationState>;
  notes?: string;
}

const DISCLOSURE = 'Soy KAI, el asistente automatizado del equipo de David';

const DEMO_LEADS: DemoLead[] = [
  {
    name: 'Javier Morales',
    instagramUsername: 'javi.morales.demo',
    source: 'instagram',
    sourceDetail: 'Respuesta a historia',
    channel: 'instagram',
    status: 'new',
    daysAgo: 0,
    startHour: 9,
    thread: [['lead', 'Buenas! Vi tu reel de los errores al perder grasa y me sentí muy identificado', 0]],
  },
  {
    name: 'Rubén Ortega',
    email: 'ruben.ortega@example.com',
    source: 'landing',
    sourceDetail: 'Formulario web Kaizen',
    channel: 'whatsapp',
    status: 'contacted',
    daysAgo: 1,
    qualification: { goal: { value: 'Perder unos 8 kg de grasa' } },
    goalSummary: 'Perder unos 8 kg de grasa',
    thread: [
      [
        'kai',
        `¡Hola Rubén! ${DISCLOSURE}. Vi que dejaste tus datos en la web porque quieres perder unos 8 kg de grasa. ¿Qué es lo que más te está costando ahora mismo para conseguirlo?`,
        2,
      ],
    ],
  },
  {
    name: 'Álvaro Santos',
    instagramUsername: 'alvaro.santos.demo',
    source: 'instagram',
    channel: 'instagram',
    status: 'conversing',
    daysAgo: 2,
    qualification: {
      goal: { value: 'Quitarse la barriga y ganar algo de músculo' },
      current_situation: { value: 'Trabaja en oficina, entrena 2 días por semana sin plan' },
    },
    goalSummary: 'Quitarse la barriga y ganar algo de músculo',
    thread: [
      ['lead', 'Hola, quería info sobre tus asesorías', 0],
      ['kai', `¡Hola Álvaro! ${DISCLOSURE}. Encantado de ayudarte. ¿Qué objetivo te gustaría conseguir?`, 1],
      ['lead', 'Pues sobre todo quitarme la barriga y ganar algo de músculo', 9],
      ['kai', 'Tiene todo el sentido, es de lo más habitual en los chicos que trabajamos. ¿Cómo es ahora mismo tu semana con el entrenamiento?', 10],
      ['lead', 'Trabajo en oficina y voy al gym 2 días pero sin plan, hago un poco de todo', 26],
    ],
    memories: [{ kind: 'fact', content: 'Trabaja en oficina muchas horas sentado.' }],
  },
  {
    name: 'Daniel Pérez',
    email: 'daniel.perez@example.com',
    source: 'meta_ads',
    sourceDetail: 'Campaña Kaizen · Lead Ads',
    channel: 'whatsapp',
    status: 'interested',
    daysAgo: 4,
    qualification: {
      goal: { value: 'Perder grasa abdominal' },
      current_situation: { value: 'Padre de dos hijos, poco tiempo, come fuera a menudo' },
      problem: { value: 'Empieza con fuerza y lo deja a las 3 semanas' },
      motivation: { value: 'Quiere tener energía para jugar con sus hijos' },
    },
    signals: { urgency: 'medium', commitment: 'medium', sentiment: 'positive' },
    goalSummary: 'Perder grasa abdominal y ganar energía',
    thread: [
      ['kai', `¡Hola Daniel! ${DISCLOSURE}. Vi que te interesa perder grasa abdominal. ¿Qué te ha hecho dar el paso ahora?`, 0],
      ['lead', 'Pues que tengo dos peques y llego reventado a casa, quiero tener energía para jugar con ellos', 35],
      ['kai', 'Qué buen motivo. Con dos peques el tiempo es oro, así que lo que hagamos tiene que encajar en tu día a día. ¿Qué te ha pasado otras veces cuando lo has intentado?', 36],
      ['lead', 'Empiezo con muchas ganas y a las 3 semanas lo dejo. Además como fuera bastante por trabajo', 80],
    ],
    memories: [
      { kind: 'personal', content: 'Tiene dos hijos pequeños.', importance: 3 },
      { kind: 'constraint', content: 'Come fuera a menudo por trabajo.' },
    ],
  },
  {
    name: 'Sergio Navarro',
    instagramUsername: 'sergio.nav.demo',
    source: 'instagram',
    channel: 'instagram',
    status: 'qualified',
    daysAgo: 5,
    qualification: {
      goal: { value: 'Bajar del 25% de grasa corporal' },
      current_situation: { value: 'Sedentario, 34 años, trabaja desde casa' },
      problem: { value: 'Picotea por la noche y no tiene estructura' },
      motivation: { value: 'Se ve mal en las fotos y quiere recuperar la confianza' },
      previous_attempts: { value: 'Probó ayuno intermitente y una app de dietas' },
      urgency: { value: 'Quiere empezar este mes', level: 'high' },
      commitment: { value: 'Dispuesto a entrenar 3 días por semana', level: 'high' },
    },
    signals: { urgency: 'high', commitment: 'high', intent: 'high', sentiment: 'positive' },
    goalSummary: 'Bajar del 25% de grasa y recuperar la confianza',
    thread: [
      ['lead', 'Hola! Me interesa el método Kaizen', 0],
      ['kai', `¡Hola Sergio! ${DISCLOSURE}. Me alegra que te interese. ¿Qué te gustaría conseguir?`, 1],
      ['lead', 'Bajar del 25% de grasa, ahora mismo me veo fatal en las fotos', 12],
      ['kai', 'Te entiendo, verse así en las fotos pesa más de lo que parece. ¿Has probado algo antes para conseguirlo?', 13],
      ['lead', 'Ayuno intermitente y una app de dietas, pero por la noche acabo picoteando siempre', 30],
      ['kai', 'Es muy normal: cuando todo depende de la fuerza de voluntad, la noche es el punto débil. ¿Cuánto tiempo a la semana podrías dedicar a entrenar?', 31],
      ['lead', '3 días seguro, y quiero empezar este mes sí o sí', 52],
    ],
    memories: [{ kind: 'preference', content: 'Prefiere entrenar por la mañana antes de trabajar.' }],
  },
  {
    name: 'Marcos Gil',
    email: 'marcos.gil@example.com',
    source: 'landing',
    sourceDetail: 'Formulario web Kaizen',
    channel: 'whatsapp',
    status: 'call_proposed',
    daysAgo: 3,
    qualification: {
      goal: { value: 'Perder 10 kg antes de su boda' },
      current_situation: { value: 'Juega al pádel 1 vez por semana' },
      problem: { value: 'No sabe organizar la alimentación' },
      motivation: { value: 'Se casa en septiembre y quiere verse bien' },
      urgency: { value: 'Fecha fija: boda en septiembre', level: 'high' },
      commitment: { value: 'Muy comprometido', level: 'high' },
      budget: { value: 'Puede invertir en un programa', level: 'yes' },
    },
    signals: { urgency: 'high', commitment: 'high', budget: 'yes', intent: 'high', sentiment: 'positive' },
    goalSummary: 'Perder 10 kg antes de su boda en septiembre',
    thread: [
      ['kai', `¡Hola Marcos! ${DISCLOSURE}. Vi en el formulario que quieres perder unos 10 kg. ¿Hay alguna fecha que te motive especialmente?`, 0],
      ['lead', 'Sí! Me caso en septiembre y quiero llegar bien', 20],
      ['kai', '¡Enhorabuena por la boda! Es una meta muy bonita para trabajar con calma y sin extremos. ¿Qué es lo que más te cuesta ahora mismo?', 21],
      ['lead', 'Organizar las comidas, nunca sé qué comer', 45],
      [
        'kai',
        'Con lo que me cuentas, lo mejor es que lo veáis con David en una llamada de valoración de 30 minutos, sin compromiso: revisa tu caso y te dice cómo lo plantearía. ¿Te encaja que te proponga un par de horarios?',
        46,
      ],
    ],
    memories: [{ kind: 'event', content: 'Se casa en septiembre.', importance: 3 }],
  },
  {
    name: 'Iván Romero',
    instagramUsername: 'ivan.romero.demo',
    source: 'instagram',
    channel: 'instagram',
    status: 'call_booked',
    daysAgo: 3,
    qualification: {
      goal: { value: 'Definir y perder grasa del abdomen' },
      current_situation: { value: 'Entrena en casa 4 días' },
      problem: { value: 'Lleva meses estancado' },
      motivation: { value: 'Quiere sentirse cómodo en verano' },
      previous_attempts: { value: 'Rutinas de YouTube' },
      urgency: { value: 'Quiere resultados este trimestre', level: 'medium' },
      commitment: { value: 'Alto', level: 'high' },
      budget: { value: 'Sí', level: 'yes' },
    },
    signals: { urgency: 'medium', commitment: 'high', budget: 'yes', intent: 'high', sentiment: 'positive' },
    goalSummary: 'Salir del estancamiento y perder grasa abdominal',
    thread: [
      ['lead', 'Hola, llevo meses estancado entrenando en casa', 0],
      ['kai', `¡Hola Iván! ${DISCLOSURE}. Estancarse después de meses de esfuerzo frustra mucho. ¿Qué rutina estás siguiendo ahora?`, 1],
      ['lead', 'Rutinas de YouTube, 4 días por semana', 15],
      ['kai', 'Lo bueno es que ya tienes el hábito, que es lo más difícil. ¿Te gustaría verlo con David en una llamada de valoración de 30 minutos?', 16],
      ['lead', 'Sí, perfecto', 25],
      ['kai', 'Genial. Tengo disponible el martes a las 10:00 o a las 17:30. ¿Cuál te viene mejor?', 26],
      ['lead', 'La de las 17:30', 40],
      ['kai', '¡Hecho! Te he reservado la llamada. Te escribiré un recordatorio antes. ¡Hablamos pronto!', 41],
    ],
    appointment: { daysOffset: 2, hour: 17, minute: 30, status: 'scheduled' },
    state: { callAccepted: true },
  },
  {
    name: 'Pablo Herrera',
    email: 'pablo.herrera@example.com',
    source: 'meta_ads',
    sourceDetail: 'Campaña Kaizen · Lead Ads',
    channel: 'whatsapp',
    status: 'reminder_sent',
    daysAgo: 6,
    qualification: {
      goal: { value: 'Perder 6 kg' },
      problem: { value: 'Horarios de trabajo a turnos' },
      motivation: { value: 'Su médico le recomendó bajar peso' },
      urgency: { value: 'Alta', level: 'high' },
      commitment: { value: 'Alto', level: 'high' },
      budget: { value: 'Quiere saber el precio en la llamada', level: 'maybe' },
    },
    signals: { urgency: 'high', commitment: 'high', budget: 'maybe', intent: 'high' },
    goalSummary: 'Perder 6 kg con horarios a turnos',
    thread: [
      ['kai', `¡Hola Pablo! ${DISCLOSURE}. Vi tu solicitud sobre el método Kaizen. ¿Qué te gustaría conseguir?`, 0],
      ['lead', 'Perder unos 6 kilos, trabajo a turnos y me cuesta mucho', 60],
      ['kai', 'Los turnos complican mucho la rutina, pero se puede organizar. ¿Te parece si lo veis en una llamada de valoración con David?', 61],
      ['lead', 'Vale', 90],
      ['kai', '¡Perfecto! Te he reservado la llamada para mañana a las 10:00. Te llegará un recordatorio antes.', 92],
      ['kai', 'Hola Pablo, te recuerdo que mañana a las 10:00 tienes tu llamada de valoración con David. Si necesitas cambiarla, dímelo por aquí.', 1440],
    ],
    appointment: { daysOffset: 1, hour: 10, status: 'scheduled' },
    state: { callAccepted: true },
  },
  {
    name: 'Adrián Castro',
    instagramUsername: 'adrian.castro.demo',
    source: 'instagram',
    channel: 'instagram',
    status: 'no_show',
    daysAgo: 9,
    qualification: {
      goal: { value: 'Perder grasa y ganar fuerza' },
      motivation: { value: 'Quiere mejorar su autoestima' },
      urgency: { value: 'Media', level: 'medium' },
      commitment: { value: 'Medio', level: 'medium' },
    },
    signals: { urgency: 'medium', commitment: 'medium' },
    goalSummary: 'Perder grasa y ganar fuerza',
    thread: [
      ['lead', 'Info del programa porfa', 0],
      ['kai', `¡Hola Adrián! ${DISCLOSURE}. Claro. ¿Qué objetivo tienes ahora mismo?`, 1],
      ['lead', 'Perder grasa y ganar fuerza, quiero sentirme mejor conmigo mismo', 30],
      ['kai', 'Perfecto, lo vemos con calma en una llamada con David. Te he reservado el jueves a las 18:00.', 31],
      ['kai', 'Hola Adrián, te estuvimos esperando en la llamada. Si te surgió algo, sin problema: ¿quieres que busquemos otro hueco?', 4400],
    ],
    appointment: { daysOffset: -4, hour: 18, status: 'no_show' },
  },
  {
    name: 'Luis Domínguez',
    email: 'luis.dominguez@example.com',
    source: 'webhook',
    sourceDetail: 'Formulario de Typeform',
    channel: 'whatsapp',
    status: 'follow_up',
    daysAgo: 12,
    qualification: {
      goal: { value: 'Perder 12 kg' },
      problem: { value: 'Ansiedad por la comida' },
      motivation: { value: 'Salud' },
      urgency: { value: 'Baja', level: 'low' },
      commitment: { value: 'Medio', level: 'medium' },
      budget: { value: 'Lo tiene que hablar con su pareja', level: 'maybe' },
    },
    signals: { urgency: 'low', commitment: 'medium', budget: 'maybe' },
    goalSummary: 'Perder 12 kg y controlar la ansiedad por la comida',
    thread: [
      ['kai', `¡Hola Luis! ${DISCLOSURE}. Vi que quieres perder unos 12 kg. ¿Qué es lo que más te frena ahora?`, 0],
      ['lead', 'La ansiedad por la comida, sobre todo cuando estoy estresado', 120],
      ['kai', 'Gracias por contarlo, es más común de lo que parece y se trabaja poco a poco. ¿Te gustaría verlo con David en una llamada?', 121],
      ['lead', 'Me lo tengo que pensar y hablar con mi pareja', 300],
      ['kai', 'Claro, tiene todo el sentido decidirlo juntos. La llamada no te compromete a nada y te puede ayudar a tener las cosas claras para hablarlo. ¿Te escribo la semana que viene?', 301],
      ['lead', 'Sí, mejor', 330],
    ],
    appointment: { daysOffset: -5, hour: 10, status: 'completed', outcome: 'follow_up', notes: 'Lo habla con su pareja. Retomar la semana que viene.' },
    notes: 'Retomar el contacto la semana que viene.',
  },
  {
    name: 'Carlos Ruiz',
    instagramUsername: 'carlos.ruiz.demo',
    source: 'instagram',
    channel: 'instagram',
    status: 'client',
    daysAgo: 20,
    qualification: {
      goal: { value: 'Perder grasa y mantenerlo' },
      current_situation: { value: 'Ha perdido peso otras veces pero lo recupera' },
      problem: { value: 'Efecto rebote' },
      motivation: { value: 'Quiere un sistema sostenible' },
      urgency: { value: 'Alta', level: 'high' },
      commitment: { value: 'Alto', level: 'high' },
      budget: { value: 'Sí', level: 'yes' },
      fit: { value: 'Encaja con Kaizen', level: 'yes' },
    },
    signals: { urgency: 'high', commitment: 'high', budget: 'yes', fit: 'yes', intent: 'high', sentiment: 'positive' },
    goalSummary: 'Perder grasa sin efecto rebote',
    thread: [
      ['lead', 'Hola! Siempre que adelgazo luego lo recupero todo', 0],
      ['kai', `¡Hola Carlos! ${DISCLOSURE}. El efecto rebote es justo lo que Kaizen intenta evitar con cambios progresivos. ¿Qué has probado hasta ahora?`, 1],
      ['lead', 'Dietas muy estrictas, las típicas', 20],
      ['kai', 'Tiene sentido que no aguantaran: cuanto más extremo, más difícil mantenerlo. ¿Te parece si lo vemos en una llamada de valoración con David?', 21],
      ['lead', 'Venga', 25],
      ['kai', '¡Genial! Te he reservado la llamada. ¡Hablamos pronto!', 27],
      ['human', '¡Bienvenido a Kaizen, Carlos! Te acabo de enviar el acceso a la app. Cualquier duda me dices.', 5800],
    ],
    appointment: { daysOffset: -16, hour: 17, status: 'completed', outcome: 'won', notes: 'Se une al programa de 12 semanas.' },
    dealValueCents: 44700,
  },
  {
    name: 'Jorge Molina',
    email: 'jorge.molina@example.com',
    source: 'landing',
    channel: 'whatsapp',
    status: 'client',
    daysAgo: 26,
    qualification: {
      goal: { value: 'Perder 7 kg' },
      motivation: { value: 'Mejorar su salud' },
      urgency: { value: 'Alta', level: 'high' },
      commitment: { value: 'Alto', level: 'high' },
      budget: { value: 'Sí', level: 'yes' },
      fit: { value: 'Sí', level: 'yes' },
    },
    signals: { urgency: 'high', commitment: 'high', budget: 'yes', fit: 'yes' },
    goalSummary: 'Perder 7 kg y mejorar su salud',
    thread: [
      ['kai', `¡Hola Jorge! ${DISCLOSURE}. Vi que quieres perder unos 7 kg. ¿Qué te ha hecho dar el paso ahora?`, 0],
      ['lead', 'Mi salud, quiero cuidarme de verdad', 40],
      ['kai', 'Es la mejor razón. ¿Te parece si lo vemos en una llamada de valoración con David?', 41],
      ['lead', 'Sí', 50],
      ['kai', '¡Genial! Te he reservado la llamada. Te escribiré un recordatorio antes.', 51],
      ['human', '¡Bienvenido a Kaizen, Jorge! Ya tienes acceso a tu plan. Vamos paso a paso.', 4400],
    ],
    appointment: { daysOffset: -22, hour: 10, status: 'completed', outcome: 'won' },
    dealValueCents: 44700,
  },
  {
    name: 'Miguel Torres',
    instagramUsername: 'miguel.torres.demo',
    source: 'instagram',
    channel: 'instagram',
    status: 'lost',
    daysAgo: 15,
    qualification: {
      goal: { value: 'Ganar masa muscular' },
      budget: { value: 'No puede invertir ahora', level: 'no' },
      fit: { value: 'Busca volumen, no pérdida de grasa', level: 'no' },
    },
    signals: { budget: 'no', fit: 'no', sentiment: 'neutral' },
    goalSummary: 'Ganar masa muscular (no encaja con Kaizen)',
    thread: [
      ['lead', 'Hola, quiero ganar volumen', 0],
      ['kai', `¡Hola Miguel! ${DISCLOSURE}. Gracias por escribir. ¿Ahora mismo tu objetivo principal es ganar músculo, no perder grasa?`, 1],
      ['lead', 'Sí, estoy muy delgado y además ahora no puedo gastar dinero', 30],
      [
        'kai',
        'Gracias por ser tan claro. El programa de David está centrado en pérdida de grasa, así que ahora mismo no sería lo más adecuado para ti. Te deseo mucho éxito con tu objetivo, ¡mucho ánimo!',
        31,
      ],
    ],
    lostReason: 'No encaja: busca ganar volumen y no tiene presupuesto.',
  },
  {
    name: 'Andrés Vidal',
    email: 'andres.vidal@example.com',
    source: 'meta_ads',
    sourceDetail: 'Campaña Kaizen · Lead Ads',
    channel: 'whatsapp',
    status: 'conversing',
    daysAgo: 1,
    qualification: { goal: { value: 'Perder grasa' } },
    goalSummary: 'Perder grasa',
    thread: [
      ['kai', `¡Hola Andrés! ${DISCLOSURE}. Vi que te interesa perder grasa. ¿Qué te gustaría conseguir en los próximos meses?`, 0],
      ['lead', 'Perder grasa, pero tengo una lesión de rodilla. ¿Qué ejercicios puedo hacer?', 25],
      ['kai', MEDICAL_MESSAGE, 26],
    ],
    handoff: {
      reason: 'medical',
      title: 'KAI necesita tu intervención',
      body: 'Andrés Vidal menciona una lesión de rodilla. Último mensaje: “Perder grasa, pero tengo una lesión de rodilla. ¿Qué ejercicios puedo hacer?”',
    },
    state: { medicalFlag: true },
  },
  {
    name: 'Raúl Iglesias',
    instagramUsername: 'raul.iglesias.demo',
    source: 'instagram',
    channel: 'instagram',
    status: 'call_booked',
    daysAgo: 7,
    qualification: {
      goal: { value: 'Perder 5 kg y marcar abdomen' },
      motivation: { value: 'Quiere verse bien' },
      urgency: { value: 'Media', level: 'medium' },
      commitment: { value: 'Alto', level: 'high' },
      budget: { value: 'Sí', level: 'yes' },
    },
    signals: { urgency: 'medium', commitment: 'high', budget: 'yes' },
    goalSummary: 'Perder 5 kg y marcar abdomen',
    thread: [
      ['lead', 'Hola! Quería saber cómo funciona', 0],
      ['kai', `¡Hola Raúl! ${DISCLOSURE}. Te cuento encantado. ¿Qué objetivo tienes?`, 1],
      ['lead', 'Perder 5 kilos y marcar abdomen', 14],
      ['kai', '¡Genial! Lo mejor es verlo en una llamada de valoración con David. Te he reservado la llamada.', 15],
    ],
    appointment: { daysOffset: -1, hour: 10, minute: 30, status: 'scheduled' },
    outcomeAlert: true,
  },
];

// ───────────────────────── Script ─────────────────────────

const SCORING_RULES = DEFAULT_QUALIFICATION_RULES.map((r) => ({ key: r.key, weight: r.weight, enabled: true, required: r.required }));

/** Borra la cuenta demo anterior, solo si de verdad es la demo (ver planDemoReset). */
async function removeExistingDemo(): Promise<boolean> {
  const db = getDb();
  const [user] = await db.select().from(users).where(eq(users.email, DEMO_EMAIL)).limit(1);
  if (!user) return false;
  const rows = await db
    .select({
      businessId: memberships.businessId,
      businessName: businesses.name,
      role: memberships.role,
      memberCount: sql<number>`(select count(*)::int from ${memberships} m2 where m2.business_id = ${memberships.businessId})`,
    })
    .from(memberships)
    .innerJoin(businesses, eq(businesses.id, memberships.businessId))
    .where(eq(memberships.userId, user.id));
  const plan = planDemoReset(user, rows.map((r) => ({ ...r, memberCount: Number(r.memberCount) })), BUSINESS_NAME);
  if (!plan.ok) throw new Error(plan.reason);
  if (plan.businessIds.length) await db.delete(businesses).where(inArray(businesses.id, plan.businessIds));
  await db.delete(users).where(eq(users.id, user.id));
  return true;
}

async function seed() {
  const problem = seedEnvironmentProblem({
    production: isProduction(),
    force,
    demoEmail: DEMO_EMAIL,
    demoPassword: process.env.DEMO_PASSWORD,
    adminEmail: env.ADMIN_EMAIL,
  });
  if (problem) {
    console.error(`✖ ${problem}`);
    process.exitCode = 1;
    return;
  }
  await initDatabase();
  await bootstrapData();
  const db = getDb();

  const [existing] = await db.select().from(users).where(eq(users.email, DEMO_EMAIL)).limit(1);
  if (existing && !reset) {
    console.log(`ℹ La cuenta demo ya existe (${DEMO_EMAIL}). Usa "npm run db:seed -- --reset" para recrearla.`);
    return;
  }
  if (existing) {
    await removeExistingDemo();
    console.log('↺ Cuenta demo anterior eliminada.');
  }

  const [user] = await db
    .insert(users)
    .values({ email: DEMO_EMAIL, name: 'David Alzas', passwordHash: await hashPassword(DEMO_PASSWORD) })
    .returning();

  const business = await createBusiness({ name: BUSINESS_NAME, ownerUserId: user.id, ownerName: 'David Alzas', timezone: TZ, planKey: 'pro' });
  const [proPlan] = await db.select().from(plans).where(eq(plans.key, 'pro')).limit(1);
  await db
    .update(businesses)
    .set({ planId: proPlan?.id ?? business.planId, onboardingStep: 14, onboardingCompletedAt: new Date(), monthlyAdSpendCents: 30000 })
    .where(eq(businesses.id, business.id));

  await db
    .update(trainers)
    .set({
      displayName: 'David Alzas',
      specialty: 'Pérdida de grasa para hombres de 25 a 45 años',
      idealClient:
        'Hombres de 25 a 45 años, con trabajo y poco tiempo, que quieren perder grasa y mejorar su físico pero les cuesta mantener la constancia y organizar entrenamiento y alimentación.',
      transformation: 'Perder grasa, mejorar el físico y sentirse más seguro con un estilo de vida que puedan mantener.',
      methodName: 'Kaizen',
      methodDescription:
        'Método de pérdida de grasa basado en mejoras progresivas, consistentes y sostenibles en entrenamiento, alimentación y hábitos, sin soluciones extremas ni cambios imposibles de mantener.',
      modality: 'online',
      credentials: '',
    })
    .where(eq(trainers.businessId, business.id));

  await db.insert(services).values({
    businessId: business.id,
    name: 'Programa Kaizen · 12 semanas',
    // La descripción la lee la IA (y podría repetírsela a un lead): nada de notas internas aquí.
    description: 'Acompañamiento online de pérdida de grasa con el método Kaizen.',
    priceCents: 14900,
    currency: 'EUR',
    billingPeriod: 'monthly',
    durationWeeks: 12,
    includes: ['Plan de entrenamiento adaptado a tu agenda', 'Pautas de alimentación flexibles', 'Revisión semanal del progreso', 'Soporte por WhatsApp'],
    isPrimary: true,
  });

  await db
    .update(aiSettings)
    .set({
      assistantName: 'KAI',
      persona: 'team_member',
      tone: { ...DEFAULT_TONE },
      wordsToUse: ['progresivo', 'sostenible', 'paso a paso'],
      wordsToAvoid: ['dieta milagro', 'garantizado', 'sin esfuerzo'],
      callLabel: 'llamada de valoración',
      callDurationMinutes: 30,
      callDescription: 'Llamada de 30 minutos con David para revisar tu caso y ver si Kaizen encaja contigo. Sin compromiso.',
      scoreBands: DEFAULT_SCORE_BANDS,
    })
    .where(eq(aiSettings.businessId, business.id));

  let created = 0;
  for (const spec of DEMO_LEADS) {
    await createDemoLead(business.id, user.id, spec);
    created++;
  }

  console.log('');
  console.log('✔ Datos de demostración creados.');
  console.log(`  Negocio: ${BUSINESS_NAME} (${created} leads de ejemplo)`);
  console.log(`  Email:      ${DEMO_EMAIL}`);
  console.log(`  Contraseña: ${DEMO_PASSWORD}`);
  console.log('  Los leads demo no tienen teléfono ni cuentas reales: nunca se les enviará nada.');
  console.log('  El precio del servicio demo es de ejemplo: cámbialo en Setter IA → Servicio y precio.');
}

async function createDemoLead(businessId: string, userId: string, spec: DemoLead) {
  const db = getDb();
  const start = workdayAt(-spec.daysAgo, spec.startHour ?? 11, 0);
  const startDate = start.getTime() > Date.now() ? minutesAfter(new Date(), -90) : start;
  const at = (m: number) => {
    const d = minutesAfter(startDate, m);
    return d.getTime() > Date.now() ? minutesAfter(new Date(), -1) : d;
  };

  const qualification: LeadQualification = {};
  for (const [key, item] of Object.entries(spec.qualification ?? {})) {
    qualification[key] = { value: item.value, confidence: 0.85, updatedAt: startDate.toISOString(), ...(item.level ? { level: item.level as never } : {}) };
  }
  const signals = spec.signals ?? {};
  const { score } = computeScore(SCORING_RULES, qualification, signals);
  const temperature = temperatureFor(score, DEFAULT_SCORE_BANDS);

  const inbound = spec.thread.filter(([who]) => who === 'lead');
  const outbound = spec.thread.filter(([who]) => who !== 'lead');
  const firstIn = inbound[0];
  const firstOutAfterIn = firstIn ? outbound.find(([, , m]) => m >= firstIn[2]) : undefined;
  const lastInboundAt = inbound.length ? at(inbound[inbound.length - 1][2]) : null;
  const lastOutboundAt = outbound.length ? at(outbound[outbound.length - 1][2]) : null;
  const lastMinute = spec.thread.length ? spec.thread[spec.thread.length - 1][2] : 0;
  const reachedQualified = ['qualified', 'call_proposed', 'call_booked', 'reminder_sent', 'no_show', 'follow_up', 'client'].includes(spec.status);
  const isWon = spec.status === 'client';
  const isLost = spec.status === 'lost';

  const [lead] = await db
    .insert(leads)
    .values({
      businessId,
      name: spec.name,
      email: spec.email ?? null,
      instagramUsername: spec.instagramUsername ?? null,
      source: spec.source,
      sourceDetail: spec.sourceDetail ?? null,
      status: spec.status,
      score,
      temperature,
      qualification,
      signals,
      goalSummary: spec.goalSummary ?? null,
      tags: [DEMO_TAG],
      notes: spec.notes ?? '',
      optedOut: spec.optedOut ?? false,
      lastInboundAt,
      lastOutboundAt,
      lastInteractionAt: at(lastMinute),
      firstResponseSeconds: firstIn && firstOutAfterIn ? Math.max(30, (firstOutAfterIn[2] - firstIn[2]) * 60) : null,
      qualifiedAt: reachedQualified ? at(Math.min(lastMinute, 60)) : null,
      wonAt: isWon ? workdayAt(spec.appointment?.daysOffset ?? -1, 19) : null,
      lostAt: isLost ? at(lastMinute) : null,
      lostReason: spec.lostReason ?? null,
      dealValueCents: spec.dealValueCents ?? null,
      createdAt: startDate,
      updatedAt: at(lastMinute),
    })
    .returning();

  await db.insert(leadEvents).values({
    businessId,
    leadId: lead.id,
    type: 'created',
    actorType: spec.source === 'manual' ? 'human' : 'integration',
    data: { source: spec.source },
    createdAt: startDate,
  });
  if (spec.status !== 'new') {
    await db.insert(leadEvents).values({
      businessId,
      leadId: lead.id,
      type: 'status_changed',
      actorType: isWon || isLost ? 'human' : 'kai',
      actorUserId: isWon || isLost ? userId : null,
      data: { from: 'new', to: spec.status },
      createdAt: at(lastMinute),
    });
  }

  const state: ConversationState = { ...(spec.state ?? {}) } as ConversationState;
  if (spec.status === 'call_proposed') state.callProposedAt = at(lastMinute).toISOString();
  const lastMsg = spec.thread[spec.thread.length - 1];
  const [conversation] = await db
    .insert(conversations)
    .values({
      businessId,
      leadId: lead.id,
      channel: spec.channel,
      status: isWon || isLost ? 'closed' : 'open',
      aiEnabled: !spec.handoff && !isWon,
      handoffActive: Boolean(spec.handoff),
      handoffReason: spec.handoff?.reason ?? null,
      handoffAt: spec.handoff ? at(lastMinute) : null,
      unreadCount: lastMsg && lastMsg[0] === 'lead' ? 1 : 0,
      lastMessageAt: lastMsg ? at(lastMsg[2]) : null,
      lastMessagePreview: lastMsg ? lastMsg[1].slice(0, 140) : null,
      lastInboundAt,
      state,
      createdAt: startDate,
    })
    .returning();

  if (spec.thread.length) {
    await db.insert(messages).values(
      spec.thread.map(([who, text, minute]) => ({
        businessId,
        conversationId: conversation.id,
        leadId: lead.id,
        direction: who === 'lead' ? ('inbound' as const) : ('outbound' as const),
        senderType: who,
        senderUserId: who === 'human' ? userId : null,
        content: text,
        status: who === 'lead' ? ('received' as const) : ('sent' as const),
        metadata: { demo: true },
        createdAt: at(minute),
      })),
    );
  }

  if (spec.memories?.length) {
    await db.insert(leadMemories).values(
      spec.memories.map((m) => ({ businessId, leadId: lead.id, kind: m.kind, content: m.content, importance: m.importance ?? 2, createdAt: startDate })),
    );
  }

  if (spec.appointment) {
    const a = spec.appointment;
    const startsAt = workdayAt(a.daysOffset, a.hour, a.minute ?? 0);
    const [appt] = await db
      .insert(appointments)
      .values({
        businessId,
        leadId: lead.id,
        conversationId: conversation.id,
        title: `Llamada de valoración · ${spec.name}`,
        startsAt,
        endsAt: minutesAfter(startsAt, 30),
        status: a.status,
        outcome: a.outcome ?? null,
        outcomeNotes: a.notes ?? null,
        calendarProvider: 'internal',
        bookedBy: 'kai',
        confirmationSentAt: minutesAfter(startDate, 30),
        reminder24hSentAt: spec.status === 'reminder_sent' ? minutesAfter(new Date(), -60) : null,
        createdAt: startDate,
      })
      .returning();
    await db.insert(leadEvents).values({
      businessId,
      leadId: lead.id,
      type: 'call_booked',
      actorType: 'kai',
      data: { appointmentId: appt.id, startsAt: startsAt.toISOString() },
      createdAt: startDate,
    });
    if (spec.outcomeAlert) {
      await db.insert(alerts).values({
        businessId,
        type: 'call_outcome',
        severity: 'info',
        title: '¿Cómo fue la llamada?',
        body: `Registra el resultado de la llamada con ${spec.name} para que KAI sepa cómo seguir.`,
        leadId: lead.id,
        conversationId: conversation.id,
        appointmentId: appt.id,
      });
    }
  }

  if (spec.handoff) {
    await db.insert(alerts).values({
      businessId,
      type: 'handoff',
      severity: 'critical',
      title: spec.handoff.title,
      body: spec.handoff.body,
      leadId: lead.id,
      conversationId: conversation.id,
    });
    await db.insert(leadEvents).values({
      businessId,
      leadId: lead.id,
      type: 'handoff',
      actorType: 'kai',
      data: { reason: spec.handoff.reason, detail: spec.handoff.body },
      createdAt: at(lastMinute),
    });
  }
}

try {
  await seed();
} catch (err) {
  console.error('✖ No se pudieron crear los datos demo:', err);
  process.exitCode = 1;
} finally {
  await closeDatabase().catch(() => undefined);
}
