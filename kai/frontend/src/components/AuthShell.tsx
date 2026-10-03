/*
 * Layout compartido de las pantallas de acceso (entrar, registro, recuperación e invitación)
 * y piezas de formulario reutilizables: contraseña con “mostrar”, reglas de contraseña y errores.
 */
import { useEffect, useState, type InputHTMLAttributes, type ReactNode } from 'react';
import { Link } from 'react-router';
import { ArrowLeft, CalendarCheck, Check, Circle, Eye, EyeOff, HandHelping, MessagesSquare, type LucideIcon } from 'lucide-react';
import { Logo } from './brand';
import { Callout, Input } from './ui';
import { errorText } from '../lib/api';
import '../styles/auth.css';

/** Cambia el título de la pestaña mientras la pantalla está abierta y lo restaura al salir. */
export function useDocumentTitle(title: string) {
  useEffect(() => {
    const previous = document.title;
    document.title = `${title} · KAI`;
    return () => {
      document.title = previous;
    };
  }, [title]);
}

/** Solo acepta rutas internas en ?next (evita redirecciones a otros dominios). */
export function safeNext(raw: string | null): string | null {
  if (!raw || !raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\')) return null;
  return raw;
}

export const isEmail = (value: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());

/** Mismas reglas que valida el servidor: mínimo 10 caracteres, con letras y números. */
const PASSWORD_RULES = [
  { label: 'Al menos 10 caracteres', test: (p: string) => p.length >= 10 },
  { label: 'Combina letras y números', test: (p: string) => /[a-zA-Z]/.test(p) && /[0-9]/.test(p) },
];

export function passwordIssue(password: string): string | null {
  if (password.length < 10) return 'La contraseña debe tener al menos 10 caracteres.';
  if (password.length > 200) return 'La contraseña es demasiado larga.';
  if (!/[a-zA-Z]/.test(password) || !/[0-9]/.test(password)) return 'La contraseña debe combinar letras y números.';
  return null;
}

export function PasswordRules({ value, id }: { value: string; id?: string }) {
  return (
    <ul className="kai-rules" id={id}>
      {PASSWORD_RULES.map((rule) => {
        const ok = rule.test(value);
        return (
          <li key={rule.label} className={ok ? 'is-ok' : ''}>
            {ok ? <Check aria-hidden /> : <Circle aria-hidden />}
            <span>
              {rule.label}
              <span className="sr-only">{ok ? ' (cumplido)' : ' (pendiente)'}</span>
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/** Campo de contraseña con botón para mostrarla u ocultarla. */
export function PasswordInput(props: Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="kai-pass">
      <Input maxLength={200} {...props} type={visible ? 'text' : 'password'} />
      <button
        type="button"
        className="kai-pass-toggle"
        aria-label="Mostrar contraseña"
        title={visible ? 'Ocultar contraseña' : 'Mostrar contraseña'}
        aria-pressed={visible}
        aria-controls={props.id}
        onClick={() => setVisible((v) => !v)}
      >
        {visible ? <EyeOff aria-hidden /> : <Eye aria-hidden />}
      </button>
    </div>
  );
}

/** Error del servidor (o de validación) anunciado a lectores de pantalla. */
export function FormError({ error }: { error: unknown }) {
  if (!error) return null;
  return (
    <div role="alert">
      <Callout tone="danger">{typeof error === 'string' ? error : errorText(error)}</Callout>
    </div>
  );
}

const POINTS: { icon: LucideIcon; title: string; text: string }[] = [
  { icon: MessagesSquare, title: 'Responde y cualifica', text: 'Con tu tono y una pregunta cada vez.' },
  { icon: CalendarCheck, title: 'Agenda con tus horarios reales', text: 'Solo ofrece huecos libres de tu agenda.' },
  { icon: HandHelping, title: 'Te avisa cuando hace falta', text: 'Te pasa la conversación si el lead necesita a una persona.' },
];

export default function AuthShell({
  title,
  subtitle,
  docTitle,
  children,
  footer,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  /** Título de la pestaña del navegador. */
  docTitle: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  useDocumentTitle(docTitle);
  const year = new Date().getFullYear();
  return (
    <div className="auth-wrap kai-auth">
      <aside className="auth-side" aria-label="Qué es KAI">
        <Logo />
        <div className="kai-auth-pitch">
          <p className="kai-auth-kicker">Setter IA para entrenadores personales</p>
          <p className="kai-auth-headline">Tus leads, atendidos mientras tú entrenas.</p>
          <ul className="kai-auth-points">
            {POINTS.map((p) => (
              <li key={p.title}>
                <span className="kai-auth-ico" aria-hidden>
                  <p.icon />
                </span>
                <span>
                  <strong>{p.title}</strong>
                  <small>{p.text}</small>
                </span>
              </li>
            ))}
          </ul>
          <div className="kai-auth-preview" aria-hidden>
            <span className="kai-auth-preview-tag">Ejemplo ficticio</span>
            <div className="kai-auth-bubble is-lead">¿Tenéis hueco esta semana para hablar?</div>
            <div className="kai-auth-bubble is-kai">Sí: Álex tiene libre el jueves a las 10:30 o el viernes a las 17:00. ¿Cuál te viene mejor?</div>
          </div>
        </div>
        <p className="kai-auth-legal">© {year} KAI</p>
      </aside>
      <main className="auth-form">
        <div className="auth-card">
          <div className="kai-auth-top">
            <span className="kai-auth-mobile-logo">
              <Logo />
            </span>
            <Link to="/" className="kai-auth-back">
              <ArrowLeft aria-hidden />
              Volver al inicio
            </Link>
          </div>
          <div className="kai-auth-heading">
            <h1>{title}</h1>
            {subtitle && <p className="muted">{subtitle}</p>}
          </div>
          {children}
          {footer && <div className="kai-auth-footer">{footer}</div>}
        </div>
      </main>
    </div>
  );
}
