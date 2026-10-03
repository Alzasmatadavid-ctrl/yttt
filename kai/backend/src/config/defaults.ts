/**
 * Plantillas iniciales que se copian a cada negocio nuevo.
 * Después, el entrenador lo edita todo desde la interfaz: nada de esto queda fijo en la lógica.
 */
import type {
  AutomationConfig,
  AutomationType,
  AvailabilityWeek,
  HandoffRules,
  PlanLimits,
  StandardQualificationKey,
} from '../lib/domain.js';

export interface QualificationTemplate {
  key: StandardQualificationKey;
  label: string;
  description: string;
  question: string;
  weight: number;
  required: boolean;
  disqualifyWhen?: string;
}

/** Pesos por defecto: suman 100. */
export const DEFAULT_QUALIFICATION_RULES: QualificationTemplate[] = [
  {
    key: 'goal',
    label: 'Objetivo',
    description: 'Qué quiere conseguir exactamente (perder grasa, ganar músculo, mejorar salud…).',
    question: '¿Qué te gustaría conseguir exactamente?',
    weight: 10,
    required: true,
  },
  {
    key: 'current_situation',
    label: 'Situación actual',
    description: 'Cómo está ahora: entrenamiento, alimentación, rutina, trabajo.',
    question: '¿Cómo es tu día a día ahora mismo con el entrenamiento y la comida?',
    weight: 6,
    required: false,
  },
  {
    key: 'problem',
    label: 'Problema',
    description: 'Por qué no lo está consiguiendo ahora.',
    question: '¿Y qué crees que te está impidiendo conseguirlo ahora?',
    weight: 10,
    required: true,
  },
  {
    key: 'motivation',
    label: 'Motivación',
    description: 'Por qué quiere conseguirlo (el motivo profundo).',
    question: '¿Por qué es importante para ti conseguirlo?',
    weight: 12,
    required: true,
  },
  {
    key: 'previous_attempts',
    label: 'Intentos anteriores',
    description: 'Qué ha probado antes (dietas, gimnasio, apps, otros entrenadores).',
    question: '¿Qué has probado hasta ahora?',
    weight: 6,
    required: false,
  },
  {
    key: 'frustration',
    label: 'Frustración',
    description: 'Qué le ha fallado o qué le frustra de lo que ha probado.',
    question: '¿Qué es lo que más te ha frustrado de lo que has probado?',
    weight: 6,
    required: false,
  },
  {
    key: 'urgency',
    label: 'Urgencia',
    description: 'Por qué ahora; si hay una fecha o evento.',
    question: '¿Por qué ahora? ¿Hay alguna fecha o algo que te haga querer empezar ya?',
    weight: 14,
    required: false,
  },
  {
    key: 'commitment',
    label: 'Compromiso',
    description: 'Si está dispuesto a actuar y dedicar tiempo de verdad.',
    question: 'Si encontraras la forma de hacerlo, ¿estarías dispuesto a comprometerte de verdad unos meses?',
    weight: 14,
    required: false,
  },
  {
    key: 'budget',
    label: 'Capacidad de inversión',
    description: 'Si puede invertir en una solución profesional.',
    question: '¿Te planteas invertir en un acompañamiento profesional para conseguirlo?',
    weight: 12,
    required: false,
  },
  {
    key: 'fit',
    label: 'Encaje',
    description: 'Si el servicio del entrenador realmente puede ayudarle.',
    question: '',
    weight: 10,
    required: false,
    disqualifyWhen: 'Es menor de edad, busca algo que el servicio no ofrece o necesita tratamiento médico antes de entrenar.',
  },
];

export interface ObjectionTemplate {
  key: string;
  label: string;
  triggers: string[];
  strategy: string;
  exampleResponse: string;
}

export const DEFAULT_OBJECTIONS: ObjectionTemplate[] = [
  {
    key: 'expensive',
    label: 'Es caro',
    triggers: ['caro', 'mucho dinero', 'se me va de precio', 'no me lo puedo permitir'],
    strategy:
      'Validar sin discutir. Preguntar con qué lo está comparando y cuánto le está costando seguir igual. Recordar qué incluye. Nunca rebajar el precio por iniciativa propia.',
    exampleResponse:
      'Te entiendo, es normal mirarlo. Para ubicarme: ¿con qué lo estás comparando?',
  },
  {
    key: 'think_about_it',
    label: 'Me lo tengo que pensar',
    triggers: ['pensarlo', 'pensármelo', 'lo pienso', 'tengo que pensar', 'lo pensaré', 'déjame pensarlo', 'ya te digo'],
    strategy:
      'Validar. Preguntar qué parte concreta le genera dudas para poder resolverla. Sin presión ni ultimátums.',
    exampleResponse: 'Claro, tiene todo el sentido. ¿Hay algo concreto que te genere dudas y que te pueda aclarar?',
  },
  {
    key: 'no_time',
    label: 'Ahora no tengo tiempo',
    triggers: ['no tengo tiempo', 'muy liado', 'mucho trabajo', 'ahora no puedo'],
    strategy:
      'Validar y entender su agenda real. Explicar (solo si es cierto según el servicio) que el plan se adapta al tiempo disponible. Preguntar cuánto tiempo podría dedicar.',
    exampleResponse: 'Lo entiendo, con poco tiempo es cuando más hay que organizarse bien. ¿Cuántos días a la semana podrías sacar aunque fuera un rato?',
  },
  {
    key: 'no_money',
    label: 'No tengo dinero',
    triggers: ['no tengo dinero', 'no me llega', 'estoy sin dinero', 'ahora mismo no puedo pagar'],
    strategy:
      'Respetar la situación. No insistir. Ofrecer mantener el contacto o recursos gratuitos si existen. Puede no ser el momento.',
    exampleResponse: 'Lo entiendo perfectamente, y es mejor ser honestos con eso. Si quieres, seguimos en contacto y lo retomamos cuando te encaje mejor.',
  },
  {
    key: 'partner',
    label: 'Lo tengo que consultar con mi pareja',
    triggers: ['mi pareja', 'mi mujer', 'mi marido', 'mi novia', 'mi novio', 'consultarlo'],
    strategy:
      'Validar. Ofrecer que la pareja esté presente en la llamada o preguntar qué crees que le preocuparía a su pareja.',
    exampleResponse: 'Me parece muy bien que lo habléis. Si quieres, puede estar también en la llamada y así resolvéis las dudas juntos. ¿Te encajaría?',
  },
  {
    key: 'has_trainer',
    label: 'Ya tengo entrenador',
    triggers: ['ya tengo entrenador', 'ya entreno con alguien', 'tengo un entrenador'],
    strategy:
      'Respetar. Preguntar si está consiguiendo los resultados que quiere. Si está contento, cerrar con amabilidad.',
    exampleResponse: '¡Genial que ya tengas a alguien! ¿Estás consiguiendo los resultados que buscas con él?',
  },
  {
    key: 'diy',
    label: 'Lo quiero probar por mi cuenta',
    triggers: ['por mi cuenta', 'solo', 'yo solo', 'probar primero'],
    strategy:
      'Validar la autonomía. Preguntar cuánto tiempo lleva intentándolo solo y qué resultado ha tenido.',
    exampleResponse: 'Es totalmente válido. ¿Cuánto tiempo llevas intentándolo por tu cuenta y qué tal te ha ido?',
  },
  {
    key: 'tried_everything',
    label: 'Ya he probado muchas cosas',
    triggers: ['he probado de todo', 'ya he probado', 'nada me funciona', 'nada funciona'],
    strategy:
      'Validar la frustración. Preguntar qué crees que falló en esos intentos. Explicar la diferencia del método SOLO con datos reales del perfil.',
    exampleResponse: 'Es muy frustrante, lo entiendo. De todo lo que probaste, ¿qué crees que hizo que no funcionara a largo plazo?',
  },
  {
    key: 'will_it_work',
    label: 'No sé si esto funcionará conmigo',
    triggers: ['funcionara conmigo', 'funcionará conmigo', 'no se si me sirve', 'mi caso es diferente'],
    strategy:
      'Validar la duda. Nunca garantizar resultados. Proponer la llamada precisamente para valorar si encaja.',
    exampleResponse: 'Es una duda muy lógica, y no te voy a prometer nada sin conocer tu caso. Precisamente para eso está la llamada: ver si encaja contigo o no.',
  },
];

export const DEFAULT_HANDOFF_RULES: HandoffRules = {
  angry: true,
  medical: true,
  humanRequest: true,
  complexNegotiation: true,
  outOfScope: true,
  technicalIssue: true,
  handoffMessage: '',
};

export const DEFAULT_AVAILABILITY: AvailabilityWeek = {
  '1': [
    { start: '10:00', end: '14:00' },
    { start: '17:00', end: '20:00' },
  ],
  '2': [
    { start: '10:00', end: '14:00' },
    { start: '17:00', end: '20:00' },
  ],
  '3': [
    { start: '10:00', end: '14:00' },
    { start: '17:00', end: '20:00' },
  ],
  '4': [
    { start: '10:00', end: '14:00' },
    { start: '17:00', end: '20:00' },
  ],
  '5': [{ start: '10:00', end: '14:00' }],
  '6': [],
  '7': [],
};

export const DEFAULT_AUTOMATIONS: { type: AutomationType; name: string; config: AutomationConfig }[] = [
  {
    type: 'followup_no_reply',
    name: 'Seguimiento sin respuesta',
    config: {
      steps: [
        { delayHours: 4, angle: 'Retomar la conversación conectando con lo último que dijo el lead.' },
        { delayHours: 24, angle: 'Aportar algo útil relacionado con su objetivo o problema concreto.' },
        { delayHours: 72, angle: 'Cierre amable: dejar la puerta abierta sin presionar.' },
      ],
      quietHours: { start: '21:30', end: '09:00' },
    },
  },
  {
    type: 'appointment_reminders',
    name: 'Confirmación y recordatorios',
    config: { confirmation: true, reminder24h: true, reminder1h: true, quietHours: { start: '22:00', end: '08:30' } },
  },
  {
    type: 'no_show_recovery',
    name: 'Recuperar no presentados',
    config: { delayMinutes: 15, quietHours: { start: '21:30', end: '09:00' } },
  },
  {
    type: 'post_call',
    name: 'Registrar resultado de la llamada',
    config: { delayMinutes: 10 },
  },
];

export interface PlanTemplate {
  key: string;
  name: string;
  description: string;
  priceMonthlyCents: number;
  sortOrder: number;
  limits: PlanLimits;
}

/** Planes iniciales. El propietario del SaaS los edita desde /admin. */
export const DEFAULT_PLANS: PlanTemplate[] = [
  {
    key: 'starter',
    name: 'KAI Starter',
    description: 'Para entrenadores que empiezan a recibir leads de forma constante.',
    priceMonthlyCents: 9700,
    sortOrder: 1,
    limits: {
      maxLeadsPerMonth: 150,
      maxAiMessagesPerMonth: 3000,
      maxTeamMembers: 1,
      maxChannels: 2,
      maxBusinesses: 1,
      copilot: true,
      advancedAnalytics: false,
    },
  },
  {
    key: 'pro',
    name: 'KAI Pro',
    description: 'Para entrenadores con anuncios activos y un volumen alto de conversaciones.',
    priceMonthlyCents: 19700,
    sortOrder: 2,
    limits: {
      maxLeadsPerMonth: 600,
      maxAiMessagesPerMonth: 12000,
      maxTeamMembers: 3,
      maxChannels: 4,
      maxBusinesses: 1,
      copilot: true,
      advancedAnalytics: true,
    },
  },
  {
    key: 'agency',
    name: 'KAI Agency',
    description: 'Para equipos y agencias que gestionan varios entrenadores.',
    priceMonthlyCents: 49700,
    sortOrder: 3,
    limits: {
      maxLeadsPerMonth: null,
      maxAiMessagesPerMonth: 60000,
      maxTeamMembers: 15,
      maxChannels: null,
      maxBusinesses: 10,
      copilot: true,
      advancedAnalytics: true,
    },
  },
];

export const DEFAULT_PLAN_KEY = 'starter';
export const TRIAL_DAYS = 14;
