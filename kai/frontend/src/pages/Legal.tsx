import { useEffect } from 'react';
import { Link, useLocation } from 'react-router';
import { Logo } from '../components/brand';
import { Callout } from '../components/ui';

/*
 * Páginas legales de KAI (privacidad y condiciones de uso).
 *
 * IMPORTANTE para el propietario del SaaS: esto es una PLANTILLA orientativa.
 * Sustituye los textos entre [corchetes] por tus datos reales y revísala con un profesional
 * antes de vender KAI. No sustituye el asesoramiento legal.
 */
const OWNER = '[Nombre o razón social del titular]';
const OWNER_ID = '[NIF/CIF]';
const OWNER_ADDRESS = '[Dirección]';
const CONTACT_EMAIL = '[email de contacto]';
const TEMPLATE_PENDING = OWNER.startsWith('[');

function Privacy() {
  return (
    <>
      <h1>Política de privacidad</h1>
      <h2>1. Responsable</h2>
      <p>
        {OWNER}, con {OWNER_ID} y domicilio en {OWNER_ADDRESS}. Contacto: {CONTACT_EMAIL}.
      </p>
      <h2>2. Qué datos tratamos</h2>
      <ul>
        <li>Datos de tu cuenta: nombre, email, contraseña (guardada cifrada de forma irreversible) y datos de tu negocio.</li>
        <li>
          Datos de tus leads que llegan a través de los canales que conectas (WhatsApp, Instagram, formularios, anuncios): nombre, teléfono, usuario, mensajes y la
          información que compartan en la conversación.
        </li>
        <li>Datos técnicos necesarios para el servicio: registros de actividad y de seguridad.</li>
      </ul>
      <h2>3. Para qué los usamos</h2>
      <p>
        Para prestar el servicio: responder y cualificar a tus leads con un asistente automatizado, agendar llamadas, enviar recordatorios y seguimientos, y mostrarte
        métricas. No vendemos datos ni los usamos para publicidad de terceros.
      </p>
      <h2>4. Papel de cada parte</h2>
      <p>
        Respecto a los datos de tus leads, tú eres el responsable del tratamiento y KAI actúa como encargado del tratamiento, siguiendo tus instrucciones. Debes informar a
        tus leads de que usas un asistente automatizado y de esta política en tu propia política de privacidad.
      </p>
      <h2>5. Proveedores que intervienen</h2>
      <ul>
        <li>Meta Platforms (WhatsApp, Instagram y anuncios), si conectas esos canales.</li>
        <li>Anthropic (modelo de inteligencia artificial Claude), para redactar y analizar mensajes.</li>
        <li>Google (Google Calendar) o Calendly, si conectas tu calendario.</li>
        <li>[Proveedor de hosting y base de datos] y [proveedor de email], para alojar y enviar notificaciones.</li>
      </ul>
      <h2>6. Conservación</h2>
      <p>Mientras tengas la cuenta activa. Puedes borrar cualquier lead y su conversación desde la aplicación en cualquier momento.</p>
      <h2>7. Tus derechos</h2>
      <p>
        Puedes ejercer tus derechos de acceso, rectificación, supresión, oposición, limitación y portabilidad escribiendo a {CONTACT_EMAIL}. También puedes reclamar ante
        la autoridad de protección de datos competente (en España, la AEPD).
      </p>
      <h2>8. Transparencia sobre la IA</h2>
      <p>
        KAI es un asistente automatizado. Por defecto se presenta como tal en su primer mensaje y nunca niega ser un asistente si se lo preguntan. No toma decisiones con
        efectos legales sobre las personas: la venta y cualquier decisión importante las toma siempre una persona.
      </p>
    </>
  );
}

function Terms() {
  return (
    <>
      <h1>Condiciones de uso</h1>
      <h2>1. El servicio</h2>
      <p>
        KAI es una herramienta para entrenadores personales que responde, cualifica y agenda a sus leads de forma automatizada, e incluye CRM, agenda y métricas. El titular
        del servicio es {OWNER} ({OWNER_ID}).
      </p>
      <h2>2. Tu cuenta</h2>
      <p>Eres responsable de la información que configuras (servicios, precios, disponibilidad, mensajes) y de mantener segura tu contraseña.</p>
      <h2>3. Uso correcto</h2>
      <ul>
        <li>Solo puedes contactar con personas que te hayan escrito o dejado sus datos para ello, y respetar las normas de WhatsApp, Instagram y Meta.</li>
        <li>No puedes usar KAI para enviar spam, acosar, engañar o prometer resultados de salud o físicos garantizados.</li>
        <li>KAI no da consejos médicos: las cuestiones de salud se derivan siempre a una persona.</li>
      </ul>
      <h2>4. Planes y pagos</h2>
      <p>Los planes, sus precios y límites se muestran en la web. [Describe aquí la facturación, renovación, cancelación y reembolsos.]</p>
      <h2>5. Responsabilidad</h2>
      <p>
        KAI se ofrece con la máxima diligencia, pero depende de servicios de terceros (Meta, Google, Calendly, proveedores de IA). Revisa las conversaciones importantes y
        puedes tomar el control de cualquiera en cualquier momento. [Completa las limitaciones de responsabilidad con tu asesor.]
      </p>
      <h2>6. Contacto</h2>
      <p>{CONTACT_EMAIL}</p>
    </>
  );
}

export default function Legal() {
  const { pathname } = useLocation();
  const isTerms = pathname.startsWith('/terminos');
  useEffect(() => {
    const prev = document.title;
    document.title = `${isTerms ? 'Condiciones de uso' : 'Política de privacidad'} · KAI`;
    window.scrollTo(0, 0);
    return () => {
      document.title = prev;
    };
  }, [isTerms]);

  return (
    <div className="legal-page">
      <header className="row-between" style={{ marginBottom: 28 }}>
        <Logo to="/" />
        <nav className="row" style={{ gap: 16 }}>
          <Link to="/privacidad" className={isTerms ? 'muted' : ''}>
            Privacidad
          </Link>
          <Link to="/terminos" className={isTerms ? '' : 'muted'}>
            Condiciones
          </Link>
        </nav>
      </header>
      {TEMPLATE_PENDING && (
        <Callout tone="warning">
          Plantilla pendiente de completar por el titular del servicio: sustituye los datos entre [corchetes] en <code>frontend/src/pages/Legal.tsx</code> y revísala con un
          profesional antes de publicar KAI.
        </Callout>
      )}
      <article className="legal-body">{isTerms ? <Terms /> : <Privacy />}</article>
      <footer className="subtle small" style={{ marginTop: 40 }}>
        <Link to="/">Volver al inicio</Link>
      </footer>
    </div>
  );
}
