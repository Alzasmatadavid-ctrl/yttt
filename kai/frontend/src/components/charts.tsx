/**
 * Gráficas SVG ligeras (sin librerías), con:
 * - paleta categórica validada en orden fijo (el color sigue a la entidad, no al ranking),
 * - barras finas con extremo redondeado de 4px y separación de 2px entre segmentos,
 * - leyenda siempre visible con 2+ series, tooltip al pasar el ratón y tabla accesible.
 */
import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { leadSourceLabel, type LeadSource } from '@shared';

/** Orden fijo de origen → color de serie. */
export const SOURCE_ORDER: LeadSource[] = ['instagram', 'whatsapp', 'meta_ads', 'landing', 'webhook', 'manual'];
export const sourceColor = (s: string) => {
  const i = SOURCE_ORDER.indexOf(s as LeadSource);
  return `var(--series-${i >= 0 ? i + 1 : 7})`;
};

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(600);
  useLayoutEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([entry]) => setWidth(Math.max(200, Math.floor(entry.contentRect.width))));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return { ref, width };
}

function niceMax(v: number) {
  if (v <= 4) return 4;
  const pow = 10 ** Math.floor(Math.log10(v));
  const n = v / pow;
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return step * pow;
}

/** Barra con extremo superior redondeado (4px) y base recta. */
function barPath(x: number, y: number, w: number, h: number, r = 4) {
  if (h <= 0) return '';
  const rr = Math.min(r, h, w / 2);
  return `M${x},${y + h} L${x},${y + rr} Q${x},${y} ${x + rr},${y} L${x + w - rr},${y} Q${x + w},${y} ${x + w},${y + rr} L${x + w},${y + h} Z`;
}

export function Legend({ items }: { items: { label: string; color: string }[] }) {
  return (
    <div className="legend">
      {items.map((i) => (
        <span key={i.label} className="legend-item">
          <span className="legend-swatch" style={{ background: i.color }} />
          {i.label}
        </span>
      ))}
    </div>
  );
}

export interface StackedDatum {
  label: string; // etiqueta del eje X (día)
  fullLabel: string;
  values: Record<string, number>;
}

export function StackedBars({ data, keys, height = 220, labelFor = (k: string) => leadSourceLabel(k as LeadSource), colorFor = sourceColor, unit = 'leads' }: { data: StackedDatum[]; keys: string[]; height?: number; labelFor?: (k: string) => string; colorFor?: (k: string) => string; unit?: string }) {
  const { ref, width } = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const pad = { top: 10, right: 8, bottom: 26, left: 34 };
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;
  const totals = data.map((d) => keys.reduce((s, k) => s + (d.values[k] ?? 0), 0));
  const max = niceMax(Math.max(1, ...totals));
  const band = innerW / Math.max(1, data.length);
  const barW = Math.max(3, Math.min(24, band * 0.62));
  const ticks = [0, max / 2, max];
  const labelEvery = Math.ceil(data.length / Math.max(1, Math.floor(innerW / 54)));
  const GAP = 2;

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <svg className="chart" width={width} height={height} role="img" aria-label={`Gráfica de ${unit} por día`} onMouseLeave={() => setHover(null)}>
        {ticks.map((t) => {
          const y = pad.top + innerH - (t / max) * innerH;
          return (
            <g key={t}>
              <line className="gridline" x1={pad.left} x2={width - pad.right} y1={y} y2={y} />
              <text x={pad.left - 8} y={y + 4} textAnchor="end">
                {Math.round(t).toLocaleString('es-ES')}
              </text>
            </g>
          );
        })}
        {data.map((d, i) => {
          const x = pad.left + i * band + (band - barW) / 2;
          let yCursor = pad.top + innerH;
          const present = keys.filter((k) => (d.values[k] ?? 0) > 0);
          return (
            <g key={d.label + i}>
              {present.map((k, idx) => {
                const h = ((d.values[k] ?? 0) / max) * innerH;
                const isTop = idx === present.length - 1;
                const segH = Math.max(0, h - (idx > 0 ? GAP : 0));
                yCursor -= h;
                const y = yCursor + (idx > 0 ? 0 : 0);
                return isTop ? (
                  <path key={k} d={barPath(x, y, barW, segH)} fill={colorFor(k)} opacity={hover === null || hover === i ? 1 : 0.45} />
                ) : (
                  <rect key={k} x={x} y={y} width={barW} height={segH} fill={colorFor(k)} opacity={hover === null || hover === i ? 1 : 0.45} />
                );
              })}
              {i % labelEvery === 0 && (
                <text x={x + barW / 2} y={height - 8} textAnchor="middle">
                  {d.label}
                </text>
              )}
              <rect x={pad.left + i * band} y={pad.top} width={band} height={innerH} fill="transparent" onMouseEnter={() => setHover(i)} />
            </g>
          );
        })}
      </svg>
      {hover !== null && data[hover] && (
        <div className="chart-tooltip" style={{ left: Math.min(width - 160, Math.max(0, pad.left + hover * band + band / 2 - 70)), top: 0 }}>
          <div style={{ fontWeight: 650, marginBottom: 4 }}>{data[hover].fullLabel}</div>
          {keys
            .filter((k) => (data[hover].values[k] ?? 0) > 0)
            .map((k) => (
              <div key={k} className="row-between" style={{ gap: 14 }}>
                <span className="row gap-4">
                  <span className="legend-swatch" style={{ background: colorFor(k) }} />
                  {labelFor(k)}
                </span>
                <span className="tnum">{data[hover].values[k]}</span>
              </div>
            ))}
          <div className="row-between subtle mt-4" style={{ gap: 14 }}>
            <span>Total</span>
            <span className="tnum">{totals[hover]}</span>
          </div>
        </div>
      )}
      {keys.length >= 2 && (
        <div className="mt-8">
          <Legend items={keys.map((k) => ({ label: labelFor(k), color: colorFor(k) }))} />
        </div>
      )}
      {/* Tabla accesible: envuelta en un div porque una <table> ignora el alto de 1px y alargaba la página. */}
      <div className="sr-only">
      <table>
        <caption>{`${unit} por día`}</caption>
        <thead>
          <tr>
            <th>Día</th>
            {keys.map((k) => (
              <th key={k}>{labelFor(k)}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.map((d) => (
            <tr key={d.fullLabel}>
              <td>{d.fullLabel}</td>
              {keys.map((k) => (
                <td key={k}>{d.values[k] ?? 0}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      </div>
    </div>
  );
}

/** Serie única (p. ej. llamadas agendadas por día): sin leyenda, el título la nombra. */
export function SimpleBars({ data, height = 160, color = 'var(--series-1)', unit }: { data: { label: string; fullLabel: string; value: number }[]; height?: number; color?: string; unit: string }) {
  const stacked = useMemo(() => data.map((d) => ({ label: d.label, fullLabel: d.fullLabel, values: { v: d.value } })), [data]);
  return <StackedBars data={stacked} keys={['v']} height={height} labelFor={() => unit} colorFor={() => color} unit={unit} />;
}

/** Embudo horizontal: etapas ordinales con rampa secuencial de un solo tono. */
export function Funnel({ steps }: { steps: { label: string; value: number; hint?: ReactNode }[] }) {
  const max = Math.max(1, steps[0]?.value ?? 1);
  return (
    <div className="col" style={{ gap: 10 }}>
      {steps.map((s, i) => {
        const pctOfFirst = Math.round((s.value / max) * 1000) / 10;
        const prev = i > 0 ? steps[i - 1].value : null;
        const stepRate = prev ? Math.round((s.value / Math.max(1, prev)) * 1000) / 10 : null;
        const fmt = (n: number) => `${n.toLocaleString('es-ES', { maximumFractionDigits: 1 })}%`;
        return (
          <div key={s.label} className="funnel-row" title={stepRate !== null ? `${s.value} · ${fmt(stepRate)} respecto a «${steps[i - 1].label}» · ${fmt(pctOfFirst)} del total` : `${s.value}`}>
            <span className="muted ellipsis">{s.label}</span>
            <div className="funnel-track">
              <div className="funnel-bar" style={{ width: `${Math.max(s.value > 0 ? 2 : 0, (s.value / max) * 100)}%`, background: `var(--funnel-${Math.min(5, i + 1)})` }} />
            </div>
            <span className="tnum" style={{ textAlign: 'right' }}>
              <strong>{s.value.toLocaleString('es-ES')}</strong>
              {stepRate !== null && <span className="subtle xs"> · {fmt(stepRate)}</span>}
            </span>
          </div>
        );
      })}
      {steps.length > 1 && <p className="subtle xs">El porcentaje indica cuántos pasan de cada paso al siguiente.</p>}
    </div>
  );
}

/** Medidor simple (uso del plan). */
export function Meter({ value, max, label }: { value: number; max: number | null; label: string }) {
  const ratio = max ? Math.min(1, value / max) : 0;
  const color = ratio > 0.9 ? 'var(--danger)' : ratio > 0.75 ? 'var(--warning)' : 'var(--accent)';
  return (
    <div className="col gap-4">
      <div className="row-between small">
        <span className="muted">{label}</span>
        <span className="tnum">
          {value.toLocaleString('es-ES')} / {max === null ? '∞' : max.toLocaleString('es-ES')}
        </span>
      </div>
      <div style={{ height: 8, borderRadius: 8, background: 'var(--surface-3)', overflow: 'hidden' }}>
        <div style={{ width: `${max === null ? 4 : ratio * 100}%`, height: '100%', background: color, borderRadius: 8 }} />
      </div>
    </div>
  );
}
