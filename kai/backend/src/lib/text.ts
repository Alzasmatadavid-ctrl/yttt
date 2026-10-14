/** Utilidades de texto en español. */
export function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Minúsculas y sin tildes conservando la longitud (para mapear posiciones al texto original). */
export function fold(text: string): string {
  return text
    .normalize('NFC')
    .split('')
    .map((ch) => ch.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().charAt(0) || ch)
    .join('');
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1).trimEnd() + '…';
}

export function firstName(name: string | null | undefined): string {
  if (!name) return '';
  const first = name.trim().split(/\s+/)[0] ?? '';
  return first.charAt(0).toUpperCase() + first.slice(1);
}

const EMOJI_RE = /\p{Extended_Pictographic}/gu;
export const countEmojis = (text: string) => (text.match(EMOJI_RE) ?? []).length;

export function slugify(text: string): string {
  return normalize(text)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

export function pick<T>(items: readonly T[], seed?: number): T {
  const i = seed === undefined ? Math.floor(Math.random() * items.length) : Math.abs(seed) % items.length;
  return items[i];
}

export function hashString(text: string): number {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (Math.imul(31, h) + text.charCodeAt(i)) | 0;
  return h;
}
