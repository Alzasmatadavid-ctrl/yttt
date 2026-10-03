import { Link } from 'react-router';

/** Marca de KAI: una “K” formada por una barra y un chevrón de velocidad. */
export function LogoMark({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden>
      <rect width="64" height="64" rx="16" fill="var(--accent)" />
      <path d="M21 15v34" stroke="var(--accent-ink)" strokeWidth="7.5" strokeLinecap="round" />
      <path d="M45 15 28.5 32 45 49" fill="none" stroke="var(--accent-ink)" strokeWidth="7.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function Logo({ to = '/', size = 28 }: { to?: string; size?: number }) {
  return (
    <Link to={to} className="logo" aria-label="KAI — inicio">
      <LogoMark size={size} />
      <span className="logo-word">KAI</span>
    </Link>
  );
}
