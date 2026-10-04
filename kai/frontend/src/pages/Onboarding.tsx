/* Onboarding del entrenador: 14 pasos para que KAI conozca el negocio y empiece a trabajar. */
import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  ArrowRight,
  Banknote,
  Building2,
  CalendarCheck,
  CalendarClock,
  CalendarDays,
  ClipboardList,
  Copy,
  Dumbbell,
  ExternalLink,
  FlaskConical,
  LayoutDashboard,
  Laptop,
  ListChecks,
  LogOut,
  Megaphone,
  MessageCircleQuestion,
  MessageSquareText,
  MonitorSmartphone,
  Package,
  PartyPopper,
  Plug,
  Plus,
  RefreshCw,
  Shuffle,
  Sparkles,
  Target,
  Trash2,
  UserRound,
  UsersRound,
  type LucideIcon,
} from 'lucide-react';
import { BILLING_PERIOD_LABELS, DEFAULT_TONE, ONE_QUESTION_MESSAGE, WEEKDAY_LABELS, formatMoney, hasSeveralQuestions, type AiTone, type AvailabilityWeek, type TimeRange } from '@shared';
import { api, ApiError, errorText } from '../lib/api';
import { useAuth } from '../lib/auth';
import { parseEurosToCents } from '../lib/format';
import { Logo } from '../components/brand';
import { InstagramIcon, WhatsAppIcon } from '../components/lead-bits';
import { Button, Callout, Card, Field, Input, PageLoading, Segmented, Select, Spinner, Switch, TagInput, Textarea, useToast } from '../components/ui';
import type { AiSettings, CalendarConnection, ChannelConnection, Objection, QualificationRule, Service, SettingsResponse, Trainer } from '../lib/types';
import '../styles/onboarding.css';

// ───────────── Tipos locales ─────────────
type StepKey =
  | 'business'
  | 'trainer'
  | 'specialty'
  | 'ideal'
  | 'transformation'
  | 'service'
  | 'price'
  | 'modality'
  | 'availability'
  | 'qualification'
  | 'objections'
  | 'tone'
  | 'channels'
  | 'calendar';
type Modality = Trainer['modality'];
type BillingPeriod = Service['billingPeriod'];
type PricePolicy = AiSettings['pricePolicy'];
type WeekdayKey = keyof AvailabilityWeek;
type Errors = Record<string, string>;
type RuleDraft = Pick<QualificationRule, 'key' | 'label' | 'description' | 'question' | 'weight' | 'required' | 'enabled' | 'disqualifyWhen'>;
type ObjectionDraft = Pick<Objection, 'key' | 'label' | 'triggers' | 'strategy' | 'exampleResponse' | 'enabled'>;

interface Draft {
  businessName: string;
  timezone: string;
  displayName: string;
  specialty: string;
  credentials: string;
  idealClient: string;
  transformation: string;
  methodName: string;
  methodDescription: string;
  serviceName: string;
  serviceDescription: string;
  includes: string[];
  durationWeeks: string;
  price: string;
  billingPeriod: BillingPeriod;
  pricePolicy: PricePolicy;
  modality: Modality;
  weekly: AvailabilityWeek;
  callDurationMinutes: number;
  rules: RuleDraft[];
  objections: ObjectionDraft[];
  tone: AiTone;
  wordsToUse: string[];
  wordsToAvoid: string[];
  examplesWhatsapp: string;
  examplesInstagram: string;
  examplesOther: string;
  assistantName: string;
}

interface IntegrationsResponse {
  server: { ai: string; meta: boolean; google: boolean; email: boolean };
  channels: ChannelConnection[];
  calendars: CalendarConnection[];
  endpoints: { publicFormUrl: string; leadsWebhookUrl: string };
}

interface PreviewResponse {
  leadMessage: string;
  reply: string | null;
  issues: string[];
  engine: 'llm' | 'rules';
}

interface StepDef {
  key: StepKey;
  title: string;
  icon: LucideIcon;
  heading: string;
  description: string;
}

// ───────────── Pasos ─────────────
const STEPS: StepDef[] = [
  {
    key: 'business',
    title: 'Tu negocio',
    icon: Building2,
    heading: '¿Cómo se llama tu negocio?',
    description: 'Empezamos por lo básico. En unos minutos KAI sabrá lo que necesita para atender a tus leads como lo harías tú. Podrás cambiarlo todo más adelante.',
  },
  {
    key: 'trainer',
    title: 'Tu nombre',
    icon: UserRound,
    heading: '¿Cómo te llamas?',
    description: 'KAI trabaja como parte de tu equipo y se referirá a ti por este nombre, por ejemplo: «Laura revisará tu caso en la llamada».',
  },
  {
    key: 'specialty',
    title: 'Especialidad',
    icon: Dumbbell,
    heading: '¿Cuál es tu especialidad?',
    description: 'Resume en pocas palabras en qué ayudas a tus clientes. KAI lo usará para explicar a qué te dedicas.',
  },
  {
    key: 'ideal',
    title: 'Cliente ideal',
    icon: UsersRound,
    heading: '¿Quién es tu cliente ideal?',
    description: 'Describe a la persona a la que mejor ayudas: su edad, su situación y lo que le preocupa. KAI lo usará para valorar si un lead encaja contigo.',
  },
  {
    key: 'transformation',
    title: 'Resultado y método',
    icon: Target,
    heading: '¿Qué consiguen tus clientes contigo?',
    description: 'Cuéntale a KAI qué cambio buscas en tus clientes y cómo trabajas. KAI nunca prometerá resultados concretos ni plazos garantizados.',
  },
  {
    key: 'service',
    title: 'Servicio',
    icon: Package,
    heading: '¿Qué servicio ofreces?',
    description: 'Es el programa que vendes. KAI lo explicará cuando un lead pregunte qué incluye. Más adelante podrás añadir otros servicios desde Setter IA → Servicio y precio.',
  },
  {
    key: 'price',
    title: 'Precio',
    icon: Banknote,
    heading: '¿Cuánto cuesta tu servicio?',
    description: 'KAI usará siempre este precio exacto. Nunca inventará descuentos ni ofertas.',
  },
  {
    key: 'modality',
    title: 'Modalidad',
    icon: MonitorSmartphone,
    heading: '¿Cómo entrenas a tus clientes?',
    description: 'Así KAI sabrá qué responder cuando alguien pregunte si el servicio es online o presencial.',
  },
  {
    key: 'availability',
    title: 'Disponibilidad',
    icon: CalendarClock,
    heading: '¿Cuándo puedes atender llamadas?',
    description: 'Indica las franjas en las que te viene bien hablar con leads interesados. KAI solo propondrá horarios dentro de ellas y nunca encima de otra cita.',
  },
  {
    key: 'qualification',
    title: 'Preguntas de cualificación',
    icon: ListChecks,
    heading: '¿Qué debe averiguar KAI antes de proponer una llamada?',
    description: 'Cualificar es comprobar si un lead encaja contigo antes de ofrecerle una llamada. KAI hace estas preguntas de forma natural durante la conversación, no como un formulario.',
  },
  {
    key: 'objections',
    title: 'Objeciones frecuentes',
    icon: MessageCircleQuestion,
    heading: '¿Qué dudas suelen ponerte antes de apuntarse?',
    description: 'Las objeciones son las dudas o frenos típicos («es caro», «me lo tengo que pensar»…). Activa las que sueles escuchar y escribe cómo responderías tú: KAI lo tomará como referencia de tu estilo.',
  },
  {
    key: 'tone',
    title: 'Tono de comunicación',
    icon: MessageSquareText,
    heading: '¿Cómo quieres que hable KAI?',
    description: 'Ajusta el estilo para que los mensajes suenen como tú. Al final de la página puedes ver un ejemplo antes de continuar.',
  },
  {
    key: 'channels',
    title: 'Conectar canales',
    icon: Plug,
    heading: 'Conecta tus canales',
    description: 'Los canales son los sitios por donde te escriben tus leads. Cuando los conectes, KAI podrá leer y responder esos mensajes por ti.',
  },
  {
    key: 'calendar',
    title: 'Conectar calendario',
    icon: CalendarDays,
    heading: 'Conecta tu calendario',
    description: 'KAI necesita saber cuándo estás libre para agendar llamadas. Puedes conectar tu calendario o usar la agenda que ya incluye KAI.',
  },
];
const TOTAL = STEPS.length;

const DAYS: WeekdayKey[] = ['1', '2', '3', '4', '5', '6', '7'];
const HM = /^([01]\d|2[0-3]):[0-5]\d$|^24:00$/;
/** Largo máximo de cada palabra o expresión del vocabulario (el mismo que exige el servidor). */
const MAX_WORD = 40;

/**
 * Error de una palabra o expresión demasiado larga. Dice cuál es (puede haberla añadido KAI Copilot),
 * para que el entrenador sepa qué etiqueta quitar en vez de buscarla a ciegas.
 */
function longWordError(word: string): string {
  const shown = word.length > 60 ? `${word.slice(0, 57)}…` : word;
  return `«${shown}» tiene más de ${MAX_WORD} caracteres. Quítala con la × y, si quieres, añádela más corta.`;
}

const TIMEZONES = [
  { value: 'Europe/Madrid', label: 'España peninsular y Baleares (Madrid)' },
  { value: 'Atlantic/Canary', label: 'Islas Canarias' },
  { value: 'Europe/Lisbon', label: 'Portugal (Lisboa)' },
  { value: 'Europe/London', label: 'Reino Unido (Londres)' },
  { value: 'America/Mexico_City', label: 'México (Ciudad de México)' },
  { value: 'America/Bogota', label: 'Colombia (Bogotá)' },
  { value: 'America/Lima', label: 'Perú (Lima)' },
  { value: 'America/Santiago', label: 'Chile (Santiago)' },
  { value: 'America/Argentina/Buenos_Aires', label: 'Argentina (Buenos Aires)' },
  { value: 'America/Montevideo', label: 'Uruguay (Montevideo)' },
  { value: 'America/Caracas', label: 'Venezuela (Caracas)' },
  { value: 'America/New_York', label: 'EE. UU., costa este (Nueva York)' },
  { value: 'America/Los_Angeles', label: 'EE. UU., costa oeste (Los Ángeles)' },
];

const SPECIALTY_SUGGESTIONS = ['Pérdida de grasa', 'Recomposición corporal', 'Ganancia de masa muscular', 'Fuerza', 'Hábitos saludables', 'Entrenamiento postparto'];

const BILLING_OPTIONS: { value: BillingPeriod; label: string }[] = [
  { value: 'one_time', label: 'Pago único' },
  { value: 'monthly', label: 'Mensual' },
  { value: 'quarterly', label: 'Trimestral' },
  { value: 'semiannual', label: 'Semestral' },
  { value: 'annual', label: 'Anual' },
];

const MODALITIES: { value: Modality; label: string; description: string; icon: LucideIcon }[] = [
  { value: 'online', label: 'Online', description: 'Entrenas a distancia: con app, videollamadas o mensajes.', icon: Laptop },
  { value: 'presencial', label: 'Presencial', description: 'Entrenas en persona: en tu centro, en un gimnasio o a domicilio.', icon: Dumbbell },
  { value: 'hibrido', label: 'Híbrido', description: 'Combinas sesiones en persona con seguimiento online.', icon: Shuffle },
];

const CALL_DURATIONS = [15, 20, 30, 45, 60, 90];

const TONE_SLIDERS: { key: 'formality' | 'energy' | 'directness'; label: string; hint: string; scale: string[] }[] = [
  { key: 'formality', label: 'Formalidad', hint: '¿Hablas como con un amigo o de forma más profesional?', scale: ['Muy cercano', 'Cercano', 'Equilibrado', 'Formal', 'Muy formal'] },
  { key: 'energy', label: 'Energía', hint: '¿Mensajes tranquilos o con mucha motivación?', scale: ['Muy calmado', 'Tranquilo', 'Equilibrado', 'Enérgico', 'Muy enérgico'] },
  { key: 'directness', label: 'Directividad', hint: 'Lo directo que eres al proponer el siguiente paso.', scale: ['Muy suave', 'Suave', 'Equilibrado', 'Directo', 'Muy directo'] },
];

// ───────────── Utilidades ─────────────
const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));
const toMinutes = (hm: string) => {
  const [h, m] = hm.split(':').map(Number);
  return h * 60 + m;
};

function centsToText(cents: number): string {
  return cents % 100 === 0 ? String(cents / 100) : (cents / 100).toFixed(2).replace('.', ',');
}

/**
 * Servicio que edita el onboarding: el principal o, si no hay ninguno marcado como principal, el primero activo
 * (así no se crea un duplicado si el servicio perdió la marca de principal).
 */
const onboardingService = (services: Service[]) => services.find((x) => x.isPrimary) ?? services.find((x) => x.isActive) ?? services[0] ?? null;

/** Moneda del negocio (la que hereda un negocio creado con «Añadir negocio»). Es la de los precios que KAI da a los leads. */
const businessCurrency = (s: SettingsResponse) => s.business.currency || 'EUR';

/** Cómo se muestra la moneda junto a un importe: «€» para el euro y el código para el resto («MXN»), igual que en Setter IA. */
const currencySymbol = (currency: string) => (currency === 'EUR' ? '€' : currency);

/**
 * Cuerpo COMPLETO del servicio principal. Se envía entero en los pasos «Servicio» y «Precio» porque el servidor
 * rellena con sus valores por defecto los campos que no llegan (descripción vacía, sin elementos incluidos, no principal).
 * El precio solo se envía cuando hay un importe válido, para no borrar uno ya guardado. Va siempre en la moneda del negocio.
 */
function servicePayload(d: Draft, currency: string) {
  const cents = parseEurosToCents(d.price);
  return {
    name: d.serviceName.trim(),
    description: d.serviceDescription.trim(),
    includes: d.includes.map((x) => x.trim()).filter(Boolean),
    durationWeeks: d.durationWeeks.trim() ? Number(d.durationWeeks) : null,
    ...(cents !== null && cents > 0 ? { priceCents: cents } : {}),
    currency,
    billingPeriod: d.billingPeriod,
    isPrimary: true,
    isActive: true,
  };
}

function normalizeWeek(w: AvailabilityWeek | undefined): AvailabilityWeek {
  const out = {} as AvailabilityWeek;
  for (const d of DAYS) out[d] = (w?.[d] ?? []).map((r) => ({ start: r.start.slice(0, 5), end: r.end.slice(0, 5) }));
  return out;
}

function buildDraft(s: SettingsResponse): Draft {
  const svc = onboardingService(s.services);
  const t = s.trainer;
  const ai = s.aiSettings;
  return {
    businessName: s.business.name ?? '',
    timezone: s.business.timezone || 'Europe/Madrid',
    displayName: t?.displayName ?? '',
    specialty: t?.specialty ?? '',
    credentials: t?.credentials ?? '',
    idealClient: t?.idealClient ?? '',
    transformation: t?.transformation ?? '',
    methodName: t?.methodName ?? '',
    methodDescription: t?.methodDescription ?? '',
    serviceName: svc?.name ?? '',
    serviceDescription: svc?.description ?? '',
    includes: svc?.includes.length ? [...svc.includes] : [''],
    durationWeeks: svc?.durationWeeks ? String(svc.durationWeeks) : '',
    price: svc && svc.priceCents > 0 ? centsToText(svc.priceCents) : '',
    billingPeriod: svc?.billingPeriod ?? 'monthly',
    pricePolicy: ai?.pricePolicy ?? 'contextualize_first',
    modality: t?.modality ?? 'online',
    weekly: normalizeWeek(s.availability?.weekly),
    callDurationMinutes: ai?.callDurationMinutes ?? s.availability?.callDurationMinutes ?? 30,
    rules: s.qualificationRules.map((r) => ({
      key: r.key,
      label: r.label,
      description: r.description ?? '',
      question: r.question ?? '',
      weight: r.weight,
      required: r.required,
      enabled: r.enabled,
      disqualifyWhen: r.disqualifyWhen ?? '',
    })),
    objections: s.objections.map((o) => ({
      key: o.key,
      label: o.label,
      triggers: [...o.triggers],
      strategy: o.strategy ?? '',
      exampleResponse: o.exampleResponse ?? '',
      enabled: o.enabled,
    })),
    tone: { ...DEFAULT_TONE, ...(ai?.tone ?? {}) },
    wordsToUse: [...(ai?.wordsToUse ?? [])],
    wordsToAvoid: [...(ai?.wordsToAvoid ?? [])],
    examplesWhatsapp: ai?.examplesWhatsapp ?? '',
    examplesInstagram: ai?.examplesInstagram ?? '',
    examplesOther: ai?.examplesOther ?? '',
    assistantName: ai?.assistantName || 'KAI',
  };
}

function rangeErrors(ranges: TimeRange[], callMinutes: number): string | null {
  if (ranges.length > 6) return 'Máximo 6 franjas por día.';
  for (const r of ranges) {
    if (!HM.test(r.start) || !HM.test(r.end)) return 'Revisa las horas: usa el formato HH:MM (por ejemplo, 09:30).';
    if (r.start >= r.end) return 'La hora de inicio debe ser anterior a la de fin.';
    if (toMinutes(r.end) - toMinutes(r.start) < callMinutes) return `Hay una franja más corta que la duración de la llamada (${callMinutes} min).`;
  }
  const sorted = [...ranges].sort((a, b) => a.start.localeCompare(b.start));
  for (let i = 1; i < sorted.length; i++) if (sorted[i].start < sorted[i - 1].end) return 'Hay franjas que se solapan. Ajusta las horas.';
  return null;
}

function validateStep(key: StepKey, d: Draft): Errors {
  const e: Errors = {};
  const len = (s: string) => s.trim().length;
  switch (key) {
    case 'business':
      if (len(d.businessName) < 2) e.businessName = 'Escribe el nombre de tu negocio (mínimo 2 caracteres).';
      else if (len(d.businessName) > 120) e.businessName = 'El nombre es demasiado largo (máximo 120 caracteres).';
      if (!d.timezone) e.timezone = 'Elige tu zona horaria.';
      break;
    case 'trainer':
      if (len(d.displayName) < 2) e.displayName = 'Escribe tu nombre (mínimo 2 caracteres).';
      else if (len(d.displayName) > 80) e.displayName = 'El nombre es demasiado largo (máximo 80 caracteres).';
      break;
    case 'specialty':
      if (len(d.specialty) < 3) e.specialty = 'Cuéntanos brevemente cuál es tu especialidad.';
      else if (len(d.specialty) > 200) e.specialty = 'Resúmelo un poco más (máximo 200 caracteres).';
      if (len(d.credentials) > 1000) e.credentials = 'Máximo 1000 caracteres.';
      break;
    case 'ideal':
      if (len(d.idealClient) < 10) e.idealClient = 'Describe a tu cliente ideal con un poco más de detalle.';
      else if (len(d.idealClient) > 1000) e.idealClient = 'Máximo 1000 caracteres.';
      break;
    case 'transformation':
      if (len(d.transformation) < 10) e.transformation = 'Describe en una o dos frases el cambio que consiguen tus clientes.';
      else if (len(d.transformation) > 1000) e.transformation = 'Máximo 1000 caracteres.';
      if (len(d.methodName) > 80) e.methodName = 'Máximo 80 caracteres.';
      if (len(d.methodDescription) > 2000) e.methodDescription = 'Máximo 2000 caracteres.';
      break;
    case 'service': {
      if (len(d.serviceName) < 2) e.serviceName = 'Escribe el nombre de tu servicio (mínimo 2 caracteres).';
      else if (len(d.serviceName) > 120) e.serviceName = 'Máximo 120 caracteres.';
      if (len(d.serviceDescription) > 1000) e.serviceDescription = 'Máximo 1000 caracteres.';
      const items = d.includes.map((x) => x.trim()).filter(Boolean);
      if (items.length > 15) e.includes = 'Puedes añadir hasta 15 elementos.';
      d.includes.forEach((x, i) => {
        if (x.trim().length > 120) e[`includes.${i}`] = 'Máximo 120 caracteres.';
      });
      if (d.durationWeeks.trim()) {
        const n = Number(d.durationWeeks);
        if (!Number.isInteger(n) || n < 1 || n > 520) e.durationWeeks = 'Escribe un número de semanas entre 1 y 520, o déjalo vacío.';
      }
      break;
    }
    case 'price': {
      const cents = parseEurosToCents(d.price);
      if (!d.price.trim()) e.price = 'Indica el precio de tu servicio.';
      else if (cents === null) e.price = 'Escribe solo el importe, por ejemplo 149 o 149,90.';
      else if (cents <= 0) e.price = 'El precio debe ser mayor que 0.';
      else if (cents > 100_000_000) e.price = 'El importe es demasiado alto.';
      else if (len(d.serviceName) < 2) e.price = 'Antes vuelve al paso «Servicio» y escribe el nombre de tu servicio.';
      else if (hasErrors(validateStep('service', d))) e.price = 'Antes vuelve al paso «Servicio» y revisa los datos marcados en rojo.';
      break;
    }
    case 'availability': {
      if (!Number.isInteger(d.callDurationMinutes) || d.callDurationMinutes < 10 || d.callDurationMinutes > 120) e.callDurationMinutes = 'La llamada debe durar entre 10 y 120 minutos.';
      for (const day of DAYS) {
        const err = rangeErrors(d.weekly[day], d.callDurationMinutes);
        if (err) e[`weekly.${day}`] = err;
      }
      if (!DAYS.some((day) => d.weekly[day].length > 0)) e.weekly = 'Añade al menos una franja para que KAI pueda proponer llamadas.';
      break;
    }
    case 'qualification':
      d.rules.forEach((r, i) => {
        if (len(r.label) < 2) e[`rules.${i}.label`] = 'Ponle un nombre (mínimo 2 caracteres).';
        else if (len(r.label) > 60) e[`rules.${i}.label`] = 'Máximo 60 caracteres.';
        if (len(r.question) > 300) e[`rules.${i}.question`] = 'Máximo 300 caracteres.';
        // Misma regla que el servidor: más de un «?» son varias preguntas, y KAI hace solo una por mensaje.
        else if (hasSeveralQuestions(r.question)) {
          e[`rules.${i}.question`] = ONE_QUESTION_MESSAGE;
          // Si la pregunta está desactivada, su campo no se ve: se avisa arriba para que se pueda corregir.
          if (!r.enabled) e.rules = `«${r.label.trim() || r.key}»: ${ONE_QUESTION_MESSAGE} Actívala para corregirla.`;
        }
      });
      if (!d.rules.some((r) => r.enabled && r.weight > 0)) e.rules = 'Activa al menos una pregunta para que KAI pueda valorar a tus leads.';
      break;
    case 'objections':
      d.objections.forEach((o, i) => {
        if (len(o.exampleResponse) > 700) e[`objections.${i}.exampleResponse`] = 'Máximo 700 caracteres.';
      });
      break;
    case 'tone':
      if (len(d.assistantName) < 1) e.assistantName = 'Ponle un nombre a tu asistente (por ejemplo, KAI).';
      else if (len(d.assistantName) > 40) e.assistantName = 'Máximo 40 caracteres.';
      {
        const longUse = d.wordsToUse.find((w) => w.length > MAX_WORD);
        const longAvoid = d.wordsToAvoid.find((w) => w.length > MAX_WORD);
        if (d.wordsToUse.length > 50) e.wordsToUse = 'Máximo 50 palabras o expresiones.';
        else if (longUse) e.wordsToUse = longWordError(longUse);
        if (d.wordsToAvoid.length > 100) e.wordsToAvoid = 'Máximo 100 palabras o expresiones.';
        else if (longAvoid) e.wordsToAvoid = longWordError(longAvoid);
      }
      if (d.examplesWhatsapp.length > 6000) e.examplesWhatsapp = 'Máximo 6000 caracteres.';
      if (d.examplesInstagram.length > 6000) e.examplesInstagram = 'Máximo 6000 caracteres.';
      if (d.examplesOther.length > 6000) e.examplesOther = 'Máximo 6000 caracteres.';
      break;
    default:
      break;
  }
  return e;
}

const hasErrors = (e: Errors) => Object.keys(e).length > 0;

function revealFirstError() {
  requestAnimationFrame(() => {
    const el = document.querySelector<HTMLElement>('.onb-content [aria-invalid="true"], .onb-content .error-text');
    if (!el) return;
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    if (el.matches('input, textarea, select')) el.focus({ preventScroll: true });
  });
}

// ───────────── Piezas de interfaz ─────────────
function ConnBadge({ state }: { state: 'connected' | 'error' | 'none' | 'available' | 'unavailable' }) {
  if (state === 'connected') return <span className="badge badge-success badge-dot">Conectado</span>;
  if (state === 'error') return <span className="badge badge-danger badge-dot">Revisa la conexión</span>;
  if (state === 'available') return <span className="badge badge-info badge-dot">Disponible</span>;
  if (state === 'unavailable') return <span className="badge badge-warning badge-dot">Aún no disponible</span>;
  return <span className="badge badge-dot">Sin conectar</span>;
}

function channelState(list: { status: string }[]): 'connected' | 'error' | 'none' {
  if (list.some((c) => c.status === 'connected')) return 'connected';
  if (list.some((c) => c.status === 'error')) return 'error';
  return 'none';
}

function ConnectCard({ icon, title, state, children }: { icon: ReactNode; title: string; state: ReactNode; children: ReactNode }) {
  return (
    <div className="card card-tight">
      <div className="onb-connect">
        <span className="onb-connect-icon" aria-hidden>
          {icon}
        </span>
        <div className="grow">
          <div className="row-between wrap">
            <h3>{title}</h3>
            {state}
          </div>
          <div className="muted small mt-4">{children}</div>
        </div>
      </div>
    </div>
  );
}

function ChoiceGroup<T extends string>({ label, hint, value, onChange, options }: { label: string; hint?: string; value: T; onChange: (v: T) => void; options: { value: T; label: string }[] }) {
  const id = useId();
  return (
    <div className="field">
      <span className="label" id={id}>
        {label}
      </span>
      <div role="group" aria-labelledby={id}>
        <Segmented value={value} onChange={onChange} options={options} />
      </div>
      {hint && <span className="hint">{hint}</span>}
    </div>
  );
}

function ToneSlider({ id, label, hint, scale, value, onChange }: { id: string; label: string; hint: string; scale: string[]; value: number; onChange: (v: number) => void }) {
  const text = scale[clamp(value, 1, 5) - 1];
  return (
    <div className="field">
      <div className="row-between">
        <label className="label" htmlFor={id}>
          {label}
        </label>
        <span className="onb-slider-value">{text}</span>
      </div>
      <input id={id} type="range" className="range" min={1} max={5} step={1} value={value} aria-valuetext={text} onChange={(e) => onChange(Number(e.target.value))} />
      <div className="onb-slider-scale" aria-hidden>
        <span>{scale[0]}</span>
        <span>{scale[4]}</span>
      </div>
      <span className="hint">{hint}</span>
    </div>
  );
}

const INCLUDE_PLACEHOLDERS = ['Ej.: Plan de entrenamiento personalizado', 'Ej.: Pautas de nutrición flexibles, sin dietas extremas', 'Ej.: Revisión semanal del progreso por WhatsApp'];

function IncludesEditor({ items, onChange, errors }: { items: string[]; onChange: (v: string[]) => void; errors: Errors }) {
  const add = () => {
    if (items.length >= 15) return;
    const idx = items.length;
    onChange([...items, '']);
    requestAnimationFrame(() => document.getElementById(`onb-include-${idx}`)?.focus());
  };
  return (
    <div className="field">
      <span className="label">Qué incluye</span>
      <div className="col">
        {items.map((it, i) => (
          <div key={i} className="col gap-4">
            <div className="onb-list-row">
              <Input
                id={`onb-include-${i}`}
                value={it}
                maxLength={120}
                aria-label={`Elemento ${i + 1} de lo que incluye el servicio`}
                aria-invalid={Boolean(errors[`includes.${i}`])}
                placeholder={INCLUDE_PLACEHOLDERS[i] ?? 'Ej.: Acceso a la app de entrenamiento'}
                onChange={(e) => onChange(items.map((x, idx) => (idx === i ? e.target.value : x)))}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    if (it.trim()) add();
                  }
                }}
              />
              <Button variant="ghost" size="sm" iconOnly icon={Trash2} disabled={items.length === 1 && !it} onClick={() => onChange(items.length === 1 ? [''] : items.filter((_, idx) => idx !== i))}>
                Quitar elemento {i + 1}
              </Button>
            </div>
            {errors[`includes.${i}`] && <span className="error-text">{errors[`includes.${i}`]}</span>}
          </div>
        ))}
      </div>
      <div className="row mt-4">
        <Button size="sm" variant="ghost" icon={Plus} onClick={add} disabled={items.length >= 15}>
          Añadir otro elemento
        </Button>
      </div>
      {errors.includes ? <span className="error-text">{errors.includes}</span> : <span className="hint">Lo que recibe el cliente: entrenamientos, nutrición, seguimiento… KAI solo mencionará lo que pongas aquí.</span>}
    </div>
  );
}

function AvailabilityEditor({
  weekly,
  onChange,
  callDuration,
  onDuration,
  timezone,
  errors,
}: {
  weekly: AvailabilityWeek;
  onChange: (w: AvailabilityWeek) => void;
  callDuration: number;
  onDuration: (n: number) => void;
  timezone: string;
  errors: Errors;
}) {
  const setRange = (day: WeekdayKey, i: number, key: 'start' | 'end', value: string) => onChange({ ...weekly, [day]: weekly[day].map((r, idx) => (idx === i ? { ...r, [key]: value } : r)) });
  const addRange = (day: WeekdayKey) => {
    const list = weekly[day];
    const next: TimeRange = list.length === 0 ? { start: '10:00', end: '14:00' } : { start: '17:00', end: '20:00' };
    onChange({ ...weekly, [day]: [...list, next] });
  };
  const toggleDay = (day: WeekdayKey, on: boolean) => onChange({ ...weekly, [day]: on ? [{ start: '10:00', end: '14:00' }] : [] });
  const copyMonday = () => {
    const base = weekly['1'].map((r) => ({ ...r }));
    onChange({ ...weekly, '2': base.map((r) => ({ ...r })), '3': base.map((r) => ({ ...r })), '4': base.map((r) => ({ ...r })), '5': base.map((r) => ({ ...r })) });
  };
  const durations = [...new Set([...CALL_DURATIONS, callDuration])].sort((a, b) => a - b);
  const tzLabel = TIMEZONES.find((t) => t.value === timezone)?.label ?? timezone;

  return (
    <>
      <Card title="Duración de la llamada" icon={CalendarClock}>
        <div className="grid-2">
          <Field label="¿Cuánto dura tu llamada con un lead?" htmlFor="onb-call-duration" error={errors.callDurationMinutes} hint="Es la llamada en la que conoces al lead y le explicas tu servicio.">
            <Select id="onb-call-duration" value={String(callDuration)} onChange={(e) => onDuration(Number(e.target.value))} options={durations.map((n) => ({ value: String(n), label: `${n} minutos` }))} />
          </Field>
          <div className="field">
            <span className="label">Zona horaria</span>
            <p className="small muted" style={{ paddingTop: 8 }}>
              Las horas se interpretan en: <strong>{tzLabel}</strong>. Puedes cambiarla en el paso «Tu negocio».
            </p>
          </div>
        </div>
      </Card>
      <Card title="Horario semanal" icon={CalendarDays}>
        <div className="row-between wrap" style={{ marginBottom: 4 }}>
          <span className="muted small">Activa los días en los que puedes hablar y ajusta las horas. Puedes poner varias franjas en un mismo día.</span>
          <Button size="sm" variant="ghost" icon={Copy} onClick={copyMonday} disabled={weekly['1'].length === 0}>
            Copiar el lunes de martes a viernes
          </Button>
        </div>
        {errors.weekly && (
          <div className="mt-8" style={{ marginBottom: 8 }}>
            <Callout tone="warning">{errors.weekly}</Callout>
          </div>
        )}
        <div>
          {DAYS.map((day) => {
            const ranges = weekly[day];
            const err = errors[`weekly.${day}`];
            return (
              <div key={day} className="onb-day">
                <div className="onb-day-name">
                  <Switch checked={ranges.length > 0} onChange={(on) => toggleDay(day, on)} label={<strong>{WEEKDAY_LABELS[day]}</strong>} />
                </div>
                <div className="col gap-4">
                  {ranges.length === 0 && (
                    <span className="subtle small" style={{ paddingTop: 8 }}>
                      Sin llamadas este día
                    </span>
                  )}
                  {ranges.map((r, i) => (
                    <div key={i} className="onb-range">
                      <Input type="time" value={r.start} aria-invalid={Boolean(err)} aria-label={`${WEEKDAY_LABELS[day]}, franja ${i + 1}: desde`} onChange={(e) => setRange(day, i, 'start', e.target.value)} />
                      <span className="subtle">a</span>
                      <Input type="time" value={r.end} aria-invalid={Boolean(err)} aria-label={`${WEEKDAY_LABELS[day]}, franja ${i + 1}: hasta`} onChange={(e) => setRange(day, i, 'end', e.target.value)} />
                      <Button variant="ghost" size="sm" iconOnly icon={Trash2} onClick={() => onChange({ ...weekly, [day]: ranges.filter((_, idx) => idx !== i) })}>
                        {`Quitar franja ${i + 1} del ${WEEKDAY_LABELS[day].toLowerCase()}`}
                      </Button>
                    </div>
                  ))}
                  {err && <span className="error-text">{err}</span>}
                </div>
                <div>
                  {ranges.length > 0 && ranges.length < 6 && (
                    <Button size="sm" variant="ghost" icon={Plus} onClick={() => addRange(day)} aria-label={`Añadir franja el ${WEEKDAY_LABELS[day].toLowerCase()}`}>
                      Franja
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </Card>
    </>
  );
}

// ───────────── Pantalla final ─────────────
function Celebration({ integrations }: { integrations: IntegrationsResponse | undefined }) {
  const navigate = useNavigate();
  const noChannels = integrations ? !integrations.channels.some((c) => c.status === 'connected') : false;
  return (
    <main className="onb-done">
      <div className="onb-done-card">
        <div className="onb-done-icon" aria-hidden>
          <PartyPopper />
        </div>
        <h1>KAI ya está listo para trabajar.</h1>
        <p className="muted" style={{ fontSize: 15 }}>
          Has terminado la configuración inicial. Puedes cambiar cualquier ajuste cuando quieras desde <strong>Setter IA</strong> y <strong>Ajustes</strong>.
        </p>
        {noChannels && (
          <div style={{ textAlign: 'left', width: '100%' }}>
            <Callout tone="info" icon={Plug}>
              Aún no has conectado ningún canal. KAI empezará a responder a tus leads reales cuando conectes WhatsApp o Instagram en <strong>Integraciones</strong>. Mientras tanto, puedes probarlo en el simulador.
            </Callout>
          </div>
        )}
        <div className="onb-done-actions">
          <Button variant="primary" size="lg" icon={LayoutDashboard} onClick={() => navigate('/app')}>
            Ir a mi panel
          </Button>
          <Button size="lg" icon={FlaskConical} onClick={() => navigate('/app/simulador')}>
            Probar KAI en el simulador
          </Button>
        </div>
      </div>
    </main>
  );
}

// ───────────── Asistente ─────────────
function Wizard({ settings }: { settings: SettingsResponse }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { refresh, logout, me } = useAuth();
  const alreadyDone = Boolean(settings.business.onboardingCompletedAt);
  const initialStep = clamp(settings.business.onboardingStep || 1, 1, TOTAL);

  const [draft, setDraft] = useState<Draft>(() => buildDraft(settings));
  const [step, setStep] = useState(alreadyDone ? 1 : initialStep);
  const [maxReached, setMaxReached] = useState(alreadyDone ? TOTAL : initialStep);
  const [dirty, setDirty] = useState<Set<StepKey>>(() => new Set());
  const [errors, setErrors] = useState<Errors>({});
  const [busy, setBusy] = useState(false);
  const [finished, setFinished] = useState(false);
  const [leadMessage, setLeadMessage] = useState('Hola, vi tu anuncio. Quiero perder grasa pero no sé por dónde empezar.');
  const headingRef = useRef<HTMLHeadingElement>(null);
  const firstRender = useRef(true);
  const serviceId = useRef<string | null>(onboardingService(settings.services)?.id ?? null);

  const current = STEPS[step - 1];
  const isLast = step === TOTAL;

  const integrations = useQuery({
    queryKey: ['integrations'],
    queryFn: () => api.get<IntegrationsResponse>('/integrations'),
    enabled: step >= 13 || finished,
    refetchOnWindowFocus: true,
  });

  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    window.scrollTo({ top: 0 });
    headingRef.current?.focus({ preventScroll: true });
  }, [step]);

  /** Cambia campos del borrador y marca el paso como pendiente de guardar. */
  const edit = (key: StepKey, patch: Partial<Draft>) => {
    setDraft((d) => ({ ...d, ...patch }));
    setDirty((s) => (s.has(key) ? s : new Set(s).add(key)));
    const fields = Object.keys(patch);
    setErrors((prev) => {
      const next = Object.fromEntries(Object.entries(prev).filter(([k]) => !fields.some((f) => k === f || k.startsWith(`${f}.`))));
      return Object.keys(next).length === Object.keys(prev).length ? prev : next;
    });
  };

  const goTo = (n: number) => {
    setErrors({});
    setStep(clamp(n, 1, TOTAL));
  };

  /** Guarda el servicio principal. Si ya existe, se actualiza ese mismo servicio (nunca se crea un duplicado). */
  async function saveService(d: Draft) {
    const body = servicePayload(d, businessCurrency(settings));
    const id = serviceId.current;
    let res: { service: Service };
    if (id) {
      try {
        res = await api.patch<{ service: Service }>(`/settings/services/${id}`, body);
      } catch (e) {
        // Se borró desde otra pestaña: se vuelve a crear como principal.
        if (!(e instanceof ApiError && e.status === 404)) throw e;
        res = await api.put<{ service: Service }>('/settings/primary-service', body);
      }
    } else {
      res = await api.put<{ service: Service }>('/settings/primary-service', body);
    }
    serviceId.current = res.service.id;
  }

  async function saveStep(key: StepKey, d: Draft = draft) {
    switch (key) {
      case 'business':
        await api.put('/settings/business', {
          name: d.businessName.trim(),
          timezone: d.timezone,
          currency: businessCurrency(settings),
          monthlyAdSpendCents: settings.business.monthlyAdSpendCents ?? 0,
        });
        await qc.invalidateQueries({ queryKey: ['me'] });
        break;
      case 'trainer':
        await api.put('/settings/trainer', { displayName: d.displayName.trim() });
        break;
      case 'specialty':
        await api.put('/settings/trainer', { specialty: d.specialty.trim(), credentials: d.credentials.trim() });
        break;
      case 'ideal':
        await api.put('/settings/trainer', { idealClient: d.idealClient.trim() });
        break;
      case 'transformation':
        await api.put('/settings/trainer', { transformation: d.transformation.trim(), methodName: d.methodName.trim(), methodDescription: d.methodDescription.trim() });
        break;
      case 'service':
        await saveService(d);
        break;
      case 'price':
        await saveService(d);
        await api.put('/settings/ai', { pricePolicy: d.pricePolicy });
        break;
      case 'modality':
        await api.put('/settings/trainer', { modality: d.modality });
        break;
      case 'availability': {
        const a = settings.availability;
        await api.put('/agenda/availability', {
          weekly: d.weekly,
          slotMinutes: a.slotMinutes,
          bufferMinutes: a.bufferMinutes,
          minNoticeMinutes: a.minNoticeMinutes,
          maxDaysAhead: a.maxDaysAhead,
          blackoutDates: a.blackoutDates,
        });
        await api.put('/settings/ai', { callDurationMinutes: d.callDurationMinutes });
        void qc.invalidateQueries({ queryKey: ['availability'] });
        void qc.invalidateQueries({ queryKey: ['slots'] });
        break;
      }
      case 'qualification':
        await api.put('/settings/qualification', {
          rules: d.rules.map((r) => ({
            key: r.key,
            label: r.label.trim(),
            description: r.description,
            question: r.question.trim(),
            weight: r.weight,
            required: r.required,
            enabled: r.enabled,
            disqualifyWhen: r.disqualifyWhen,
          })),
        });
        break;
      case 'objections':
        await api.put('/settings/objections', {
          objections: d.objections.map((o) => ({
            key: o.key,
            label: o.label,
            triggers: o.triggers,
            strategy: o.strategy,
            exampleResponse: o.exampleResponse.trim(),
            enabled: o.enabled,
          })),
        });
        break;
      case 'tone':
        await api.put('/settings/ai', {
          tone: d.tone,
          wordsToUse: d.wordsToUse,
          wordsToAvoid: d.wordsToAvoid,
          examplesWhatsapp: d.examplesWhatsapp.trim(),
          examplesInstagram: d.examplesInstagram.trim(),
          examplesOther: d.examplesOther.trim(),
          assistantName: d.assistantName.trim(),
        });
        break;
      case 'channels':
      case 'calendar':
        break;
    }
    setDirty((s) => {
      if (!s.has(key)) return s;
      const n = new Set(s);
      n.delete(key);
      return n;
    });
    void qc.invalidateQueries({ queryKey: ['settings'] });
  }

  /** Guarda los pasos con cambios pendientes. En modo estricto se detiene en el primero que no sea válido. */
  async function flushDirty(strict: boolean, skip?: StepKey): Promise<boolean> {
    for (const [i, s] of STEPS.entries()) {
      if (!dirty.has(s.key) || s.key === skip) continue;
      const errs = validateStep(s.key, draft);
      if (hasErrors(errs)) {
        if (!strict) continue;
        setStep(i + 1);
        setErrors(errs);
        toast(`Revisa el paso «${s.title}» antes de terminar.`, 'error');
        revealFirstError();
        return false;
      }
      await saveStep(s.key);
    }
    return true;
  }

  async function next() {
    if (busy) return;
    const errs = validateStep(current.key, draft);
    if (hasErrors(errs)) {
      setErrors(errs);
      revealFirstError();
      return;
    }
    setBusy(true);
    try {
      await saveStep(current.key);
      if (isLast) {
        if (!(await flushDirty(true, current.key))) return;
        await api.post('/onboarding/complete');
        await qc.invalidateQueries({ queryKey: ['me'] });
        await refresh();
        void qc.invalidateQueries({ queryKey: ['settings'] });
        setFinished(true);
        window.scrollTo({ top: 0 });
        return;
      }
      const target = step + 1;
      await api.put('/onboarding/progress', { step: target });
      setMaxReached((m) => Math.max(m, target));
      goTo(target);
    } catch (e) {
      toast(errorText(e), 'error');
    } finally {
      setBusy(false);
    }
  }

  /** Navegación libre (Atrás o barra lateral): guarda el paso actual si tiene cambios válidos. */
  async function navigateTo(n: number) {
    if (busy || n === step || n < 1 || n > maxReached) return;
    if (dirty.has(current.key) && !hasErrors(validateStep(current.key, draft))) {
      setBusy(true);
      try {
        await saveStep(current.key);
      } catch (e) {
        toast(errorText(e), 'error');
        return;
      } finally {
        setBusy(false);
      }
    }
    goTo(n);
  }

  const preview = useMutation({
    mutationFn: async () => {
      const errs = validateStep('tone', draft);
      if (hasErrors(errs)) {
        setErrors(errs);
        throw new Error('Revisa los campos marcados antes de generar el ejemplo.');
      }
      await flushDirty(false);
      const msg = leadMessage.trim();
      return api.post<PreviewResponse>('/settings/ai/preview', msg ? { leadMessage: msg } : {});
    },
    // Límite de mensajes del plan (402): se explica dentro de la tarjeta del ejemplo, no en un aviso que desaparece.
    onError: (e) => {
      if (!(e instanceof ApiError && e.status === 402 && e.code === 'limit_reached')) toast(errorText(e), 'error');
    },
  });
  const previewLimit = preview.error instanceof ApiError && preview.error.status === 402 && preview.error.code === 'limit_reached' ? preview.error.message : null;

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void next();
  };

  if (finished) return <Celebration integrations={integrations.data} />;

  const progress = Math.round((step / TOTAL) * 100);

  // ───── Contenido de cada paso ─────
  const renderStep = () => {
    switch (current.key) {
      case 'business': {
        const tzOptions = TIMEZONES.some((t) => t.value === draft.timezone) ? TIMEZONES : [{ value: draft.timezone, label: draft.timezone }, ...TIMEZONES];
        return (
          <>
            <Field label="Nombre del negocio" htmlFor="onb-business" error={errors.businessName} hint="Si trabajas con tu propio nombre, también puedes usarlo aquí.">
              <Input id="onb-business" value={draft.businessName} maxLength={120} placeholder="Ej.: Quema Grasa con Laura" aria-invalid={Boolean(errors.businessName)} onChange={(e) => edit('business', { businessName: e.target.value })} />
            </Field>
            <Field label="Zona horaria" htmlFor="onb-tz" error={errors.timezone} hint="KAI la usa para proponer las llamadas a tu hora.">
              <Select id="onb-tz" value={draft.timezone} options={tzOptions} onChange={(e) => edit('business', { timezone: e.target.value })} />
            </Field>
          </>
        );
      }
      case 'trainer':
        return (
          <Field label="Tu nombre" htmlFor="onb-name" error={errors.displayName} hint="Basta con tu nombre o tu nombre y apellido.">
            <Input id="onb-name" value={draft.displayName} maxLength={80} placeholder="Ej.: Laura Martín" autoComplete="name" aria-invalid={Boolean(errors.displayName)} onChange={(e) => edit('trainer', { displayName: e.target.value })} />
          </Field>
        );
      case 'specialty': {
        const lower = draft.specialty.toLowerCase();
        return (
          <>
            <Field label="Tu especialidad" htmlFor="onb-specialty" error={errors.specialty} hint={`${draft.specialty.trim().length}/200 caracteres`}>
              <Input
                id="onb-specialty"
                value={draft.specialty}
                maxLength={200}
                placeholder="Ej.: Pérdida de grasa para mujeres de 30 a 50 años, sin dietas extremas"
                aria-invalid={Boolean(errors.specialty)}
                onChange={(e) => edit('specialty', { specialty: e.target.value })}
              />
            </Field>
            <div className="field">
              <span className="label" id="onb-specialty-ideas">
                Ideas rápidas (pulsa para añadir)
              </span>
              <div className="onb-suggest" role="group" aria-labelledby="onb-specialty-ideas">
                {SPECIALTY_SUGGESTIONS.map((s) => {
                  const included = lower.includes(s.toLowerCase());
                  return (
                    <button
                      key={s}
                      type="button"
                      className="chip"
                      aria-pressed={included}
                      onClick={() => {
                        if (included) return;
                        const base = draft.specialty.trim();
                        edit('specialty', { specialty: base ? `${base}, ${s.toLowerCase()}` : s });
                      }}
                    >
                      {s}
                    </button>
                  );
                })}
              </div>
            </div>
            <Field label="Tu formación y experiencia (opcional)" htmlFor="onb-credentials" error={errors.credentials} hint="KAI solo mencionará lo que pongas aquí. Nunca se inventará títulos ni años de experiencia.">
              <Textarea
                id="onb-credentials"
                rows={3}
                value={draft.credentials}
                maxLength={1000}
                placeholder="Ej.: Graduado en Ciencias de la Actividad Física y del Deporte. Formación en nutrición deportiva."
                aria-invalid={Boolean(errors.credentials)}
                onChange={(e) => edit('specialty', { credentials: e.target.value })}
              />
            </Field>
          </>
        );
      }
      case 'ideal':
        return (
          <Field label="Tu cliente ideal" htmlFor="onb-ideal" error={errors.idealClient} hint="Cuanto más concreto, mejor sabrá KAI con quién merece la pena proponer una llamada.">
            <Textarea
              id="onb-ideal"
              rows={5}
              value={draft.idealClient}
              maxLength={1000}
              placeholder="Ej.: Mujeres de 35 a 50 años que trabajan fuera de casa, han probado varias dietas sin éxito y quieren perder grasa sin pasar hambre ni vivir en el gimnasio."
              aria-invalid={Boolean(errors.idealClient)}
              onChange={(e) => edit('ideal', { idealClient: e.target.value })}
            />
          </Field>
        );
      case 'transformation':
        return (
          <>
            <Field label="El cambio que consiguen tus clientes" htmlFor="onb-transformation" error={errors.transformation} hint="Describe el cambio sin cifras garantizadas.">
              <Textarea
                id="onb-transformation"
                rows={4}
                value={draft.transformation}
                maxLength={1000}
                placeholder="Ej.: Que pierdan grasa de forma sostenible, ganen energía y aprendan a comer sin depender de una dieta."
                aria-invalid={Boolean(errors.transformation)}
                onChange={(e) => edit('transformation', { transformation: e.target.value })}
              />
            </Field>
            <Field label="Nombre de tu método (opcional)" htmlFor="onb-method" error={errors.methodName} hint="Si tu forma de trabajar tiene nombre propio, escríbelo aquí.">
              <Input id="onb-method" value={draft.methodName} maxLength={80} placeholder="Ej.: Método Quema 360" aria-invalid={Boolean(errors.methodName)} onChange={(e) => edit('transformation', { methodName: e.target.value })} />
            </Field>
            <Field label="¿En qué consiste tu método?" htmlFor="onb-method-desc" error={errors.methodDescription} hint="Explícalo como se lo contarías a un cliente en una llamada.">
              <Textarea
                id="onb-method-desc"
                rows={4}
                value={draft.methodDescription}
                maxLength={2000}
                placeholder="Ej.: Entrenamiento de fuerza tres días por semana, nutrición flexible sin alimentos prohibidos y seguimiento semanal para ajustar el plan."
                aria-invalid={Boolean(errors.methodDescription)}
                onChange={(e) => edit('transformation', { methodDescription: e.target.value })}
              />
            </Field>
          </>
        );
      case 'service':
        return (
          <>
            <Field label="Nombre del servicio" htmlFor="onb-service" error={errors.serviceName}>
              <Input id="onb-service" value={draft.serviceName} maxLength={120} placeholder="Ej.: Programa de pérdida de grasa 1:1" aria-invalid={Boolean(errors.serviceName)} onChange={(e) => edit('service', { serviceName: e.target.value })} />
            </Field>
            <Field label="Descripción breve" htmlFor="onb-service-desc" error={errors.serviceDescription} hint="Una o dos frases que expliquen en qué consiste.">
              <Textarea
                id="onb-service-desc"
                rows={3}
                value={draft.serviceDescription}
                maxLength={1000}
                placeholder="Ej.: Acompañamiento online personalizado para perder grasa sin dietas extremas y mantener el resultado."
                aria-invalid={Boolean(errors.serviceDescription)}
                onChange={(e) => edit('service', { serviceDescription: e.target.value })}
              />
            </Field>
            <IncludesEditor items={draft.includes} errors={errors} onChange={(includes) => edit('service', { includes })} />
            <div className="grid-2">
              <Field label="Duración en semanas (opcional)" htmlFor="onb-weeks" error={errors.durationWeeks} hint="Déjalo vacío si no tiene una duración fija.">
                <Input
                  id="onb-weeks"
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={520}
                  value={draft.durationWeeks}
                  placeholder="Ej.: 12"
                  aria-invalid={Boolean(errors.durationWeeks)}
                  onChange={(e) => edit('service', { durationWeeks: e.target.value })}
                />
              </Field>
            </div>
          </>
        );
      case 'price': {
        const cents = parseEurosToCents(draft.price);
        const currency = businessCurrency(settings);
        return (
          <>
            <div className="grid-2">
              <Field
                label="Importe"
                htmlFor="onb-price"
                error={errors.price}
                hint={`${currency === 'EUR' ? 'En euros' : `En ${currency}, la moneda de tu negocio`}. Puedes usar decimales: 149,90.`}
              >
                <div className="input-group onb-amount">
                  <Input id="onb-price" inputMode="decimal" value={draft.price} placeholder="Ej.: 149" aria-invalid={Boolean(errors.price)} onChange={(e) => edit('price', { price: e.target.value })} />
                  <span className="input-suffix">{currencySymbol(currency)}</span>
                </div>
              </Field>
              <div className="field">
                <span className="label" id="onb-billing">
                  ¿Cada cuánto se paga?
                </span>
                <div className="chips" role="group" aria-labelledby="onb-billing">
                  {BILLING_OPTIONS.map((o) => (
                    <button key={o.value} type="button" className="chip" aria-pressed={draft.billingPeriod === o.value} onClick={() => edit('price', { billingPeriod: o.value })}>
                      {o.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
            {cents !== null && cents > 0 && (
              <p className="muted">
                Tus leads lo verán así:{' '}
                <strong>
                  {formatMoney(cents, currency)} {draft.billingPeriod === 'one_time' ? '(pago único)' : BILLING_PERIOD_LABELS[draft.billingPeriod]}
                </strong>
              </p>
            )}
            <div className="field">
              <span className="label" id="onb-price-policy">
                ¿Cuándo debe KAI decir el precio?
              </span>
              <div className="option-grid" role="group" aria-labelledby="onb-price-policy">
                <button type="button" className="option" aria-pressed={draft.pricePolicy === 'contextualize_first'} onClick={() => edit('price', { pricePolicy: 'contextualize_first' })}>
                  <span className="onb-option-title">Primero entender su caso (recomendado)</span>
                  <span className="small muted">Si lo preguntan nada más empezar, KAI hace antes alguna pregunta para entender su situación. Si insisten, siempre lo da.</span>
                </button>
                <button type="button" className="option" aria-pressed={draft.pricePolicy === 'share_directly'} onClick={() => edit('price', { pricePolicy: 'share_directly' })}>
                  <span className="onb-option-title">Decirlo directamente</span>
                  <span className="small muted">En cuanto un lead pregunte el precio, KAI se lo dice.</span>
                </button>
              </div>
            </div>
          </>
        );
      }
      case 'modality':
        return (
          <div className="option-grid" role="group" aria-label="Modalidad de entrenamiento">
            {MODALITIES.map((m) => (
              <button key={m.value} type="button" className="option onb-option-big" aria-pressed={draft.modality === m.value} onClick={() => edit('modality', { modality: m.value })}>
                <m.icon aria-hidden />
                <span className="onb-option-title">{m.label}</span>
                <span className="small muted">{m.description}</span>
              </button>
            ))}
          </div>
        );
      case 'availability':
        return (
          <AvailabilityEditor
            weekly={draft.weekly}
            onChange={(weekly) => edit('availability', { weekly })}
            callDuration={draft.callDurationMinutes}
            onDuration={(callDurationMinutes) => edit('availability', { callDurationMinutes })}
            timezone={draft.timezone}
            errors={errors}
          />
        );
      case 'qualification': {
        const active = draft.rules.filter((r) => r.enabled).length;
        const setRule = (i: number, patch: Partial<RuleDraft>) => edit('qualification', { rules: draft.rules.map((r, idx) => (idx === i ? { ...r, ...patch } : r)) });
        return (
          <>
            <div className="row-between wrap">
              <span className="muted small">
                {active} de {draft.rules.length} preguntas activas. La importancia de cada una se ajusta más adelante en Setter IA.
              </span>
            </div>
            {errors.rules && <Callout tone="warning">{errors.rules}</Callout>}
            {draft.rules.length === 0 && <Callout tone="info">Todavía no hay preguntas configuradas. Podrás añadirlas más adelante en Setter IA.</Callout>}
            <div className="col gap-12">
              {draft.rules.map((r, i) => (
                <div key={r.key} className={`onb-item ${r.enabled ? '' : 'is-off'}`}>
                  <div className="row-between">
                    <div className="row wrap">
                      <span className="onb-item-title">{r.label.trim() || 'Sin nombre'}</span>
                      {r.required && (
                        <span className="badge badge-accent" title="KAI no considerará cualificado a un lead hasta tener clara esta información.">
                          Imprescindible
                        </span>
                      )}
                    </div>
                    <Switch checked={r.enabled} onChange={(enabled) => setRule(i, { enabled })} label={<span className="sr-only">Preguntar por «{r.label}»</span>} />
                  </div>
                  {r.description && <p className="subtle small mt-4">{r.description}</p>}
                  {r.enabled && (
                    <div className="onb-rule-grid">
                      <Field label="Nombre" htmlFor={`onb-rule-label-${i}`} error={errors[`rules.${i}.label`]}>
                        <Input id={`onb-rule-label-${i}`} value={r.label} maxLength={60} aria-invalid={Boolean(errors[`rules.${i}.label`])} onChange={(e) => setRule(i, { label: e.target.value })} />
                      </Field>
                      <Field label="Cómo lo preguntarías tú" htmlFor={`onb-rule-q-${i}`} error={errors[`rules.${i}.question`]} hint="Una sola pregunta. Déjalo vacío si prefieres que KAI lo deduzca de la conversación.">
                        <Input
                          id={`onb-rule-q-${i}`}
                          value={r.question}
                          maxLength={300}
                          placeholder="Ej.: ¿Qué te gustaría conseguir en los próximos meses?"
                          aria-invalid={Boolean(errors[`rules.${i}.question`])}
                          onChange={(e) => setRule(i, { question: e.target.value })}
                        />
                      </Field>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </>
        );
      }
      case 'objections': {
        const setObj = (i: number, patch: Partial<ObjectionDraft>) => edit('objections', { objections: draft.objections.map((o, idx) => (idx === i ? { ...o, ...patch } : o)) });
        return (
          <>
            <Callout tone="info">KAI nunca presionará al lead ni rebajará el precio por su cuenta. Tu respuesta le sirve de guía para sonar como tú.</Callout>
            {draft.objections.length === 0 && <Callout tone="info">Todavía no hay objeciones configuradas. Podrás añadirlas más adelante en Setter IA.</Callout>}
            <div className="col gap-12">
              {draft.objections.map((o, i) => {
                const err = errors[`objections.${i}.exampleResponse`];
                return (
                  <div key={o.key} className={`onb-item ${o.enabled ? '' : 'is-off'}`}>
                    <div className="row-between">
                      <span className="onb-item-title">«{o.label}»</span>
                      <Switch checked={o.enabled} onChange={(enabled) => setObj(i, { enabled })} label={<span className="sr-only">Gestionar la objeción «{o.label}»</span>} />
                    </div>
                    {o.triggers.length > 0 && (
                      <p className="subtle small mt-4">
                        KAI la reconoce en frases como: {o.triggers.slice(0, 4).map((t) => `«${t}»`).join(', ')}
                        {o.triggers.length > 4 ? '…' : ''}
                      </p>
                    )}
                    {o.enabled && (
                      <div className="mt-12">
                        <Field label="Cómo responderías tú" htmlFor={`onb-obj-${i}`} error={err} hint={`${o.exampleResponse.length}/700 caracteres`}>
                          <Textarea
                            id={`onb-obj-${i}`}
                            rows={3}
                            value={o.exampleResponse}
                            maxLength={700}
                            placeholder="Ej.: Te entiendo, es normal mirarlo. Para ubicarme: ¿con qué lo estás comparando?"
                            aria-invalid={Boolean(err)}
                            onChange={(e) => setObj(i, { exampleResponse: e.target.value })}
                          />
                        </Field>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </>
        );
      }
      case 'tone': {
        const setTone = (patch: Partial<AiTone>) => edit('tone', { tone: { ...draft.tone, ...patch } });
        const result = preview.data;
        return (
          <>
            <Card title="Personalidad" icon={Sparkles}>
              <div className="col gap-16">
                {TONE_SLIDERS.map((s) => (
                  <ToneSlider key={s.key} id={`onb-tone-${s.key}`} label={s.label} hint={s.hint} scale={s.scale} value={draft.tone[s.key]} onChange={(v) => setTone({ [s.key]: v })} />
                ))}
              </div>
            </Card>
            <Card title="Formato de los mensajes" icon={MessageSquareText}>
              <div className="col gap-16">
                <ChoiceGroup
                  label="Emojis"
                  value={draft.tone.emojiUsage}
                  onChange={(emojiUsage) => setTone({ emojiUsage })}
                  options={[
                    { value: 'none', label: 'Ninguno' },
                    { value: 'low', label: 'Pocos' },
                    { value: 'medium', label: 'Algunos' },
                    { value: 'high', label: 'Muchos' },
                  ]}
                />
                <ChoiceGroup
                  label="Longitud de los mensajes"
                  hint="En WhatsApp e Instagram suelen funcionar mejor los mensajes cortos."
                  value={draft.tone.messageLength}
                  onChange={(messageLength) => setTone({ messageLength })}
                  options={[
                    { value: 'short', label: 'Cortos' },
                    { value: 'medium', label: 'Medios' },
                    { value: 'long', label: 'Largos' },
                  ]}
                />
                <ChoiceGroup
                  label="Trato"
                  hint="Cómo se dirige KAI al lead."
                  value={draft.tone.addressing}
                  onChange={(addressing) => setTone({ addressing })}
                  options={[
                    { value: 'tu', label: 'De tú' },
                    { value: 'usted', label: 'De usted' },
                  ]}
                />
              </div>
            </Card>
            <Card title="Vocabulario" icon={ListChecks}>
              <div className="grid-2">
                <div className="field" role="group" aria-labelledby="onb-words-use">
                  <span className="label" id="onb-words-use">
                    Palabras o expresiones que sueles usar
                  </span>
                  <TagInput value={draft.wordsToUse} onChange={(wordsToUse) => edit('tone', { wordsToUse })} placeholder="Ej.: a tu ritmo" />
                  {errors.wordsToUse ? <span className="error-text">{errors.wordsToUse}</span> : <span className="hint">Escribe y pulsa Enter para añadir cada una.</span>}
                </div>
                <div className="field" role="group" aria-labelledby="onb-words-avoid">
                  <span className="label" id="onb-words-avoid">
                    Palabras que nunca usarías
                  </span>
                  <TagInput value={draft.wordsToAvoid} onChange={(wordsToAvoid) => edit('tone', { wordsToAvoid })} placeholder="Ej.: dieta milagro" />
                  {errors.wordsToAvoid ? <span className="error-text">{errors.wordsToAvoid}</span> : <span className="hint">KAI las evitará siempre.</span>}
                </div>
              </div>
            </Card>
            <Card title="Ejemplos de cómo escribes" icon={MessageSquareText}>
              <p className="muted small" style={{ marginBottom: 12 }}>
                Pega algunos mensajes reales que hayas enviado tú a posibles clientes. KAI los usa para imitar tu forma de escribir (no los copia tal cual). Quita los datos personales de otras personas antes de pegarlos.
              </p>
              <div className="col gap-16">
                <div className="grid-2">
                  <Field
                    label={
                      <span className="row gap-4">
                        <WhatsAppIcon /> Mensajes de WhatsApp
                      </span>
                    }
                    htmlFor="onb-ex-wa"
                    error={errors.examplesWhatsapp}
                  >
                    <Textarea
                      id="onb-ex-wa"
                      rows={6}
                      value={draft.examplesWhatsapp}
                      maxLength={6000}
                      placeholder={'Ej.:\n¡Hola, Marta! Gracias por escribirme. Cuéntame, ¿qué te gustaría conseguir?'}
                      onChange={(e) => edit('tone', { examplesWhatsapp: e.target.value })}
                    />
                  </Field>
                  <Field
                    label={
                      <span className="row gap-4">
                        <InstagramIcon /> Mensajes de Instagram
                      </span>
                    }
                    htmlFor="onb-ex-ig"
                    error={errors.examplesInstagram}
                  >
                    <Textarea
                      id="onb-ex-ig"
                      rows={6}
                      value={draft.examplesInstagram}
                      maxLength={6000}
                      placeholder={'Ej.:\n¡Hola! Vi que te interesó la publicación sobre perder grasa sin pasar hambre. ¿Qué es lo que más te cuesta ahora mismo?'}
                      onChange={(e) => edit('tone', { examplesInstagram: e.target.value })}
                    />
                  </Field>
                </div>
                <Field
                  label="Otros ejemplos de conversaciones (opcional)"
                  htmlFor="onb-ex-other"
                  error={errors.examplesOther}
                  hint="Conversaciones de otros canales (email, formularios, llamadas…) o respuestas tuyas que te gusten especialmente."
                >
                  <Textarea
                    id="onb-ex-other"
                    rows={4}
                    value={draft.examplesOther}
                    maxLength={6000}
                    placeholder={'Ej.:\nLead: ¿Y esto es para mí si nunca he entrenado?\nYo: Claro que sí. Empezamos desde tu punto de partida y vamos subiendo poco a poco. ¿Qué te ha frenado hasta ahora?'}
                    onChange={(e) => edit('tone', { examplesOther: e.target.value })}
                  />
                </Field>
              </div>
            </Card>
            <div className="grid-2">
              <Field
                label="Nombre del asistente"
                htmlFor="onb-assistant"
                error={errors.assistantName}
                hint="Si un lead pregunta, KAI siempre reconocerá que es un asistente automatizado de tu equipo."
              >
                <Input id="onb-assistant" value={draft.assistantName} maxLength={40} placeholder="Ej.: KAI" aria-invalid={Boolean(errors.assistantName)} onChange={(e) => edit('tone', { assistantName: e.target.value })} />
              </Field>
            </div>
            <Card title="Así sonaría KAI" icon={Sparkles}>
              <p className="muted small" style={{ marginBottom: 12 }}>
                Escribe un mensaje como si fueras un lead y mira cómo respondería KAI. Para generar el ejemplo guardamos antes tu configuración de tono. No se envía nada a nadie.
              </p>
              <div className="onb-preview-input">
                <Field label="Mensaje del lead" htmlFor="onb-preview-msg">
                  <Input
                    id="onb-preview-msg"
                    value={leadMessage}
                    maxLength={500}
                    onChange={(e) => setLeadMessage(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        preview.mutate();
                      }
                    }}
                  />
                </Field>
                <Button icon={Sparkles} loading={preview.isPending} onClick={() => preview.mutate()}>
                  {result ? 'Generar otro ejemplo' : 'Ver ejemplo'}
                </Button>
              </div>
              <div className="mt-16" aria-live="polite">
                {preview.isPending && (
                  <div className="row muted small">
                    <Spinner size={16} /> KAI está escribiendo…
                  </div>
                )}
                {!preview.isPending && previewLimit && (
                  <Callout tone="warning">
                    {previewLimit} El ejemplo es opcional: puedes seguir configurando KAI sin él.
                  </Callout>
                )}
                {!preview.isPending && result && (
                  <div className="col gap-12">
                    <div className="phone">
                      <div className="msg-row in">
                        <div className="bubble">{result.leadMessage}</div>
                      </div>
                      {result.reply ? (
                        <div className="msg-row out kai">
                          <div className="bubble">{result.reply}</div>
                          <div className="msg-meta">{draft.assistantName.trim() || 'KAI'}</div>
                        </div>
                      ) : (
                        <p className="subtle small" style={{ alignSelf: 'center' }}>
                          Sin respuesta
                        </p>
                      )}
                    </div>
                    {!result.reply && (
                      <Callout tone="warning">
                        KAI no ha podido generar una respuesta segura con esta configuración. En una conversación real te pasaría la conversación a ti.
                        {result.issues.length > 0 && (
                          <ul className="small" style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                            {result.issues.map((issue, idx) => (
                              <li key={idx}>{issue}</li>
                            ))}
                          </ul>
                        )}
                      </Callout>
                    )}
                    {result.engine === 'rules' && (
                      <p className="subtle xs">Ejemplo generado en modo simulación (sin inteligencia artificial externa): el estilo final puede variar.</p>
                    )}
                  </div>
                )}
              </div>
            </Card>
          </>
        );
      }
      case 'channels': {
        const data = integrations.data;
        const list = data?.channels ?? [];
        const metaReady = data?.server.meta ?? true;
        return (
          <>
            {integrations.isLoading && (
              <div className="row muted small">
                <Spinner size={16} /> Comprobando tus conexiones…
              </div>
            )}
            {integrations.isError && (
              <Callout tone="warning">
                No hemos podido comprobar el estado de tus conexiones. Puedes seguir igualmente y revisarlo después en Integraciones.
              </Callout>
            )}
            {data && !metaReady && (
              <Callout tone="warning">La conexión con Meta (la empresa de WhatsApp, Instagram y Facebook) todavía no está activada en esta instalación de KAI. Puedes seguir y conectarlo más adelante.</Callout>
            )}
            <ConnectCard icon={<WhatsAppIcon size={20} />} title="WhatsApp" state={<ConnBadge state={channelState(list.filter((c) => c.channel === 'whatsapp'))} />}>
              KAI responde a los mensajes que recibes en tu número de WhatsApp Business (la versión de WhatsApp para empresas). En Integraciones verás qué datos necesitas para conectarlo.
            </ConnectCard>
            <ConnectCard icon={<InstagramIcon size={20} />} title="Instagram" state={<ConnBadge state={channelState(list.filter((c) => c.channel === 'instagram'))} />}>
              KAI contesta los mensajes directos (DM) que llegan a tu cuenta de Instagram. Tu cuenta debe ser profesional (de empresa o de creador).
            </ConnectCard>
            <ConnectCard icon={<Megaphone />} title="Anuncios de Meta (Lead Ads)" state={<ConnBadge state={channelState(list.filter((c) => c.channel === 'meta_lead_ads'))} />}>
              Si haces anuncios con formulario en Facebook o Instagram (en los que la persona deja sus datos sin salir de la app), esos contactos entran solos en KAI y KAI puede escribirles por WhatsApp.
            </ConnectCard>
            <ConnectCard icon={<ClipboardList />} title="Formularios de tu web" state={<ConnBadge state="available" />}>
              Si tienes una web o página de captación con formulario, los contactos pueden llegar directamente a KAI. Es un ajuste de una sola vez: en Integraciones encontrarás la dirección que hay que pegar en tu formulario (o que puedes pasar a quien te lleve la web).
            </ConnectCard>
            <div className="row wrap">
              <a className="btn btn-primary" href="/app/integraciones" target="_blank" rel="noopener noreferrer">
                <ExternalLink aria-hidden />
                Abrir Integraciones
                <span className="sr-only"> (se abre en una pestaña nueva)</span>
              </a>
              <Button variant="ghost" icon={RefreshCw} loading={integrations.isFetching} onClick={() => void integrations.refetch()}>
                Comprobar de nuevo
              </Button>
            </div>
            <Callout tone="accent" icon={FlaskConical}>
              No hace falta conectar nada para probar a KAI: al terminar podrás hablar con él en el simulador como si fueras un lead.
            </Callout>
          </>
        );
      }
      case 'calendar': {
        const data = integrations.data;
        const cals = data?.calendars ?? [];
        const google = cals.filter((c) => c.provider === 'google');
        const calendly = cals.filter((c) => c.provider === 'calendly');
        const external = [...google, ...calendly].some((c) => c.status === 'connected');
        const googleState = channelState(google);
        return (
          <>
            {integrations.isLoading && (
              <div className="row muted small">
                <Spinner size={16} /> Comprobando tus conexiones…
              </div>
            )}
            {integrations.isError && <Callout tone="warning">No hemos podido comprobar el estado de tu calendario. Puedes seguir igualmente y revisarlo después en Integraciones.</Callout>}
            <ConnectCard
              icon={<CalendarDays />}
              title="Google Calendar"
              state={<ConnBadge state={googleState === 'none' && data && !data.server.google ? 'unavailable' : googleState} />}
            >
              KAI consulta las horas que tienes ocupadas en tu Google Calendar para no proponer llamadas encima de otros compromisos, y apunta allí las llamadas que agenda.
            </ConnectCard>
            <ConnectCard icon={<CalendarCheck />} title="Calendly" state={<ConnBadge state={channelState(calendly)} />}>
              Si ya usas Calendly, KAI ofrecerá los huecos libres de tu Calendly y enviará al lead el enlace para confirmar la reserva. En ese caso se usarán los horarios de Calendly en lugar de los del paso «Disponibilidad».
            </ConnectCard>
            <ConnectCard
              icon={<CalendarClock />}
              title="Agenda de KAI"
              state={external ? <span className="badge badge-dot">Incluida</span> : <span className="badge badge-accent badge-dot">En uso</span>}
            >
              No necesitas conectar nada: KAI usa la disponibilidad que has indicado y guarda las llamadas en su propia agenda. Puedes empezar así y conectar tu calendario más adelante.
            </ConnectCard>
            <div className="row wrap">
              <a className="btn btn-primary" href="/app/integraciones" target="_blank" rel="noopener noreferrer">
                <ExternalLink aria-hidden />
                Abrir Integraciones
                <span className="sr-only"> (se abre en una pestaña nueva)</span>
              </a>
              <Button variant="ghost" icon={RefreshCw} loading={integrations.isFetching} onClick={() => void integrations.refetch()}>
                Comprobar de nuevo
              </Button>
            </div>
          </>
        );
      }
    }
  };

  const StepIcon = current.icon;

  return (
    <div className="wizard">
      <aside className="wizard-steps" aria-label="Pasos de la configuración">
        <div className="onb-sidebar-head">
          <Logo to="/app" />
          <div>
            <div style={{ fontWeight: 650 }}>Configuración inicial</div>
            <div className="subtle small">Podrás cambiarlo todo más adelante.</div>
          </div>
        </div>
        <ol className="onb-steps-list">
          {STEPS.map((s, i) => {
            const n = i + 1;
            const isCurrent = n === step;
            const done = !isCurrent && n < maxReached;
            const reachable = n <= maxReached;
            return (
              <li key={s.key}>
                <button
                  type="button"
                  className={`wizard-step ${isCurrent ? 'current' : ''} ${done ? 'done' : ''}`}
                  aria-current={isCurrent ? 'step' : undefined}
                  disabled={!reachable || busy}
                  onClick={() => void navigateTo(n)}
                >
                  <span className="n" aria-hidden>
                    {n}
                  </span>
                  <span className="grow">{s.title}</span>
                  {done && <span className="sr-only">(completado)</span>}
                </button>
              </li>
            );
          })}
        </ol>
        <div className="onb-sidebar-foot">
          {me?.user?.email && <span className="subtle xs ellipsis">{me.user.email}</span>}
          <button type="button" className="onb-link" onClick={() => void logout()}>
            <LogOut aria-hidden />
            Cerrar sesión
          </button>
        </div>
      </aside>

      <main className="wizard-body onb-body">
        <div className="onb-mobile-bar">
          <div className="row-between">
            <Logo to="/app" size={26} />
            <button type="button" className="onb-link" onClick={() => void logout()}>
              <LogOut aria-hidden />
              Cerrar sesión
            </button>
          </div>
          <Select
            aria-label="Ir a otro paso"
            value={String(step)}
            disabled={busy}
            onChange={(e) => void navigateTo(Number(e.target.value))}
            options={STEPS.map((s, i) => ({ value: String(i + 1), label: `${i + 1}. ${s.title}${i + 1 > maxReached ? ' (pendiente)' : ''}` }))}
          />
        </div>

        <div className="wizard-progress" role="progressbar" aria-label="Progreso de la configuración" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}>
          <div style={{ width: `${progress}%` }} />
        </div>

        {alreadyDone && (
          <div style={{ marginBottom: 20 }}>
            <Callout tone="info">
              Ya completaste esta configuración. Puedes revisarla y cambiar lo que quieras: cada paso se guarda al pulsar «Continuar». <Link to="/app">Volver a mi panel</Link>
            </Callout>
          </div>
        )}

        <form onSubmit={onSubmit} noValidate>
          <span className="onb-eyebrow">
            <StepIcon aria-hidden />
            Paso {step} de {TOTAL} · {current.title}
          </span>
          <h1 className="onb-heading" ref={headingRef} tabIndex={-1}>
            {current.heading}
          </h1>
          <p className="onb-lead">{current.description}</p>

          <div className="onb-content">{renderStep()}</div>

          <div className="onb-actions">
            <Button className="onb-back" icon={ArrowLeft} onClick={() => void navigateTo(step - 1)} disabled={step === 1 || busy}>
              <span className="onb-back-label">Atrás</span>
            </Button>
            <div className="onb-actions-right">
              {(current.key === 'channels' || current.key === 'calendar') && (
                <Button variant="ghost" disabled={busy} onClick={() => void next()}>
                  Lo haré más tarde
                </Button>
              )}
              <Button type="submit" variant="primary" loading={busy}>
                {isLast ? 'Terminar configuración' : 'Continuar'}
                {!busy && <ArrowRight aria-hidden />}
              </Button>
            </div>
          </div>
        </form>
      </main>
    </div>
  );
}

export default function Onboarding() {
  const { activeBusiness } = useAuth();
  const navigate = useNavigate();
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => api.get<SettingsResponse>('/settings') });

  if (activeBusiness && activeBusiness.role !== 'trainer') {
    return (
      <main className="onb-done">
        <div className="onb-done-card">
          <Logo to="/app" />
          <h1 style={{ fontSize: 24 }}>La configuración inicial la completa el entrenador</h1>
          <p className="muted">Solo la persona titular del negocio puede completar estos pasos. Mientras tanto, puedes trabajar con normalidad desde el panel.</p>
          <Button variant="primary" icon={LayoutDashboard} onClick={() => navigate('/app')}>
            Ir al panel
          </Button>
        </div>
      </main>
    );
  }

  if (settings.isError && !settings.data) {
    return (
      <main className="onb-done">
        <div className="onb-done-card">
          <Logo to="/app" />
          <Callout tone="danger">No hemos podido cargar tu configuración: {errorText(settings.error)}</Callout>
          <Button icon={RefreshCw} loading={settings.isFetching} onClick={() => void settings.refetch()}>
            Reintentar
          </Button>
        </div>
      </main>
    );
  }

  if (!settings.data) return <PageLoading />;
  return <Wizard settings={settings.data} />;
}
