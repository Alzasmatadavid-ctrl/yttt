import { Link } from 'react-router';
import { CircleAlert, Info, Lightbulb, Lock, TrendingUp } from 'lucide-react';
import { Card } from './ui';

export interface Insight {
  key: string;
  tone: 'positive' | 'warning' | 'info';
  title: string;
  detail: string;
  action?: { label: string; to: string };
}

const TONE_ICON = { positive: TrendingUp, warning: CircleAlert, info: Info } as const;

/** “Lo que KAI ha aprendido”: recomendaciones calculadas con los datos reales del negocio. */
export function InsightsCard({ insights, locked, className }: { insights: Insight[]; locked?: boolean; className?: string }) {
  return (
    <Card title="Lo que KAI ha aprendido" icon={Lightbulb} className={className}>
      {locked ? (
        <div className="row" style={{ alignItems: 'flex-start', gap: 10 }}>
          <Lock size={16} className="subtle" aria-hidden style={{ marginTop: 2, flexShrink: 0 }} />
          <p className="muted small" style={{ margin: 0 }}>
            Las recomendaciones basadas en tus datos (qué origen funciona mejor, dónde se pierden los leads, objeciones más frecuentes…) están incluidas en los planes con
            analítica avanzada. <Link to="/app/ajustes?tab=plan" className="insight-link">Ver mi plan →</Link>
          </p>
        </div>
      ) : insights.length === 0 ? (
        <p className="muted small">
          Todavía no hay datos suficientes para sacar conclusiones fiables. Cuando tengas más leads y llamadas, aquí verás qué funciona mejor y dónde se pierden.
        </p>
      ) : (
        <ul className="insights">
          {insights.map((i) => {
            const Icon = TONE_ICON[i.tone];
            return (
              <li key={i.key} className={`insight insight-${i.tone}`}>
                <span className="insight-icon" aria-hidden>
                  <Icon size={16} />
                </span>
                <div className="col gap-4">
                  <strong className="small">{i.title}</strong>
                  <span className="muted small">{i.detail}</span>
                  {i.action && (
                    <Link to={i.action.to} className="small insight-link">
                      {i.action.label} →
                    </Link>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
