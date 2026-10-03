/* Pestaña «Puntuación»: bandas de temperatura (0–100) y umbral para proponer la llamada. */
import { useId } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Gauge, Lock, PhoneCall, RotateCcw } from 'lucide-react';
import { DEFAULT_SCORE_BANDS, LEAD_TEMPERATURES, type LeadTemperature, type ScoreBand } from '@shared';
import { api, errorText } from '../../lib/api';
import { Button, Callout, Card, Field, useToast } from '../../components/ui';
import { TemperatureBadge } from '../../components/lead-bits';
import { NumInput, SaveBar, useDraft, useReportDirty, type TabProps } from './setter-shared';

interface ScoringDraft {
  bands: ScoreBand[];
  proposeCallMinScore: number;
}

const ORDER = LEAD_TEMPERATURES.map((t) => t.key) as LeadTemperature[];

const BAND_COLORS: Record<LeadTemperature, { bg: string; fg: string }> = {
  frio: { bg: 'var(--info-soft)', fg: 'var(--info)' },
  curioso: { bg: 'var(--slate-soft)', fg: 'var(--text-2)' },
  interesado: { bg: 'var(--warning-soft)', fg: 'var(--warning)' },
  caliente: { bg: 'var(--hot-soft)', fg: 'var(--hot)' },
  muy_cualificado: { bg: 'var(--accent-soft)', fg: 'var(--accent-text)' },
};

const BAND_MEANING: Record<LeadTemperature, string> = {
  frio: 'Apenas sabemos nada de él o no muestra interés real.',
  curioso: 'Pregunta y se interesa, pero aún sin compromiso.',
  interesado: 'Ha contado su objetivo y muestra intención.',
  caliente: 'Encaja bien y tiene motivación: buen candidato para la llamada.',
  muy_cualificado: 'Lo tiene todo: objetivo claro, urgencia, compromiso y encaje.',
};

function normalizeBands(bands: ScoreBand[] | null | undefined): ScoreBand[] {
  const src = Array.isArray(bands) && bands.length === 5 ? bands : DEFAULT_SCORE_BANDS;
  return ORDER.map((key) => {
    const b = src.find((x) => x.key === key) ?? DEFAULT_SCORE_BANDS.find((x) => x.key === key)!;
    return { key, label: b.label, min: b.min, max: b.max };
  });
}

/** Misma validación que el servidor: bandas consecutivas que cubren 0–100 sin huecos ni solapes. */
function bandsError(bands: ScoreBand[]): string | null {
  for (const b of bands) {
    if (!Number.isInteger(b.min) || !Number.isInteger(b.max)) return `Usa números enteros en «${b.label}».`;
    if (b.min < 0 || b.max > 100 || b.max < 0 || b.min > 100) return `Los valores de «${b.label}» deben estar entre 0 y 100.`;
  }
  if (bands[0].min !== 0) return `La primera banda («${bands[0].label}») debe empezar en 0.`;
  if (bands[bands.length - 1].max !== 100) return `La última banda («${bands[bands.length - 1].label}») debe terminar en 100.`;
  for (let i = 0; i < bands.length; i++) {
    const b = bands[i];
    if (b.min > b.max) return `En «${b.label}», el valor «desde» no puede ser mayor que «hasta».`;
    if (i > 0 && b.min !== bands[i - 1].max + 1) return `Entre «${bands[i - 1].label}» y «${b.label}» hay un hueco o un solapamiento: «${b.label}» debería empezar en ${bands[i - 1].max + 1}.`;
  }
  return null;
}

function bandFor(score: number, bands: ScoreBand[]): ScoreBand | undefined {
  let found: ScoreBand | undefined = bands[0];
  for (const b of [...bands].sort((a, z) => a.min - z.min)) if (score >= b.min) found = b;
  return found;
}

export default function ScoringTab({ settings, canEdit, onDirtyChange }: TabProps) {
  const qc = useQueryClient();
  const toast = useToast();
  const thresholdId = useId();
  const { draft, base, setDraft, dirty, reset, markSaved } = useDraft<ScoringDraft>({
    bands: normalizeBands(settings.aiSettings.scoreBands),
    proposeCallMinScore: settings.aiSettings.proposeCallMinScore,
  });
  useReportDirty(onDirtyChange, dirty);

  const bandsErr = bandsError(draft.bands);
  const thresholdErr =
    !Number.isInteger(draft.proposeCallMinScore) || draft.proposeCallMinScore < 0 || draft.proposeCallMinScore > 100 ? 'La puntuación para proponer la llamada debe ser un número entero entre 0 y 100.' : null;
  const error = bandsErr ?? thresholdErr;
  const isDefault = JSON.stringify(draft.bands.map((b) => [b.min, b.max])) === JSON.stringify(normalizeBands(DEFAULT_SCORE_BANDS).map((b) => [b.min, b.max]));

  /** Al cambiar un límite, ajusta la banda vecina para que no queden huecos. */
  const setLimit = (index: number, edge: 'min' | 'max', value: number) =>
    setDraft((d) => {
      const bands = d.bands.map((b) => ({ ...b }));
      bands[index][edge] = value;
      if (Number.isInteger(value)) {
        if (edge === 'max' && index < bands.length - 1) bands[index + 1].min = value + 1;
        if (edge === 'min' && index > 0) bands[index - 1].max = value - 1;
      }
      return { ...d, bands };
    });

  const save = useMutation({
    mutationFn: async () => {
      const bandsChanged = JSON.stringify(draft.bands) !== JSON.stringify(base.bands);
      const thresholdChanged = draft.proposeCallMinScore !== base.proposeCallMinScore;
      if (bandsChanged) await api.put('/settings/score-bands', { bands: draft.bands });
      if (thresholdChanged) await api.put('/settings/ai', { proposeCallMinScore: draft.proposeCallMinScore });
      return bandsChanged;
    },
    onSuccess: (bandsChanged) => {
      markSaved();
      toast(bandsChanged ? 'Puntuación guardada. Hemos actualizado la temperatura de tus leads con las nuevas bandas.' : 'Puntuación guardada');
      void qc.invalidateQueries({ queryKey: ['settings'] });
      if (bandsChanged) for (const key of ['leads', 'lead', 'dashboard', 'inbox', 'conversation', 'analytics']) void qc.invalidateQueries({ queryKey: [key] });
    },
    onError: (e) => {
      toast(errorText(e), 'error');
      // Puede haberse guardado una parte: recargamos para mostrar el estado real.
      void qc.invalidateQueries({ queryKey: ['settings'] });
    },
  });

  const thresholdBand = bandFor(draft.proposeCallMinScore, draft.bands);
  const markerLeft = Math.min(100, Math.max(0, draft.proposeCallMinScore));

  return (
    <>
      <p className="setter-lead">
        KAI puntúa a cada lead de 0 a 100 según lo que va sabiendo de él (con las variables y pesos de la pestaña «Cualificación»). Según la puntuación, el lead recibe una temperatura: de «Frío» a «Muy cualificado».
      </p>
      <Callout tone="accent" icon={Lock}>
        La puntuación es interna: solo la ves tú y tu equipo. El lead nunca la ve ni sabe que existe.
      </Callout>

      <Card
        title="Bandas de temperatura"
        icon={Gauge}
        actions={
          <Button size="sm" variant="ghost" icon={RotateCcw} disabled={isDefault} onClick={() => setDraft((d) => ({ ...d, bands: normalizeBands(DEFAULT_SCORE_BANDS) }))}>
            Valores recomendados
          </Button>
        }
      >
        <div className="setter-bandbar-wrap" aria-hidden>
          <div className="setter-bandbar">
            {draft.bands.map((b) => {
              const width = Math.max(0, Math.min(b.max, 100) - Math.max(b.min, 0) + 1);
              const c = BAND_COLORS[b.key];
              return (
                <div key={b.key} className="setter-bandbar-seg" style={{ flexGrow: width, flexBasis: 0, background: c.bg, color: c.fg }} title={`${b.label}: ${b.min}–${b.max}`}>
                  {width >= 12 && b.label}
                  {width >= 8 && (
                    <span>
                      {b.min}–{b.max}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
          {!thresholdErr && (
            <>
              <div className="setter-marker" style={{ left: `${markerLeft}%` }} />
              <div className="setter-marker-label" style={{ left: `clamp(60px, ${markerLeft}%, calc(100% - 60px))` }}>
                Propone llamada: {draft.proposeCallMinScore}
              </div>
            </>
          )}
          <div className="setter-scale">
            <span>0</span>
            <span>50</span>
            <span>100</span>
          </div>
        </div>

        <div className="mt-16">
          {draft.bands.map((b, i) => {
            const size = b.max - b.min + 1;
            return (
              <div key={b.key} className="setter-band-row">
                <div className="setter-band-name col gap-4" style={{ alignItems: 'flex-start' }}>
                  <TemperatureBadge temperature={b.key} />
                  <span className="subtle xs">{BAND_MEANING[b.key]}</span>
                </div>
                <Field label="Desde" htmlFor={`band-${b.key}-min`} hint={i === 0 ? 'Siempre empieza en 0.' : undefined}>
                  <NumInput id={`band-${b.key}-min`} value={b.min} min={0} max={100} width={90} disabled={i === 0} onChange={(v) => setLimit(i, 'min', v)} />
                </Field>
                <Field label="Hasta" htmlFor={`band-${b.key}-max`} hint={i === draft.bands.length - 1 ? 'Siempre termina en 100.' : undefined}>
                  <NumInput id={`band-${b.key}-max`} value={b.max} min={0} max={100} width={90} disabled={i === draft.bands.length - 1} onChange={(v) => setLimit(i, 'max', v)} />
                </Field>
                <div className="setter-band-size">{Number.isFinite(size) && size > 0 ? `${size} ${size === 1 ? 'punto' : 'puntos'}` : '—'}</div>
              </div>
            );
          })}
        </div>
        <p className="subtle xs mt-12">Al cambiar el límite de una banda, ajustamos la siguiente para que no queden huecos. Al guardar, la temperatura de tus leads se actualiza con las nuevas bandas.</p>
        {bandsErr && (
          <div className="mt-12">
            <Callout tone="danger">{bandsErr}</Callout>
          </div>
        )}
      </Card>

      <Card title="¿Cuándo propone KAI la llamada?" icon={PhoneCall}>
        <p className="muted small" style={{ marginBottom: 14 }}>
          KAI propone la llamada por su cuenta cuando la puntuación del lead llega a este valor y ya conoce la información marcada como obligatoria en «Cualificación». Si el lead pide la llamada antes, KAI se la ofrece igualmente.
        </p>
        <Field label="Puntuación mínima para proponer la llamada" htmlFor={thresholdId} error={thresholdErr}>
          <div className="row wrap" style={{ gap: 12 }}>
            <input
              type="range"
              className="range grow"
              min={0}
              max={100}
              step={1}
              value={markerLeft}
              aria-label="Puntuación mínima para proponer la llamada (control deslizante)"
              style={{ minWidth: 180 }}
              onChange={(e) => setDraft((d) => ({ ...d, proposeCallMinScore: Number(e.target.value) }))}
            />
            <NumInput id={thresholdId} value={draft.proposeCallMinScore} min={0} max={100} width={90} suffix="de 100" invalid={Boolean(thresholdErr)} onChange={(v) => setDraft((d) => ({ ...d, proposeCallMinScore: v }))} />
          </div>
        </Field>
        {!thresholdErr && thresholdBand && (
          <p className="small mt-8 row wrap" style={{ gap: 6 }}>
            Equivale a leads desde la banda <TemperatureBadge temperature={thresholdBand.key} />
          </p>
        )}
        <p className="subtle xs mt-8">Valor por defecto: 60. Si lo subes, KAI propondrá menos llamadas pero con leads más preparados; si lo bajas, propondrá la llamada antes.</p>
      </Card>

      <SaveBar dirty={dirty} saving={save.isPending} canEdit={canEdit} error={error} onDiscard={reset} onSave={() => save.mutate()} saveLabel="Guardar puntuación" />
    </>
  );
}
