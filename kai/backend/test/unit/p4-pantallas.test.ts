/*
 * Pantallas de trabajo diario (revisión p4, grupo r2-pantallas). La lógica vive en frontend/src/pages; aquí se prueba
 * con datos sueltos y, cuando importa lo que manda el servidor, con la API real.
 *  - leave-guard: «¿Salir sin guardar?» retiene también las navegaciones hechas desde código (campana, Copilot,
 *    botones) y Atrás/Adelante del navegador, no solo los <a>; cambiar de pestaña (?tab=) no pregunta.
 *  - agenda-days: la lista por días del móvil agrupa las citas por el día del negocio y las ordena por hora.
 *  - Las vistas móviles previstas en layout.css (tarjetas de Leads, lista de la Agenda, barra de etapas del Pipeline,
 *    editor de franjas) están conectadas en las páginas, y los textos ocultos del Pipeline no ensanchan la página.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { futureLocal, openAgenda, registerTrainer, setupTestApp, teardownTestApp } from '../integration/helpers.js';

type Path = { pathname?: string; search?: string; hash?: string };
type LeaveGuard = {
  leavesPage: (to: string | Path, currentPathname: string) => boolean;
  shouldHoldNavigation: (dirty: boolean, nav: { currentLocation: { pathname: string }; nextLocation: Path }) => boolean;
};
type ApptLike = { appointment: { id: string; startsAt: string } };
type AgendaDays = {
  appointmentsByDay: <T extends ApptLike>(days: string[], appts: T[], timeZone: string) => { iso: string; appts: T[] }[];
  dayTitle: (iso: string) => string;
  addDaysIso: (iso: string, days: number) => string;
  tzParts: (d: Date, timeZone: string) => { iso: string; hour: number; minute: number };
};

// Se cargan por ruta: así la web no entra en la compilación del servidor (tsc) y vitest la transforma igual.
const here = path.dirname(fileURLToPath(import.meta.url));
const web = (file: string) => path.join(here, '../../../frontend/src', file);
const source = (file: string) => readFileSync(web(file), 'utf8');
let guard: LeaveGuard;
let days: AgendaDays;

let app: FastifyInstance;
beforeAll(async () => {
  guard = (await import(web('pages/leave-guard.ts'))) as LeaveGuard;
  days = (await import(web('pages/agenda-days.ts'))) as AgendaDays;
  app = await setupTestApp();
});
afterAll(async () => {
  await teardownTestApp(app);
});

describe('«¿Salir sin guardar?»: qué navegaciones se retienen', () => {
  it('ir a otra pantalla sale de la página; cambiar solo la pestaña o el ancla, no', () => {
    expect(guard.leavesPage({ pathname: '/app/leads', search: '', hash: '' }, '/app/agenda')).toBe(true);
    expect(guard.leavesPage('/app/inbox/123', '/app/agenda')).toBe(true);
    // setParams de las pestañas: misma ruta con otro ?tab=
    expect(guard.leavesPage({ pathname: '/app/agenda', search: '?tab=disponibilidad', hash: '' }, '/app/agenda')).toBe(false);
    expect(guard.leavesPage('?tab=equipo', '/app/ajustes')).toBe(false);
    expect(guard.leavesPage({ hash: '#arriba' }, '/app/setter')).toBe(false);
  });

  it('con cambios sin guardar retiene toda navegación a otra pantalla (también Atrás/Adelante) y deja pasar el resto', () => {
    const from = { pathname: '/app/agenda' };
    // Aviso de la campana o tarjeta de Copilot (navigate), menú lateral (<Link>) o Atrás del navegador: con un router
    // de datos todas pasan por useBlocker con la ubicación de destino.
    expect(guard.shouldHoldNavigation(true, { currentLocation: from, nextLocation: { pathname: '/app/inbox/abc', search: '', hash: '' } })).toBe(true);
    expect(guard.shouldHoldNavigation(true, { currentLocation: from, nextLocation: { pathname: '/app/leads', search: '', hash: '' } })).toBe(true);
    // Cambio de pestaña dentro de la Agenda: pasa sin preguntar.
    expect(guard.shouldHoldNavigation(true, { currentLocation: from, nextLocation: { pathname: '/app/agenda', search: '?tab=disponibilidad', hash: '' } })).toBe(false);
    // Sin cambios pendientes, nunca pregunta.
    expect(guard.shouldHoldNavigation(false, { currentLocation: from, nextLocation: { pathname: '/app/leads', search: '', hash: '' } })).toBe(false);
  });

  it('useBlocker necesita el router de datos: main.tsx usa createBrowserRouter y RouterProvider (no <BrowserRouter>)', () => {
    const main = source('main.tsx');
    expect(main).toMatch(/createBrowserRouter\(/);
    expect(main).toMatch(/<RouterProvider router=\{router\} \/>/);
    expect(main).not.toMatch(/<BrowserRouter>/);
    const leaveGuard = source('pages/leave-guard.ts');
    expect(leaveGuard).toMatch(/useBlocker\(\(nav\) => shouldHoldNavigation\(dirty, nav\)\)/);
  });

  it('Agenda, Setter IA y Ajustes usan el mismo aviso (Ajustes → Negocio no lo tenía)', () => {
    for (const file of ['pages/Agenda.tsx', 'pages/setter/SetterSettings.tsx', 'pages/settings/Settings.tsx']) {
      const src = source(file);
      expect(src, file).toMatch(/useLeaveGuard\(/);
      expect(src, file).toMatch(/open=\{leave\.leaving\}/);
      expect(src, file).toContain('¿Salir sin guardar?');
      // El aviso antiguo solo miraba los clics en <a href>: no cubría navigate() de la campana ni de Copilot.
      expect(src, file).not.toContain("closest<HTMLAnchorElement>('a[href]')");
    }
  });
});

describe('Agenda en el móvil: lista por días', () => {
  it('agrupa por el día del negocio (no el de UTC) y ordena por hora', () => {
    const week = ['2026-10-05', '2026-10-06', '2026-10-07'];
    const appts = [
      { appointment: { id: 'tarde', startsAt: '2026-10-06T16:00:00.000Z' } }, // 18:00 en Madrid
      { appointment: { id: 'madrugada', startsAt: '2026-10-05T22:30:00.000Z' } }, // 00:30 del martes en Madrid
      { appointment: { id: 'mañana', startsAt: '2026-10-06T08:00:00.000Z' } }, // 10:00
      { appointment: { id: 'otra-semana', startsAt: '2026-10-20T08:00:00.000Z' } },
    ];
    const byDay = days.appointmentsByDay(week, appts, 'Europe/Madrid');
    expect(byDay.map((d) => [d.iso, d.appts.map((a) => a.appointment.id)])).toEqual([
      ['2026-10-05', []],
      ['2026-10-06', ['madrugada', 'mañana', 'tarde']],
      ['2026-10-07', []],
    ]);
    // En Nueva York la «madrugada» de Madrid sigue siendo lunes.
    expect(days.appointmentsByDay(week, appts, 'America/New_York')[0].appts.map((a) => a.appointment.id)).toEqual(['madrugada']);
  });

  it('títulos de día legibles: solo la primera letra en mayúscula', () => {
    expect(days.dayTitle('2026-10-05')).toBe('Lunes, 5 de octubre');
    expect(days.dayTitle('2026-11-01')).toBe('Domingo, 1 de noviembre');
  });

  it('con las citas que devuelve la API, cada una cae en su día y en orden', async () => {
    const T = await registerTrainer(app, { businessName: 'Agenda móvil P4' });
    await openAgenda(T.client);
    const book = async (name: string, start: Date) => {
      const lead = await T.client.post('/api/leads', { name });
      expect(lead.statusCode, lead.body).toBe(200);
      const res = await T.client.post('/api/agenda/appointments', { leadId: lead.json().lead.id, start: start.toISOString() });
      expect(res.statusCode, res.body).toBe(200);
      return res.json().appointment.id as string;
    };
    // Se reservan desordenadas; la de las 00:30 es del día anterior en UTC.
    const late = await book('Óscar Tarde', futureLocal(3, 18));
    const night = await book('Nacho Noche', futureLocal(3, 0, 30));
    const morning = await book('Mario Mañana', futureLocal(3, 10));
    const other = await book('Pedro Otro', futureLocal(4, 12));

    const res = await T.client.get('/api/agenda/appointments', {
      query: { from: new Date(Date.now() - 86_400_000).toISOString(), to: new Date(Date.now() + 10 * 86_400_000).toISOString() },
    });
    expect(res.statusCode, res.body).toBe(200);
    const day3 = days.tzParts(futureLocal(3, 12), 'Europe/Madrid').iso;
    const byDay = days.appointmentsByDay([day3, days.addDaysIso(day3, 1)], res.json().appointments as ApptLike[], 'Europe/Madrid');
    expect(byDay[0].appts.map((a) => a.appointment.id)).toEqual([night, morning, late]);
    expect(byDay[1].appts.map((a) => a.appointment.id)).toEqual([other]);
  });
});

describe('Vistas móviles de layout.css conectadas en las páginas', () => {
  const css = source('styles/layout.css');
  const rule = (selector: string) => {
    const start = css.indexOf(`\n${selector} {`);
    expect(start, `falta la regla ${selector}`).toBeGreaterThan(-1);
    return css.slice(start, css.indexOf('}', start));
  };

  it('Leads: filtros, tabla en escritorio y tarjetas en el móvil', () => {
    const src = source('pages/Leads.tsx');
    for (const cls of ['leads-filters', 'leads-table', 'leads-cards', 'lead-row-card']) {
      expect(src, cls).toContain(cls);
      expect(css, cls).toContain(`.${cls}`);
    }
    // Sin anchos fijos en los filtros: en el móvil van a media columna.
    expect(src).not.toMatch(/style=\{\{ width: 1[789]0 \}\}/);
  });

  it('Agenda: rejilla semanal en escritorio, lista por días en el móvil y franjas que caben', () => {
    const src = source('pages/Agenda.tsx');
    for (const cls of ['week-wrap', 'agenda-list', 'agenda-day', 'agenda-day-title', 'agenda-appt', 'avail-row', 'avail-day', 'avail-ranges', 'avail-range']) {
      expect(src, cls).toContain(cls);
      expect(css, cls).toContain(`.${cls}`);
    }
    // Los campos de hora ya no llevan 120 px fijos (en el móvil se encogen y «+ Franja» baja a su línea).
    expect(src).not.toContain('style={{ width: 120 }}');
    expect(css).toMatch(/\.avail-row \.avail-ranges \{\s*flex-basis: 100%/);
  });

  it('Pipeline: barra de etapas y textos ocultos contenidos en la tarjeta', () => {
    const src = source('pages/Pipeline.tsx');
    expect(src).toContain('className="board-nav"');
    expect(src).toContain('id={`board-col-${s.key}`}');
    // Sin un antepasado posicionado, los .sr-only de «Mover» escapaban del tablero y ensanchaban la página a 3.800 px.
    expect(rule('.lead-card')).toMatch(/position: relative/);
  });
});
