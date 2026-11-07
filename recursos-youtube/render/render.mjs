// =====================================================================
// Exporta las escenas HTML a vídeo MP4 (1920x1080, 30 fps, H.264)
// y guarda los fotogramas clave en PNG.
//
// Uso:
//   node render/render.mjs                 -> todas las escenas
//   node render/render.mjs 01 05           -> solo las escenas 01 y 05
//   node render/render.mjs --stills        -> solo fotogramas PNG
//   node render/render.mjs --check 01 2.5,8 -> PNG sueltos para revisar
//   node render/render.mjs --overlays      -> PNG transparentes (veredictos y capítulos)
// Requisitos: Node 18+, Playwright (Chromium) y ffmpeg instalados.
// =====================================================================
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require('/opt/node-tools/node_modules/playwright')); }

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCENES = path.join(ROOT, 'escenas');
const OUT_V = path.join(ROOT, 'videos');
const OUT_F = path.join(ROOT, 'fotogramas');
const FPS = 30;
const W = 1920, H = 1080;

const args = process.argv.slice(2);
const stillsOnly = args.includes('--stills');
const checkIdx = args.indexOf('--check');
const ids = args.filter((a) => /^\d\d$/.test(a));

// --- servidor estático mínimo ---
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg' };
const server = http.createServer((req, res) => {
  const p = path.join(SCENES, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!p.startsWith(SCENES) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream' });
  fs.createReadStream(p).pipe(res);
});
await new Promise((r) => server.listen(0, r));
const PORT = server.address().port;

const files = fs.readdirSync(SCENES).filter((f) => /^\d\d-.*\.html$/.test(f)).sort()
  .filter((f) => !ids.length || ids.includes(f.slice(0, 2)));

const browser = await chromium.launch();

async function openScene(file) {
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  page.on('pageerror', (e) => console.error(`[${file}]`, e.message));
  page.on('console', (m) => { if (m.type() === 'error') console.error(`[${file}]`, m.text()); });
  await page.goto(`http://localhost:${PORT}/${file}?render`);
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 30000 });
  const cdp = await page.context().newCDPSession(page);
  const shot = async (t) => {
    await page.evaluate((tt) => window.__seek(tt), t);
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', optimizeForSpeed: true, captureBeyondViewport: false });
    return Buffer.from(data, 'base64');
  };
  return { page, shot };
}

async function stills(file, times, dir = OUT_F, tag = '') {
  fs.mkdirSync(dir, { recursive: true });
  const { page } = await openScene(file);
  times = times ||(await page.evaluate(() => window.__stills));
  const base = file.replace('.html', '');
  for (let i = 0; i < times.length; i++) {
    const out = path.join(dir, `${base}${tag}_${String(i + 1).padStart(2, '0')}.png`);
    await page.evaluate((tt) => window.__seek(tt), times[i]);
    await page.screenshot({ path: out });
    console.log('  ·', path.relative(ROOT, out), `(t=${times[i]}s)`);
  }
  await page.close();
}

async function video(file) {
  fs.mkdirSync(OUT_V, { recursive: true });
  const { page, shot } = await openScene(file);
  const dur = await page.evaluate(() => window.__duration);
  const n = Math.round(dur * FPS);
  const out = path.join(OUT_V, file.replace('.html', '.mp4'));
  const ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'png', '-i', '-',
    '-vf', 'scale=out_color_matrix=bt709:out_range=tv,format=yuv420p',
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '17', '-x264-params', 'aq-mode=3',
    '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv',
    '-movflags', '+faststart', out], { stdio: ['pipe', 'inherit', 'inherit'] });
  const done = new Promise((r, j) => ff.on('close', (c) => (c === 0 ? r() : j(new Error('ffmpeg ' + c)))));
  const t0 = Date.now();
  for (let i = 0; i < n; i++) {
    const buf = await shot(i / FPS);
    if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once('drain', r));
  }
  ff.stdin.end();
  await done;
  await page.close();
  console.log(`  ✓ ${path.relative(ROOT, out)}  ${dur}s  ${n} fotogramas  ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}

// --- PNG transparentes para superponer en tus propios clips ---
async function overlays() {
  const dir = path.join(ROOT, 'overlays');
  fs.mkdirSync(dir, { recursive: true });
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  const jobs = [
    ...['opcional', 'recomendable', 'imprescindible'].map((n, i) => [`veredicto-${n}.png`, `mode=verdict&level=${i}`]),
    ...['Zapatillas', 'Straps', 'Cinturón', 'Bandas elásticas', 'Báscula corporal', 'Bioimpedancia', 'Cinta métrica', 'Trípode', 'Báscula de cocina', 'Tuppers']
      .map((n, i) => [`capitulo-${String(i + 1).padStart(2, '0')}.png`, `mode=chapter&chap=${i + 1}&name=${encodeURIComponent(n)}`]),
  ];
  for (const [name, qs] of jobs) {
    await page.goto(`http://localhost:${PORT}/overlays.html?render&t=10&${qs}`);
    await page.waitForFunction(() => window.__ready === true);
    await page.screenshot({ path: path.join(dir, name), omitBackground: true });
    console.log('  ·', 'overlays/' + name);
  }
  await page.close();
}

try {
  if (args.includes('--overlays')) {
    await overlays();
  } else if (checkIdx >= 0) {
    const id = args[checkIdx + 1];
    const times = args[checkIdx + 2].split(',').map(Number);
    const file = fs.readdirSync(SCENES).find((f) => f.startsWith(id + '-'));
    await stills(file, times, process.env.CHECK_DIR || path.join(ROOT, '.check'), '_chk');
  } else {
    // 3 escenas en paralelo
    const queue = [...files];
    const worker = async () => {
      while (queue.length) {
        const f = queue.shift();
        console.log('▶', f);
        await stills(f);
        if (!stillsOnly) await video(f);
      }
    };
    await Promise.all([worker(), worker(), worker()]);
  }
} finally {
  await browser.close();
  server.close();
}
