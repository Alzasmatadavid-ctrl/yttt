export type Theme = 'dark' | 'light';
const KEY = 'kai.theme';

export function getTheme(): Theme {
  try {
    const t = localStorage.getItem(KEY);
    if (t === 'light' || t === 'dark') return t;
  } catch {
    /* almacenamiento no disponible */
  }
  return 'dark';
}

export function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#0B0C0E' : '#F4F5F7');
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    /* almacenamiento no disponible */
  }
}
