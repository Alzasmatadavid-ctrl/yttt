/* Piezas visuales de leads: etapa, temperatura, puntuación, origen y avatar. */
import { Flame, Snowflake, Sparkles, Thermometer, Globe, Webhook, PenLine, FlaskConical, Megaphone } from 'lucide-react';
import { leadSourceLabel, leadStatusLabel, temperatureLabel, type LeadSource, type LeadStatus, type LeadTemperature, type ChannelKey } from '@shared';
import { initials } from '../lib/format';

const STATUS_TONE: Record<LeadStatus, string> = {
  new: 'badge-info',
  contacted: '',
  conversing: 'badge-info',
  interested: 'badge-violet',
  qualified: 'badge-accent',
  call_proposed: 'badge-warning',
  call_booked: 'badge-success',
  reminder_sent: 'badge-success',
  no_show: 'badge-danger',
  follow_up: 'badge-warning',
  client: 'badge-accent',
  lost: '',
};

export function StatusBadge({ status }: { status: LeadStatus }) {
  return <span className={`badge badge-dot ${STATUS_TONE[status]}`}>{leadStatusLabel(status)}</span>;
}

const TEMP: Record<LeadTemperature, { cls: string; icon: typeof Flame }> = {
  frio: { cls: 'badge-info', icon: Snowflake },
  curioso: { cls: '', icon: Thermometer },
  interesado: { cls: 'badge-warning', icon: Thermometer },
  caliente: { cls: 'badge-hot', icon: Flame },
  muy_cualificado: { cls: 'badge-accent', icon: Sparkles },
};

export function TemperatureBadge({ temperature }: { temperature: LeadTemperature }) {
  const t = TEMP[temperature] ?? TEMP.frio;
  const Icon = t.icon;
  return (
    <span className={`badge ${t.cls}`}>
      <Icon aria-hidden />
      {temperatureLabel(temperature)}
    </span>
  );
}

export function scoreColor(score: number) {
  if (score >= 86) return { background: 'var(--accent-soft)', color: 'var(--accent-text)' };
  if (score >= 71) return { background: 'var(--hot-soft)', color: 'var(--hot)' };
  if (score >= 51) return { background: 'var(--warning-soft)', color: 'var(--warning)' };
  if (score >= 31) return { background: 'var(--slate-soft)', color: 'var(--text-2)' };
  return { background: 'var(--info-soft)', color: 'var(--info)' };
}

export function ScoreBadge({ score }: { score: number }) {
  return (
    <span className="score" style={scoreColor(score)} title="Puntuación interna (el lead no la ve)">
      {score}
    </span>
  );
}

export function WhatsAppIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden>
      <path fill="#25D366" d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2Z" />
      <path fill="#fff" d="M8.6 7.4c.2-.4.4-.4.6-.4h.5c.2 0 .4 0 .6.5l.8 1.9c.1.2.1.4 0 .6l-.4.6-.4.4c-.1.1-.3.3-.1.6.2.3.8 1.3 1.7 2.1 1.2 1 2.1 1.3 2.4 1.5.3.1.5.1.6-.1l.8-1c.2-.2.4-.2.6-.1l1.9.9c.3.1.4.2.5.3 0 .2 0 .9-.3 1.6-.3.7-1.6 1.4-2.2 1.4-.6.1-1.2.3-4.1-.9-3.4-1.4-5.5-4.8-5.7-5-.2-.2-1.4-1.8-1.4-3.4 0-1.6.9-2.4 1.1-2.8Z" />
    </svg>
  );
}

export function InstagramIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden>
      <defs>
        <linearGradient id="kai-ig" x1="0" y1="1" x2="1" y2="0">
          <stop offset="0" stopColor="#FEDA75" />
          <stop offset=".35" stopColor="#FA7E1E" />
          <stop offset=".65" stopColor="#D62976" />
          <stop offset="1" stopColor="#4F5BD5" />
        </linearGradient>
      </defs>
      <rect x="2" y="2" width="20" height="20" rx="6" fill="url(#kai-ig)" />
      <circle cx="12" cy="12" r="4.2" fill="none" stroke="#fff" strokeWidth="2" />
      <circle cx="17.3" cy="6.7" r="1.3" fill="#fff" />
    </svg>
  );
}

export function SourceIcon({ source, size = 14 }: { source: LeadSource | ChannelKey; size?: number }) {
  if (source === 'whatsapp') return <WhatsAppIcon size={size} />;
  if (source === 'instagram') return <InstagramIcon size={size} />;
  const Icon = source === 'meta_ads' ? Megaphone : source === 'landing' ? Globe : source === 'webhook' ? Webhook : source === 'simulator' || source === 'web' ? FlaskConical : PenLine;
  return <Icon size={size} aria-hidden style={{ color: 'var(--text-2)' }} />;
}

export function SourceBadge({ source }: { source: LeadSource }) {
  return (
    <span className="badge" style={{ gap: 6 }}>
      <SourceIcon source={source} size={12} />
      {leadSourceLabel(source)}
    </span>
  );
}

export function LeadAvatar({ name, url, size = 36, channel }: { name: string; url?: string | null; size?: number; channel?: LeadSource | ChannelKey }) {
  return (
    <span className="avatar" style={{ width: size, height: size, fontSize: Math.round(size * 0.36) }}>
      {url ? <img src={url} alt="" referrerPolicy="no-referrer" /> : initials(name)}
      {channel && (
        <span className="channel">
          <SourceIcon source={channel} size={11} />
        </span>
      )}
    </span>
  );
}
