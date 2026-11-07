/* =====================================================================
   KIT DE INICIO — Motor de animación determinista
   Cada escena define render(t): dado un segundo t, coloca todo en su
   sitio. Así el mismo código sirve para previsualizar en el navegador
   y para exportar fotograma a fotograma a vídeo (render/render.mjs).
   ===================================================================== */
window.K = (function () {
  const qs = new URLSearchParams(location.search);
  const RENDER = qs.has('render');
  const FIXED_T = qs.has('t') ? parseFloat(qs.get('t')) : null;
  const TOTAL = 10; // nº de herramientas de la serie

  /* ---------- utilidades ---------- */
  const clamp = (v, a = 0, b = 1) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, p) => a + (b - a) * p;
  const ease = {
    lin: (x) => x,
    out: (x) => 1 - Math.pow(1 - x, 3),
    out4: (x) => 1 - Math.pow(1 - x, 4),
    out5: (x) => 1 - Math.pow(1 - x, 5),
    in: (x) => x * x * x,
    in2: (x) => x * x,
    inOut: (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2),
    sine: (x) => -(Math.cos(Math.PI * x) - 1) / 2,
    expo: (x) => (x >= 1 ? 1 : 1 - Math.pow(2, -10 * x)),
    back: (x) => { const c1 = 1.5, c3 = c1 + 1; return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2); },
  };
  /** progreso 0..1 entre t0 y t0+d con easing */
  const P = (t, t0, d, e = 'out') => ease[e](clamp((t - t0) / d));
  /** ventana: entra en a, sale en b. Devuelve {i, o, v} */
  function win(t, a, b, din = 0.7, dout = 0.5, ein = 'out', eout = 'in2') {
    const i = P(t, a, din, ein);
    const o = b == null ? 0 : P(t, b, dout, eout);
    return { i, o, v: i * (1 - o) };
  }
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];

  /** transform/opacity/blur sobre elementos HTML */
  function set(el, o) {
    if (!el) return;
    if (Array.isArray(el)) return el.forEach((e) => set(e, o));
    const tr = [];
    if (o.x != null || o.y != null) tr.push(`translate(${(o.x || 0).toFixed(2)}px,${(o.y || 0).toFixed(2)}px)`);
    if (o.r != null) tr.push(`rotate(${o.r.toFixed(3)}deg)`);
    if (o.s != null) tr.push(`scale(${o.s.toFixed(4)})`);
    if (o.sx != null || o.sy != null) tr.push(`scale(${(o.sx ?? 1).toFixed(4)},${(o.sy ?? 1).toFixed(4)})`);
    if (tr.length || o.reset) el.style.transform = tr.join(' ');
    if (o.o != null) el.style.opacity = clamp(o.o).toFixed(4);
    if (o.blur != null) el.style.filter = o.blur > 0.05 ? `blur(${o.blur.toFixed(2)}px)` : 'none';
    if (o.clip != null) el.style.clipPath = o.clip;
  }
  /** transform sobre elementos SVG (atributo) */
  function svgT(el, o) {
    if (!el) return;
    const tr = [];
    if (o.x != null || o.y != null) tr.push(`translate(${(o.x || 0).toFixed(2)} ${(o.y || 0).toFixed(2)})`);
    if (o.r != null) tr.push(`rotate(${o.r.toFixed(3)} ${o.cx || 0} ${o.cy || 0})`);
    if (o.s != null || o.sx != null || o.sy != null) {
      const sx = o.sx ?? o.s ?? 1, sy = o.sy ?? o.s ?? 1, cx = o.cx || 0, cy = o.cy || 0;
      tr.push(`translate(${cx} ${cy}) scale(${sx.toFixed(4)} ${sy.toFixed(4)}) translate(${-cx} ${-cy})`);
    }
    el.setAttribute('transform', tr.join(' '));
    if (o.o != null) el.setAttribute('opacity', clamp(o.o).toFixed(4));
  }
  /** dibuja un trazo SVG de 0 a 1 */
  function draw(el, p) {
    if (!el) return;
    if (el._len == null) el._len = el.getTotalLength();
    el.style.strokeDasharray = `${el._len} ${el._len}`;
    el.style.strokeDashoffset = (el._len * (1 - clamp(p))).toFixed(2);
  }
  /** generador pseudoaleatorio determinista */
  function rng(seed = 1) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  /** curva suave (Catmull-Rom) que pasa por los puntos */
  function smooth(pts, closed = true, k = 1) {
    const n = pts.length; if (n < 2) return '';
    const g = (i) => (closed ? pts[(i + n) % n] : pts[clamp(i, 0, n - 1)]);
    let d = `M${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`;
    const last = closed ? n : n - 1;
    for (let i = 0; i < last; i++) {
      const p0 = g(i - 1), p1 = g(i), p2 = g(i + 1), p3 = g(i + 2);
      const c1 = [p1[0] + ((p2[0] - p0[0]) / 6) * k, p1[1] + ((p2[1] - p0[1]) / 6) * k];
      const c2 = [p2[0] - ((p3[0] - p1[0]) / 6) * k, p2[1] - ((p3[1] - p1[1]) / 6) * k];
      d += ` C${c1[0].toFixed(1)},${c1[1].toFixed(1)} ${c2[0].toFixed(1)},${c2[1].toFixed(1)} ${p2[0].toFixed(1)},${p2[1].toFixed(1)}`;
    }
    return d + (closed ? 'Z' : '');
  }

  /* ---------- texto: revelado por palabras ---------- */
  function split(el) {
    if (!el || el._split) return el;
    const walk = (node) => {
      [...node.childNodes].forEach((ch) => {
        if (ch.nodeType === 3) {
          const parts = ch.textContent.split(/(\s+)/);
          const frag = document.createDocumentFragment();
          parts.forEach((p) => {
            if (!p) return;
            if (/^\s+$/.test(p)) { frag.appendChild(document.createTextNode(' ')); return; }
            const w = document.createElement('span'); w.className = 'w';
            const wi = document.createElement('span'); wi.className = 'wi'; wi.textContent = p;
            w.appendChild(wi); frag.appendChild(w);
          });
          ch.replaceWith(frag);
        } else if (ch.nodeType === 1 && ch.tagName !== 'BR') walk(ch);
      });
    };
    walk(el); el._split = true; el._words = $$('.wi', el);
    return el;
  }
  /** revela palabras: entran desde abajo en t0, salen hacia arriba en tOut */
  function words(el, t, t0, tOut = null, st = 0.06, d = 0.75) {
    split(el);
    const ws = el._words, n = ws.length;
    ws.forEach((w, i) => {
      const pi = P(t, t0 + i * st, d, 'out4');
      const po = tOut == null ? 0 : P(t, tOut + i * st * 0.5, 0.5, 'in2');
      const y = (1 - pi) * 110 - po * 110;
      w.style.transform = `translateY(${y.toFixed(2)}%)`;
      w.style.opacity = (pi * (1 - po)).toFixed(3);
    });
    el.style.visibility = t < t0 - 0.01 ? 'hidden' : 'visible';
    return n;
  }

  /* ---------- componentes comunes ---------- */
  function chrome(num, name) {
    const host = $('.chrome') || $('#stage').appendChild(Object.assign(document.createElement('div'), { className: 'chrome' }));
    const ticks = Array.from({ length: TOTAL }, (_, i) => `<i class="${i + 1 < num ? 'done' : i + 1 === num ? 'on' : ''}"></i>`).join('');
    host.innerHTML = num
      ? `<div class="chap"><div class="chap-num">${String(num).padStart(2, '0')}</div><div><div class="chap-k">Kit de inicio</div><div class="chap-name">${name}</div></div></div>
         <div class="prog"><b>${String(num).padStart(2, '0')} / ${TOTAL}</b>${ticks}</div>`
      : `<div class="chap"><div class="chap-num">✓</div><div><div class="chap-k">Kit de inicio</div><div class="chap-name">${name}</div></div></div>`;
  }
  function chromeAnim(t) {
    const c = $('.chap'), p = $('.prog');
    const a = P(t, 0.15, 0.8, 'out4');
    set(c, { x: (1 - a) * -40, o: a });
    if (p) {
      set(p, { o: P(t, 0.35, 0.8) });
      $$('i', p).forEach((i, k) => set(i, { sx: P(t, 0.4 + k * 0.04, 0.5, 'out4'), o: 1 }));
    }
  }

  const LEVELS = ['Opcional', 'Recomendable', 'Imprescindible'];
  /** veredicto: level 0..2, ctx = contexto opcional, note = frase final */
  function verdict(el, level, note = '', ctx = '') {
    el.classList.add('verdict');
    el.innerHTML = `<div class="v-top"><div class="v-label">Veredicto</div><div class="v-ctx">${ctx}</div></div>
      <div class="v-bar"><div class="v-fill"></div>${LEVELS.map((l) => `<div class="v-seg">${l}</div>`).join('')}<div class="v-ring"></div></div>
      ${note ? `<div class="v-note">${note}</div>` : ''}`;
    el._level = level;
    return el;
  }
  function verdictAnim(el, t, t0, tOut = null) {
    const lv = el._level, segW = el.offsetWidth / 3;
    const w = win(t, t0, tOut, 0.7, 0.45);
    set(el, { y: (1 - w.i) * 40, o: w.v });
    const top = $('.v-top', el), bar = $('.v-bar', el), fill = $('.v-fill', el), ring = $('.v-ring', el), note = $('.v-note', el);
    set(top, { o: P(t, t0 + 0.1, 0.5) });
    // el relleno recorre los niveles hasta el elegido
    const travel = P(t, t0 + 0.45, 0.55 + lv * 0.35, 'inOut');
    const pos = travel * lv;
    const appear = P(t, t0 + 0.4, 0.3);
    fill.style.left = (pos * segW + 5).toFixed(1) + 'px';
    fill.style.width = (segW - 10).toFixed(1) + 'px';
    fill.style.opacity = appear;
    const segs = $$('.v-seg', el);
    segs.forEach((s, i) => {
      const near = clamp(1 - Math.abs(pos - i));
      const c = near * appear;
      s.style.color = c > 0.5 ? '#020913' : `rgba(169,191,232,${(0.55 + 0.45 * (i === lv ? P(t, t0 + 0.4, 0.4) : 0.2)).toFixed(2)})`;
    });
    const land = t0 + 0.45 + 0.55 + lv * 0.35;
    const pulse = P(t, land, 0.9, 'out');
    ring.style.left = (lv * segW).toFixed(1) + 'px';
    ring.style.width = segW.toFixed(1) + 'px';
    ring.style.opacity = t < land ? 0 : (1 - pulse).toFixed(3);
    ring.style.transform = `scale(${(1 + pulse * 0.18).toFixed(3)},${(1 + pulse * 0.5).toFixed(3)})`;
    if (note) set(note, { y: (1 - P(t, land - 0.1, 0.7, 'out4')) * 24, o: P(t, land - 0.1, 0.6) });
  }

  /** lista de ventajas/limitaciones */
  function list(el, items) {
    el.classList.add('list');
    el.innerHTML = items.map(([k, txt, sm]) => `<div class="li ${k}"><div class="mk">${k === 'pro' ? '+' : '–'}</div><div>${txt}${sm ? `<small>${sm}</small>` : ''}</div></div>`).join('');
    return el;
  }
  function listAnim(el, t, t0, tOut = null, st = 0.28) {
    $$('.li', el).forEach((li, i) => {
      const w = win(t, t0 + i * st, tOut, 0.7, 0.4);
      set(li, { x: (1 - w.i) * -36, o: w.v });
      set($('.mk', li), { s: 0.4 + 0.6 * P(t, t0 + i * st + 0.08, 0.6, 'back') });
    });
  }

  /** silueta humana frontal (se usa en cinta métrica y trípode) */
  function bodyPath(scale = 1, cx = 0, cy = 0, mod = null) {
    // mitad derecha (x>=0), de arriba (cuello) a abajo (entrepierna)
    const R = [
      [17, -318], [22, -296], [60, -284], [118, -270], [146, -252], [158, -222], [163, -180], [170, -120],
      [180, -62], [194, -8], [207, 44], [214, 78], [216, 100], [205, 112], [192, 100], [186, 72],
      [172, 20], [154, -40], [140, -96], [128, -150], [118, -110], [104, -60], [98, -24], [106, 14],
      [124, 58], [130, 110], [126, 170], [112, 240], [98, 300], [94, 330], [96, 380], [86, 440],
      [72, 492], [70, 510], [84, 528], [44, 534], [38, 508], [38, 480], [34, 420], [28, 360],
      [26, 320], [24, 270], [16, 180], [6, 130], [0, 124],
    ];
    const Rm = mod ? R.map(([x, y]) => mod(x, y)) : R;
    const L = Rm.slice(1, -1).map(([x, y]) => [-x, y]).reverse();
    const pts = [...Rm, ...L].map(([x, y]) => [cx + x * scale, cy + y * scale]);
    return smooth(pts, true, 0.9);
  }

  /* ---------- arranque ---------- */
  let def = null;
  function scene(d) { def = d; }
  let stage, cam, chromeEl;
  function applyGlobal(t) {
    const D = def.duration;
    const ex = P(t, D - 0.75, 0.75, 'in2');
    const drift = 1 + 0.025 * (t / D);
    set(cam, { s: drift * (1 - ex * 0.02), o: 1 - ex, blur: ex * 8 });
    set(chromeEl, { o: 1 - ex });
  }
  function frame(t) {
    def.render(t);
    if (def.chrome !== false) chromeAnim(t);
    applyGlobal(t);
  }
  function fit() {
    if (RENDER) { stage.style.transform = 'none'; return; }
    const ch = 52, s = Math.min(innerWidth / 1920, (innerHeight - ch) / 1080);
    stage.style.transform = `translate(${(innerWidth - 1920 * s) / 2}px,${(innerHeight - ch - 1080 * s) / 2}px) scale(${s})`;
  }
  async function boot() {
    stage = $('#stage'); cam = $('#cam');
    if (def.num !== undefined) chrome(def.num, def.name);
    chromeEl = $('.chrome');
    const fams = ['500 20px Montserrat', '700 20px Montserrat', '800 20px Montserrat', '900 20px Montserrat',
      '500 20px "Space Grotesk"', '700 20px "Space Grotesk"', '400 20px Inter', '500 20px Inter', '600 20px Inter',
      'italic 500 20px "Playfair Display"', 'italic 700 20px "Playfair Display"'];
    await Promise.all(fams.map((f) => document.fonts.load(f, 'ÁÉÍÓÚáéíóúñÑ¿¡ab')));
    await document.fonts.ready;
    // espera a que las fotos estén decodificadas antes del primer fotograma
    await Promise.all([...document.images].map((im) => (im.decode ? im.decode().catch(() => {}) : null)));
    if (def.setup) def.setup();
    window.__duration = def.duration;
    window.__stills = def.stills || [];
    window.__seek = (t) => frame(t);
    fit();
    if (RENDER || FIXED_T != null) { frame(FIXED_T ?? 0); window.__ready = true; return; }
    // Previsualización con controles
    const ctl = document.createElement('div'); ctl.id = 'ctl';
    ctl.innerHTML = `<button id="pp">Pausa</button><button id="rs">Reiniciar</button><input id="sc" type="range" min="0" max="${def.duration}" step="0.01" value="0"><span id="tm"></span>`;
    document.body.appendChild(ctl);
    let playing = true, t = 0, last = performance.now();
    const sc = $('#sc'), tm = $('#tm'), pp = $('#pp');
    pp.onclick = () => { playing = !playing; pp.textContent = playing ? 'Pausa' : 'Reproducir'; };
    $('#rs').onclick = () => { t = 0; playing = true; pp.textContent = 'Pausa'; };
    sc.oninput = () => { t = parseFloat(sc.value); playing = false; pp.textContent = 'Reproducir'; };
    addEventListener('keydown', (e) => { if (e.code === 'Space') { e.preventDefault(); pp.onclick(); } });
    addEventListener('resize', fit);
    const loop = (now) => {
      const dt = (now - last) / 1000; last = now;
      if (playing) { t += dt; if (t > def.duration) t = 0; }
      frame(t); sc.value = t; tm.textContent = `${t.toFixed(2)} / ${def.duration.toFixed(1)} s`;
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
    window.__ready = true;
  }
  document.addEventListener('DOMContentLoaded', () => boot().catch((e) => { console.error(e); document.title = 'ERROR ' + e.message; }));

  return { P, win, lerp, clamp, ease, $, $$, set, svgT, draw, rng, smooth, split, words, verdict, verdictAnim, list, listAnim, bodyPath, scene, RENDER };
})();
