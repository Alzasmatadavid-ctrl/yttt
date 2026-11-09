/*
 * Landing pública de KAI.
 * Estilos en styles/landing.css (importado desde main.tsx); todas sus reglas cuelgan de .landing.
 * Sin imágenes externas, sin testimonios ni cifras inventadas: solo CSS/SVG y datos reales (planes de la API).
 */
import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type MouseEvent, type ReactNode } from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowDown,
  ArrowRight,
  BadgeEuro,
  Ban,
  BellRing,
  Bot,
  BotMessageSquare,
  CalendarCheck,
  CalendarDays,
  CalendarX,
  ChartColumn,
  Check,
  ChevronDown,
  Clock,
  Dumbbell,
  FlaskConical,
  Globe,
  HandHelping,
  Hourglass,
  Inbox,
  Info,
  ListChecks,
  Megaphone,
  MessageCircle,
  MessageSquareOff,
  MessagesSquare,
  Minus,
  PhoneCall,
  Plug,
  ShieldCheck,
  SlidersHorizontal,
  Snowflake,
  Sparkles,
  SquareKanban,
  Stethoscope,
  Thermometer,
  type LucideIcon,
} from 'lucide-react';
import { formatMoney, type PlanLimits } from '@shared';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Logo, LogoMark } from '../components/brand';
import { InstagramIcon, WhatsAppIcon } from '../components/lead-bits';

/** Respuesta de GET /api/public/plans. */
interface PublicPlan {
  key: string;
  name: string;
  description: string;
  priceMonthlyCents: number;
  currency: string;
  limits: PlanLimits;
}

/** Permite pasar variables CSS (--i, --d, --w) en `style` con tipos correctos. */
const cssVars = (vars: Record<string, string | number>) => vars as CSSProperties;

function prefersReducedMotion() {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** Desplaza hasta una sección y le pasa el foco (útil con teclado y lectores de pantalla). */
function scrollToSection(id: string) {
  const el = document.getElementById(id);
  if (!el) return;
  el.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'start' });
  el.focus({ preventScroll: true });
  window.history.replaceState(window.history.state, '', `#${id}`);
}

function SectionLink({ to, className, children }: { to: string; className?: string; children: ReactNode }) {
  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    scrollToSection(to);
  };
  return (
    <a href={`#${to}`} className={className} onClick={onClick}>
      {children}
    </a>
  );
}

function useScrolled(offset = 8) {
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > offset);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, [offset]);
  return scrolled;
}

// ───────────── Contenido ─────────────

const FLOW: { label: string; caption: string; icon?: LucideIcon; kind?: 'kai' | 'goal' }[] = [
  { label: 'Lead', caption: 'Te escribe por Instagram, WhatsApp o desde un anuncio', icon: MessageCircle },
  { label: 'KAI', caption: 'Responde con tu tono y solo con tu información', kind: 'kai' },
  { label: 'Cualificación', caption: 'Una pregunta cada vez para saber si encaja contigo', icon: ListChecks },
  { label: 'Agenda', caption: 'Propone huecos libres de tu calendario', icon: CalendarCheck },
  { label: 'Llamada', caption: 'Confirmación y recordatorios antes de la cita', icon: PhoneCall },
  { label: 'Cliente', caption: 'Tú cierras la venta y empezáis a entrenar', icon: Dumbbell, kind: 'goal' },
];

const PAINS: { icon: LucideIcon; title: string; text: string; fix: string }[] = [
  {
    icon: Snowflake,
    title: 'Leads que se enfrían',
    text: 'Alguien te escribe con ganas a las once de la noche y le respondes al día siguiente. Para entonces, ya no tiene la misma intención.',
    fix: 'KAI contesta aunque estés entrenando, de noche o en fin de semana.',
  },
  {
    icon: MessageSquareOff,
    title: 'Mensajes sin responder',
    text: 'Entre sesiones, Instagram y WhatsApp, algunos mensajes se quedan por el camino y nadie los contesta.',
    fix: 'Todas las conversaciones llegan a una sola bandeja y KAI atiende cada una.',
  },
  {
    icon: Hourglass,
    title: 'Seguimientos olvidados',
    text: 'El lead que dijo «me lo pienso» no vuelve a escribir, y tú no tienes tiempo de acordarte de retomarlo.',
    fix: 'KAI retoma la conversación de forma automática cuando un lead deja de responder.',
  },
  {
    icon: CalendarX,
    title: 'Citas perdidas',
    text: 'Se agenda una llamada y la persona no aparece, o ni siquiera se acordaba de ella.',
    fix: 'Confirmación y recordatorios antes de la llamada, y un intento de recuperar a quien no se presentó.',
  },
  {
    icon: Thermometer,
    title: 'No saber quién está caliente',
    text: 'Tienes muchas conversaciones abiertas y no sabes a quién dedicar tu tiempo primero.',
    fix: 'Cada lead tiene una temperatura y una puntuación según lo que ha contado, para que sepas a quién atender antes.',
  },
];

const STEPS: { icon: LucideIcon; title: string; text: string }[] = [
  {
    icon: Plug,
    title: 'Conecta tus canales',
    text: 'WhatsApp, Instagram, tus anuncios de Meta y los formularios de tu web. Todos los mensajes llegan al mismo sitio.',
  },
  {
    icon: SlidersHorizontal,
    title: 'Cuéntale cómo trabajas',
    text: 'Qué ofreces, a quién ayudas, tus precios reales, tu disponibilidad y cómo hablas. KAI solo usa esa información.',
  },
  {
    icon: MessagesSquare,
    title: 'KAI conversa y cualifica',
    text: 'Responde a cada lead, hace una pregunta cada vez y detecta quién encaja de verdad con tu servicio.',
  },
  {
    icon: CalendarCheck,
    title: 'Agenda la llamada y tú cierras',
    text: 'Propone huecos libres, reserva la llamada y envía recordatorios. Tú llegas con todo el contexto del lead.',
  },
];

const FEATURES: { icon: LucideIcon; title: string; text: string; wide?: boolean; accent?: boolean; extra?: 'tags' | 'funnel' }[] = [
  {
    icon: Bot,
    title: 'Setter IA',
    text: 'Un setter es la persona que atiende a los interesados y les agenda una llamada contigo. KAI hace ese trabajo por WhatsApp e Instagram: conversa con tu tono, cualifica con tus criterios y propone la llamada cuando tiene sentido.',
    wide: true,
    accent: true,
    extra: 'tags',
  },
  {
    icon: Inbox,
    title: 'Bandeja unificada',
    text: 'Todas tus conversaciones en un solo sitio. Ves lo que ha respondido KAI y puedes escribir tú cuando quieras: KAI se aparta en esa conversación.',
  },
  {
    icon: SquareKanban,
    title: 'CRM y pipeline',
    text: 'Cada lead con su etapa, su temperatura y su historial. El pipeline es tu embudo de ventas: ves en qué punto está cada persona y la mueves con un gesto.',
  },
  {
    icon: CalendarDays,
    title: 'Agenda conectada',
    text: 'Define tu disponibilidad en KAI o conecta Google Calendar o Calendly. KAI solo ofrece huecos que están libres.',
  },
  {
    icon: BellRing,
    title: 'Seguimientos y recordatorios',
    text: 'Retoma conversaciones que se quedan a medias, confirma las llamadas, envía recordatorios e intenta recuperar a quien no se presentó, respetando tus horas de descanso.',
  },
  {
    icon: Sparkles,
    title: 'KAI Copilot',
    text: 'Tu asistente interno. Pregúntale «¿a quién debería responder ahora?» o pídele que ajuste el tono de KAI. Consulta tus datos reales y te pide confirmación antes de cualquier cambio importante.',
  },
  {
    icon: ChartColumn,
    title: 'Métricas y ROI',
    text: 'Embudo de conversión, tiempo de primera respuesta y origen de tus leads. El ROI (retorno de la inversión) compara lo que ingresas por clientes cerrados con lo que inviertes en KAI y en anuncios.',
    wide: true,
    extra: 'funnel',
  },
];

const SETTER_TAGS = ['Tu tono', 'Tus precios reales', 'Tus criterios de cualificación', 'Respuestas a objeciones'];
const FUNNEL_STAGES = ['Leads', 'Conversaciones', 'Cualificados', 'Llamadas', 'Clientes'];

const FAIR: { icon: LucideIcon; title: string; text: string }[] = [
  {
    icon: BadgeEuro,
    title: 'No inventa precios ni horarios',
    text: 'Solo usa los precios que tú configuras y los huecos que están libres en tu agenda. Si no sabe algo, lo dice.',
  },
  {
    icon: Ban,
    title: 'No promete resultados',
    text: 'Nada de «pierde 10 kilos en un mes». Habla de proceso y acompañamiento, nunca de resultados garantizados.',
  },
  {
    icon: Stethoscope,
    title: 'No diagnostica',
    text: 'Ante una cuestión de salud, recomienda consultarla con un profesional sanitario y no da consejos médicos.',
  },
  {
    icon: HandHelping,
    title: 'Te pasa la conversación cuando hace falta',
    text: 'Si alguien pide hablar contigo, está molesto o plantea algo delicado, KAI se detiene y te avisa para que sigas tú.',
  },
  {
    icon: BotMessageSquare,
    title: 'Se presenta como asistente',
    text: 'Puede presentarse como tu asistente desde el primer mensaje y, si le preguntan si es una IA, nunca lo niega.',
  },
  {
    icon: ShieldCheck,
    title: 'Sin presión ni falsas urgencias',
    text: 'Nada de «últimas plazas» inventadas ni testimonios que no existen. Si alguien no quiere seguir, lo respeta.',
  },
];

const INTEGRATIONS: { name: string; text: string; logo: ReactNode }[] = [
  { name: 'WhatsApp', text: 'WhatsApp Business, con la conexión oficial de Meta para empresas.', logo: <WhatsAppIcon size={24} /> },
  { name: 'Instagram', text: 'Mensajes directos de tu cuenta profesional de Instagram.', logo: <InstagramIcon size={24} /> },
  { name: 'Meta Ads', text: 'Los formularios de tus anuncios de Facebook e Instagram entran directamente como leads.', logo: <Megaphone aria-hidden /> },
  { name: 'Formularios y landing', text: 'Un formulario para tu web o un webhook (envío automático de datos) desde tus herramientas.', logo: <Globe aria-hidden /> },
  { name: 'Google Calendar', text: 'Consulta tus huecos libres y crea las citas en tu calendario.', logo: <CalendarDays aria-hidden /> },
  { name: 'Calendly', text: 'Propone tus huecos de Calendly y envía al lead el enlace para reservar.', logo: <CalendarCheck aria-hidden /> },
];

const FAQ: { q: string; a: string }[] = [
  {
    q: '¿Necesito conocimientos técnicos para usar KAI?',
    a: 'No. Al crear tu cuenta, KAI te guía paso a paso: le cuentas cómo trabajas, conectas tus canales y tu agenda, y lo pruebas en el simulador (un chat de prueba en el que tú haces de lead) antes de que hable con leads reales.',
  },
  {
    q: '¿KAI se hace pasar por mí?',
    a: 'Tú decides si habla como parte de tu equipo o en tu nombre, y si se presenta como asistente desde el primer mensaje. Si alguien le pregunta si es una IA, nunca lo niega y ofrece pasarle contigo.',
  },
  {
    q: '¿Qué pasa si un lead pregunta algo que KAI no sabe?',
    a: 'No se lo inventa. Lo reconoce con naturalidad y ofrece que lo aclares tú en la llamada. Si la conversación necesita a una persona, te la pasa y te avisa.',
  },
  {
    q: '¿Puedo intervenir en una conversación?',
    a: 'Sí, cuando quieras. Desde la bandeja puedes escribir tú: KAI deja de responder en esa conversación hasta que se la devuelvas.',
  },
  {
    q: '¿Cómo sabe KAI qué horarios ofrecer?',
    a: 'Defines tu disponibilidad en KAI o conectas Google Calendar o Calendly. KAI solo propone huecos libres y no da una cita por confirmada hasta que está reservada.',
  },
  {
    q: '¿KAI cierra las ventas por mí?',
    a: 'No. KAI atiende, cualifica y agenda la llamada. La venta la cierras tú, con el historial y todo lo que el lead ha contado a la vista.',
  },
  {
    q: '¿Qué canales puedo conectar?',
    a: 'WhatsApp Business, Instagram, los formularios de tus anuncios de Meta (Lead Ads), un formulario para tu web y otras herramientas mediante webhook, que es un envío automático de datos entre aplicaciones.',
  },
  {
    q: '¿Qué ocurre si llego al límite de mi plan?',
    a: 'KAI deja de responder de forma automática en esas conversaciones y te avisa, para que puedas atenderlas tú desde la bandeja.',
  },
];

// ───────────── Planes ─────────────

const NUMBER_FORMAT = new Intl.NumberFormat('es-ES', { useGrouping: 'always', maximumFractionDigits: 2 });
const num = (n: number) => NUMBER_FORMAT.format(n);
const plural = (n: number, one: string, many: string) => `${num(n)} ${n === 1 ? one : many}`;

function planPrice(plan: PublicPlan): string {
  if (plan.priceMonthlyCents === 0) return 'Gratis';
  try {
    return formatMoney(plan.priceMonthlyCents, plan.currency);
  } catch {
    return `${num(plan.priceMonthlyCents / 100)} ${plan.currency}`;
  }
}

function limitLines(l: PlanLimits): { text: string; on: boolean }[] {
  return [
    { text: l.maxLeadsPerMonth === null ? 'Leads nuevos ilimitados' : `Hasta ${plural(l.maxLeadsPerMonth, 'lead nuevo', 'leads nuevos')} al mes`, on: true },
    {
      text: l.maxAiMessagesPerMonth === null ? 'Mensajes de IA ilimitados' : `Hasta ${plural(l.maxAiMessagesPerMonth, 'mensaje', 'mensajes')} de IA al mes`,
      on: true,
    },
    { text: l.maxChannels === null ? 'Canales ilimitados' : plural(l.maxChannels, 'canal conectado', 'canales conectados'), on: true },
    { text: l.maxTeamMembers === null ? 'Usuarios ilimitados' : plural(l.maxTeamMembers, 'usuario', 'usuarios'), on: true },
    { text: l.maxBusinesses === null ? 'Negocios ilimitados' : plural(l.maxBusinesses, 'negocio', 'negocios'), on: true },
    { text: 'KAI Copilot', on: l.copilot },
    { text: 'Analítica avanzada', on: l.advancedAnalytics },
  ];
}

// ───────────── Piezas ─────────────

function Header({ loggedIn, showPricing }: { loggedIn: boolean; showPricing: boolean }) {
  const scrolled = useScrolled();
  const nav = [
    { id: 'como-funciona', label: 'Cómo funciona' },
    { id: 'funcionalidades', label: 'Funcionalidades' },
    { id: 'integraciones', label: 'Integraciones' },
    ...(showPricing ? [{ id: 'precios', label: 'Precios' }] : []),
    { id: 'preguntas', label: 'Preguntas' },
  ];
  return (
    <header className={`lp-header ${scrolled ? 'is-scrolled' : ''}`}>
      <div className="lp-container lp-header-inner">
        <Logo />
        <nav className="lp-nav" aria-label="Secciones de la página">
          {nav.map((n) => (
            <SectionLink key={n.id} to={n.id}>
              {n.label}
            </SectionLink>
          ))}
        </nav>
        <div className="lp-header-actions">
          {loggedIn ? (
            <Link to="/app" className="btn btn-primary btn-sm">
              Ir a la app
              <ArrowRight aria-hidden />
            </Link>
          ) : (
            <>
              <Link to="/login" className="btn btn-ghost btn-sm">
                Entrar
              </Link>
              <Link to="/registro" className="btn btn-primary btn-sm">
                Probar KAI
              </Link>
            </>
          )}
        </div>
      </div>
    </header>
  );
}

function PrimaryCta({ loggedIn, size = 'lg', glow, block }: { loggedIn: boolean; size?: 'lg' | 'md'; glow?: boolean; block?: boolean }) {
  const cls = ['btn', 'btn-primary', size === 'lg' && 'btn-lg', glow && 'lp-btn-glow', block && 'btn-block'].filter(Boolean).join(' ');
  return (
    <Link to={loggedIn ? '/app' : '/registro'} className={cls}>
      {loggedIn ? 'Ir a la app' : 'Probar KAI'}
      <ArrowRight aria-hidden />
    </Link>
  );
}

function FlowVisual() {
  return (
    <figure className="lp-flow" aria-labelledby="lp-flow-title">
      <figcaption className="lp-flow-head">
        <span className="lp-live" id="lp-flow-title">
          <span className="lp-dot" aria-hidden />
          El recorrido de un lead con KAI
        </span>
        <span className="lp-flow-aside" aria-hidden>
          Automático de principio a fin
        </span>
      </figcaption>
      <div className="lp-flow-body">
        <div className="lp-flow-rail" aria-hidden>
          <span className="lp-flow-fill" />
          <span className="lp-flow-runner" />
        </div>
        <ol className="lp-flow-track">
          {FLOW.map((step, i) => {
            const Icon = step.icon;
            return (
              <li key={step.label} className={`lp-flow-step ${step.kind === 'kai' ? 'is-kai' : ''} ${step.kind === 'goal' ? 'is-goal' : ''}`}>
                <span className="lp-flow-node" style={cssVars({ '--i': i })} aria-hidden>
                  {step.kind === 'kai' ? <LogoMark size={34} /> : Icon ? <Icon /> : null}
                </span>
                <span className="lp-flow-label">{step.label}</span>
                <span className="lp-flow-caption">{step.caption}</span>
              </li>
            );
          })}
        </ol>
      </div>
    </figure>
  );
}

function SectionHead({ kicker, title, lead, center, id }: { kicker: string; title: ReactNode; lead?: ReactNode; center?: boolean; id: string }) {
  return (
    <div className={`lp-section-head ${center ? 'is-center' : ''}`} data-reveal>
      <p className="lp-kicker">{kicker}</p>
      <h2 className="lp-h2" id={id}>
        {title}
      </h2>
      {lead && <p className="lp-lead">{lead}</p>}
    </div>
  );
}

type ChatItem =
  | { from: 'lead'; text: string }
  | { from: 'kai'; text: string; slots?: string[] }
  | { from: 'event'; text: string };

const CHAT: ChatItem[] = [
  { from: 'lead', text: '¡Hola! He visto vuestro anuncio. ¿Cómo funciona el entrenamiento online?' },
  { from: 'kai', text: 'Hola, Laura. Soy KAI, el asistente de Álex. Te cuento encantado. Para orientarte bien: ¿qué te gustaría conseguir ahora mismo?' },
  { from: 'lead', text: 'Quiero ponerme en forma y ganar fuerza, pero voy fatal de tiempo' },
  { from: 'kai', text: 'Tiene todo el sentido. ¿Cuántos días a la semana podrías dedicarle de forma realista?' },
  { from: 'lead', text: 'Unos tres días, tres cuartos de hora cada uno' },
  {
    from: 'kai',
    text: 'Con eso se puede trabajar muy bien. Lo ideal es que lo veáis en una llamada corta con Álex. ¿Te viene bien alguno de estos huecos?',
    slots: ['Mañana · 18:00', 'Jueves · 10:30'],
  },
  { from: 'lead', text: 'El jueves a las 10:30, perfecto' },
  { from: 'kai', text: 'Hecho, Laura: tienes la llamada con Álex el jueves a las 10:30. Te escribiré antes para recordártelo.' },
  { from: 'event', text: 'Llamada reservada en la agenda de Álex' },
];

function ChatDemo() {
  return (
    <div className="lp-phone-wrap" data-reveal>
      <div className="lp-phone" role="group" aria-label="Conversación de ejemplo entre un lead ficticio y KAI">
        <div className="lp-phone-top">
          <span className="lp-avatar" aria-hidden>
            L
            <span className="lp-avatar-channel">
              <InstagramIcon size={12} />
            </span>
          </span>
          <div className="grow">
            <p className="lp-phone-name">Laura</p>
            <p className="lp-phone-status">Lead de ejemplo · Instagram</p>
          </div>
          <span className="badge lp-phone-tag">Ejemplo ficticio</span>
        </div>
        <ol className="lp-chat">
          {CHAT.map((m, i) => {
            const style = cssVars({ '--d': i });
            if (m.from === 'event')
              return (
                <li key={i} className="lp-event" style={style}>
                  <CalendarCheck aria-hidden />
                  <span>{m.text}</span>
                </li>
              );
            return (
              <li key={i} className={`lp-msg ${m.from === 'kai' ? 'is-kai' : 'is-lead'}`} style={style}>
                <span className="lp-msg-who">{m.from === 'kai' ? 'KAI · asistente' : 'Laura'}</span>
                <div className="lp-bubble">
                  {m.text}
                  {m.from === 'kai' && m.slots && (
                    <span className="lp-slots">
                      {m.slots.map((s) => (
                        <span key={s} className="lp-slot">
                          <Clock aria-hidden />
                          {s}
                        </span>
                      ))}
                    </span>
                  )}
                </div>
                {m.from === 'kai' && m.slots && (
                  <span className="lp-slots-note">
                    <CalendarDays aria-hidden />
                    Huecos libres en la agenda de Álex
                  </span>
                )}
              </li>
            );
          })}
        </ol>
      </div>
    </div>
  );
}

function FaqList() {
  const [open, setOpen] = useState<number | null>(0);
  const base = useId();
  return (
    <div className="lp-faq" data-reveal>
      {FAQ.map((item, i) => {
        const isOpen = open === i;
        const qId = `${base}-q${i}`;
        const aId = `${base}-a${i}`;
        return (
          <div key={item.q} className={`lp-faq-item ${isOpen ? 'is-open' : ''}`}>
            <h3 className="lp-faq-q">
              <button type="button" id={qId} aria-expanded={isOpen} aria-controls={aId} onClick={() => setOpen(isOpen ? null : i)}>
                <span>{item.q}</span>
                <ChevronDown aria-hidden />
              </button>
            </h3>
            <div id={aId} role="region" aria-labelledby={qId} className="lp-faq-a" hidden={!isOpen}>
              <p>{item.a}</p>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Pricing({ plans, loading, loggedIn, trialDays }: { plans: PublicPlan[]; loading: boolean; loggedIn: boolean; trialDays?: number }) {
  return (
    <section id="precios" className="lp-section" tabIndex={-1} aria-labelledby="precios-title">
      <div className="lp-container">
        <SectionHead
          id="precios-title"
          center
          kicker="Precios"
          title="Elige el plan que encaja con tu volumen."
          lead="Todos incluyen el setter IA, la bandeja unificada, el CRM y la agenda. La diferencia está en el volumen de leads y mensajes y en algunas funciones avanzadas."
        />
        <div data-reveal>
          {loading ? (
            <div className="lp-plans" aria-busy="true" aria-label="Cargando planes">
              {[0, 1, 2].map((i) => (
                <div key={i} className="skeleton lp-plan-skeleton" />
              ))}
            </div>
          ) : (
            <ul className="lp-plans">
              {plans.map((plan) => (
                <li key={plan.key} className="lp-plan">
                  <div>
                    <h3 className="lp-plan-name">{plan.name}</h3>
                    {plan.description && <p className="lp-plan-desc">{plan.description}</p>}
                  </div>
                  <p className="lp-price">
                    <strong className="tnum">{planPrice(plan)}</strong>
                    {plan.priceMonthlyCents > 0 && <span>al mes</span>}
                  </p>
                  <ul className="lp-plan-list">
                    {limitLines(plan.limits).map((line) => (
                      <li key={line.text} className={line.on ? '' : 'is-off'}>
                        {line.on ? <Check aria-hidden /> : <Minus aria-hidden />}
                        <span>
                          {line.text}
                          {!line.on && <span className="sr-only"> (no incluido)</span>}
                        </span>
                      </li>
                    ))}
                  </ul>
                  <PrimaryCta loggedIn={loggedIn} size="md" block />
                </li>
              ))}
            </ul>
          )}
          <div className="lp-plans-note">
            <p>
              <strong>{trialDays ? `Al crear tu cuenta empiezas con ${trialDays} días de prueba.` : 'Al crear tu cuenta empiezas con un periodo de prueba.'}</strong>
            </p>
            <p>
              Mensajes de IA: respuestas que KAI escribe por ti y consultas a KAI Copilot. Canal conectado: cada vía por la que te escriben tus leads, como WhatsApp o
              Instagram.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}

// ───────────── Página ─────────────

export default function Landing() {
  const { me } = useAuth();
  const loggedIn = Boolean(me?.user);
  const rootRef = useRef<HTMLDivElement>(null);
  const [motion, setMotion] = useState(false);

  const plansQuery = useQuery({
    queryKey: ['public-plans'],
    queryFn: () => api.get<{ plans: PublicPlan[]; trialDays?: number }>('/public/plans'),
    staleTime: 5 * 60_000,
    retry: 1,
  });
  const plans = plansQuery.data?.plans ?? [];
  const showPricing = plansQuery.isPending || (plansQuery.isSuccess && plans.length > 0);

  // Animaciones de entrada solo si el navegador las soporta y el usuario no pide reducir el movimiento.
  useLayoutEffect(() => {
    setMotion(typeof IntersectionObserver !== 'undefined' && !prefersReducedMotion());
  }, []);

  useEffect(() => {
    const root = rootRef.current;
    if (!motion || !root) return;
    const targets = root.querySelectorAll<HTMLElement>('[data-reveal]:not(.is-in)');
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          entry.target.classList.add('is-in');
          io.unobserve(entry.target);
        }
      },
      { threshold: 0.12, rootMargin: '0px 0px -6% 0px' },
    );
    targets.forEach((t) => io.observe(t));
    return () => io.disconnect();
  }, [motion, showPricing, plansQuery.status]);

  // Si se entra con un ancla (/#precios), lleva a esa sección cuando ya está pintada.
  useEffect(() => {
    const id = decodeURIComponent(window.location.hash.slice(1));
    if (!id) return;
    const t = window.setTimeout(() => document.getElementById(id)?.scrollIntoView({ block: 'start' }), 80);
    return () => window.clearTimeout(t);
  }, []);

  const year = new Date().getFullYear();

  return (
    <div className={`landing ${motion ? 'lp-motion' : ''}`} ref={rootRef}>
      <a className="lp-skip" href="#contenido">
        Saltar al contenido
      </a>
      <Header loggedIn={loggedIn} showPricing={showPricing} />

      <main id="contenido" tabIndex={-1}>
        {/* ───── Hero ───── */}
        <section className="lp-hero" aria-labelledby="hero-title">
          <div className="lp-hero-bg" aria-hidden />
          <div className="lp-container lp-hero-inner">
            <p className="lp-eyebrow">
              <span className="lp-dot" aria-hidden />
              Setter IA, CRM y agenda para entrenadores personales
            </p>
            <h1 className="lp-title" id="hero-title">
              Tu próximo cliente puede estar hablando con <span className="lp-hl">KAI</span> ahora mismo.
            </h1>
            <p className="lp-sub">KAI responde, cualifica y agenda tus leads automáticamente para que tú puedas centrarte en entrenar y cerrar clientes.</p>
            <div className="lp-cta-row">
              <PrimaryCta loggedIn={loggedIn} glow />
              <SectionLink to="como-funciona" className="btn btn-lg lp-btn-outline">
                Ver cómo funciona
                <ArrowDown aria-hidden />
              </SectionLink>
            </div>
            <ul className="lp-hero-notes">
              <li>
                <Check aria-hidden />
                Habla con tu tono y con tu información
              </li>
              <li>
                <Check aria-hidden />
                Solo ofrece huecos libres de tu agenda
              </li>
              <li>
                <Check aria-hidden />
                Te pasa la conversación cuando hace falta
              </li>
            </ul>
          </div>
          <div className="lp-container">
            <FlowVisual />
          </div>
        </section>

        {/* ───── El problema ───── */}
        <section id="problema" className="lp-section" tabIndex={-1} aria-labelledby="problema-title">
          <div className="lp-container lp-problem">
            <div className="lp-problem-head" data-reveal>
              <p className="lp-kicker">El problema</p>
              <h2 className="lp-h2" id="problema-title">
                Cada lead que no atiendes a tiempo se enfría.
              </h2>
              <p className="lp-lead">
                Si consigues clientes por Instagram, WhatsApp o anuncios, seguramente te suena alguna de estas situaciones. No es falta de ganas: es que no puedes estar entrenando y
                contestando mensajes a la vez.
              </p>
            </div>
            <ul className="lp-pains">
              {PAINS.map((p) => (
                <li key={p.title} className="lp-pain" data-reveal>
                  <span className="lp-pain-icon" aria-hidden>
                    <p.icon />
                  </span>
                  <div>
                    <h3 className="lp-h3">{p.title}</h3>
                    <p>{p.text}</p>
                    <p className="lp-pain-fix">
                      <Check aria-hidden />
                      <span>
                        <span className="sr-only">Con KAI: </span>
                        {p.fix}
                      </span>
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </section>

        {/* ───── Cómo funciona ───── */}
        <section id="como-funciona" className="lp-section lp-band" tabIndex={-1} aria-labelledby="como-funciona-title">
          <div className="lp-container">
            <SectionHead
              id="como-funciona-title"
              center
              kicker="Cómo funciona"
              title="De mensaje nuevo a llamada agendada, sin que tengas que estar pendiente del móvil."
              lead="Lo configuras una vez y KAI se encarga del día a día. Tú decides cuándo intervenir."
            />
            <ol className="lp-steps">
              {STEPS.map((s, i) => (
                <li key={s.title} className="lp-step" data-reveal>
                  <div className="lp-step-top">
                    <span className="lp-icon-tile" aria-hidden>
                      <s.icon />
                    </span>
                    <span className="lp-step-num" aria-hidden>
                      {String(i + 1).padStart(2, '0')}
                    </span>
                  </div>
                  <h3 className="lp-h3">{s.title}</h3>
                  <p>{s.text}</p>
                </li>
              ))}
            </ol>
            <p className="lp-aside-note" data-reveal>
              <FlaskConical aria-hidden />
              <span>
                Antes de que hable con leads reales, puedes probarlo en el <strong>simulador</strong>: un chat de prueba en el que tú haces de lead y ves exactamente cómo
                responde KAI.
              </span>
            </p>
          </div>
        </section>

        {/* ───── Conversación de ejemplo ───── */}
        <section id="ejemplo" className="lp-section" tabIndex={-1} aria-labelledby="ejemplo-title">
          <div className="lp-container lp-demo">
            <div data-reveal>
              <p className="lp-kicker">Así conversa KAI</p>
              <h2 className="lp-h2" id="ejemplo-title">
                Una pregunta cada vez. Horarios de verdad.
              </h2>
              <p className="lp-lead">
                KAI no lanza un formulario ni un bloque de preguntas. Conversa como lo haría alguien de tu equipo: escucha, pregunta lo justo y propone la llamada cuando tiene
                sentido.
              </p>
              <ul className="lp-checks">
                <li>
                  <span className="lp-check" aria-hidden>
                    <Check />
                  </span>
                  <span>
                    <strong>Una sola pregunta por mensaje</strong>
                    Responde primero a lo que le han dicho y después avanza.
                  </span>
                </li>
                <li>
                  <span className="lp-check" aria-hidden>
                    <Check />
                  </span>
                  <span>
                    <strong>Solo huecos libres de tu agenda</strong>
                    No da una cita por confirmada hasta que está reservada de verdad.
                  </span>
                </li>
                <li>
                  <span className="lp-check" aria-hidden>
                    <Check />
                  </span>
                  <span>
                    <strong>Con tu tono</strong>
                    Tú decides si tutea o trata de usted, la longitud de los mensajes y el uso de emojis.
                  </span>
                </li>
                <li>
                  <span className="lp-check" aria-hidden>
                    <Check />
                  </span>
                  <span>
                    <strong>Recuerda lo que le cuentan</strong>
                    Usa con naturalidad lo que el lead le ha contado, sin sonar a ficha.
                  </span>
                </li>
              </ul>
              <p className="lp-note">
                <Info aria-hidden />
                Ejemplo ilustrativo: los nombres, los mensajes y los horarios son ficticios.
              </p>
            </div>
            <ChatDemo />
          </div>
        </section>

        {/* ───── Funcionalidades ───── */}
        <section id="funcionalidades" className="lp-section lp-band" tabIndex={-1} aria-labelledby="funcionalidades-title">
          <div className="lp-container">
            <SectionHead
              id="funcionalidades-title"
              kicker="Funcionalidades"
              title="Todo lo que necesitas para convertir conversaciones en clientes."
              lead="Setter, CRM y agenda en una sola herramienta, pensada para entrenadores personales."
            />
            <ul className="lp-features">
              {FEATURES.map((f) => (
                <li key={f.title} className={`lp-feature ${f.wide ? 'is-wide' : ''} ${f.accent ? 'is-accent' : ''}`} data-reveal>
                  <span className="lp-icon-tile" aria-hidden>
                    <f.icon />
                  </span>
                  <h3 className="lp-h3">{f.title}</h3>
                  <p>{f.text}</p>
                  {f.extra === 'tags' && (
                    <ul className="lp-tags" aria-label="Lo que configuras">
                      {SETTER_TAGS.map((t) => (
                        <li key={t} className="lp-tag">
                          <Check aria-hidden />
                          {t}
                        </li>
                      ))}
                    </ul>
                  )}
                  {f.extra === 'funnel' && (
                    <div className="lp-minifunnel" aria-hidden>
                      {FUNNEL_STAGES.map((s, i) => (
                        <div key={s} className="lp-mf-row">
                          <span>{s}</span>
                          <i style={cssVars({ '--w': `${100 - i * 17}%` })} />
                        </div>
                      ))}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </div>
        </section>

        {/* ───── KAI juega limpio ───── */}
        <section id="juega-limpio" className="lp-section" tabIndex={-1} aria-labelledby="juega-limpio-title">
          <div className="lp-container">
            <div className="lp-fair" data-reveal>
              <p className="lp-kicker">Transparencia</p>
              <h2 className="lp-h2" id="juega-limpio-title">
                KAI juega limpio.
              </h2>
              <p className="lp-lead">Vende sin trampas. Estas reglas vienen de serie en cada conversación; no dependen de que te acuerdes de configurarlas.</p>
              <ul className="lp-fair-grid">
                {FAIR.map((f) => (
                  <li key={f.title} className="lp-fair-item">
                    <span className="lp-icon-tile" aria-hidden>
                      <f.icon />
                    </span>
                    <div>
                      <h3 className="lp-h3">{f.title}</h3>
                      <p>{f.text}</p>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </section>

        {/* ───── Integraciones ───── */}
        <section id="integraciones" className="lp-section lp-band" tabIndex={-1} aria-labelledby="integraciones-title">
          <div className="lp-container">
            <SectionHead
              id="integraciones-title"
              center
              kicker="Integraciones"
              title="Conectado a donde ya llegan tus leads."
              lead="Las conexiones se configuran desde la app, paso a paso, sin tocar código."
            />
            <ul className="lp-integrations">
              {INTEGRATIONS.map((it) => (
                <li key={it.name} className="lp-int" data-reveal>
                  <span className="lp-int-logo" aria-hidden>
                    {it.logo}
                  </span>
                  <div>
                    <h3 className="lp-h3">{it.name}</h3>
                    <p>{it.text}</p>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </section>

        {/* ───── Precios (solo si la API responde con planes) ───── */}
        {showPricing && <Pricing plans={plans} loading={plansQuery.isPending} loggedIn={loggedIn} trialDays={plansQuery.data?.trialDays} />}

        {/* ───── Preguntas frecuentes ───── */}
        <section id="preguntas" className={`lp-section ${showPricing ? 'lp-band' : ''}`} tabIndex={-1} aria-labelledby="preguntas-title">
          <div className="lp-container lp-faq-wrap">
            <div data-reveal>
              <p className="lp-kicker">Preguntas frecuentes</p>
              <h2 className="lp-h2" id="preguntas-title">
                Lo que suelen preguntarnos.
              </h2>
              <p className="lp-lead">Si te queda alguna duda, crea tu cuenta y prueba KAI en el simulador antes de conectarlo con tus leads.</p>
            </div>
            <FaqList />
          </div>
        </section>

        {/* ───── CTA final ───── */}
        <section className="lp-section" aria-labelledby="final-title">
          <div className="lp-container">
            <div className="lp-final" data-reveal>
              <LogoMark size={48} />
              <h2 className="lp-h2" id="final-title" style={{ marginTop: 22 }}>
                Mientras tú entrenas, KAI atiende.
              </h2>
              <p className="lp-lead">Configúralo paso a paso, pruébalo en el simulador y deja que tus leads reciban respuesta cuando escriben.</p>
              <div className="lp-cta-row">
                <PrimaryCta loggedIn={loggedIn} glow />
                {!loggedIn && (
                  <Link to="/login" className="btn btn-lg lp-btn-outline">
                    Ya tengo cuenta
                  </Link>
                )}
              </div>
            </div>
          </div>
        </section>
      </main>

      <footer className="lp-footer">
        <div className="lp-container">
          <div className="lp-footer-grid">
            <div className="lp-footer-brand">
              <Logo />
              <p>Setter IA, CRM y agenda para entrenadores personales. KAI atiende y agenda; tú entrenas y cierras.</p>
            </div>
            <nav aria-labelledby="lp-footer-product">
              <h2 className="lp-footer-title" id="lp-footer-product">
                Producto
              </h2>
              <ul>
                <li>
                  <SectionLink to="como-funciona">Cómo funciona</SectionLink>
                </li>
                <li>
                  <SectionLink to="funcionalidades">Funcionalidades</SectionLink>
                </li>
                <li>
                  <SectionLink to="juega-limpio">KAI juega limpio</SectionLink>
                </li>
                <li>
                  <SectionLink to="integraciones">Integraciones</SectionLink>
                </li>
                {showPricing && (
                  <li>
                    <SectionLink to="precios">Precios</SectionLink>
                  </li>
                )}
                <li>
                  <SectionLink to="preguntas">Preguntas frecuentes</SectionLink>
                </li>
              </ul>
            </nav>
            <nav aria-labelledby="lp-footer-account">
              <h2 className="lp-footer-title" id="lp-footer-account">
                Cuenta
              </h2>
              <ul>
                {loggedIn ? (
                  <li>
                    <Link to="/app">Ir a la app</Link>
                  </li>
                ) : (
                  <>
                    <li>
                      <Link to="/login">Entrar</Link>
                    </li>
                    <li>
                      <Link to="/registro">Crear cuenta</Link>
                    </li>
                    <li>
                      <Link to="/recuperar">Recuperar contraseña</Link>
                    </li>
                  </>
                )}
              </ul>
            </nav>
          </div>
          <div className="lp-footer-bottom">
            <span>© {year} KAI</span>
            <span>
              <Link to="/privacidad">Privacidad</Link> · <Link to="/terminos">Condiciones</Link>
            </span>
            <span>Hecho para entrenadores personales.</span>
          </div>
        </div>
      </footer>
    </div>
  );
}
