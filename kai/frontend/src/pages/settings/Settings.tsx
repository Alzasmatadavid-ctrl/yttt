/* Página «Ajustes»: negocio, equipo, plan y cuenta, en pestañas sincronizadas con ?tab=. */
import { useCallback, useEffect, useState, type KeyboardEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { Lock, SlidersHorizontal } from 'lucide-react';
import { useAuth } from '../../lib/auth';
import { Button, Callout, PageHeader } from '../../components/ui';
import BusinessTab from './BusinessTab';
import TeamTab from './TeamTab';
import PlanTab from './PlanTab';
import AccountTab from './AccountTab';
import '../../styles/settings.css';

const TABS = [
  { value: 'negocio', label: 'Negocio' },
  { value: 'equipo', label: 'Equipo' },
  { value: 'plan', label: 'Plan y uso' },
  { value: 'cuenta', label: 'Tu cuenta' },
] as const;

type TabKey = (typeof TABS)[number]['value'];
const TAB_KEYS = TABS.map((t) => t.value) as TabKey[];
const isTabKey = (v: string | null): v is TabKey => v !== null && (TAB_KEYS as string[]).includes(v);

const DESCRIPTIONS: Record<TabKey, string> = {
  negocio: 'Los datos básicos de tu negocio y tu perfil profesional, que KAI usa para presentarte ante los leads.',
  equipo: 'Quién tiene acceso a este negocio y qué puede hacer cada persona.',
  plan: 'Tu plan, cuánto has usado este mes y qué incluye cada plan.',
  cuenta: 'Tus datos de acceso, tu contraseña y cómo ves KAI.',
};

export default function Settings() {
  const navigate = useNavigate();
  const { activeBusiness } = useAuth();
  const [params, setParams] = useSearchParams();
  const raw = params.get('tab');
  const tab: TabKey = isTabKey(raw) ? raw : 'negocio';
  const canEdit = activeBusiness?.role === 'trainer';

  // Las pestañas se montan la primera vez que se visitan y después solo se ocultan: así no se pierden cambios sin guardar.
  const [visited, setVisited] = useState<Set<TabKey>>(() => new Set([tab]));
  if (!visited.has(tab)) setVisited(new Set(visited).add(tab));

  const [businessDirty, setBusinessDirty] = useState(false);
  const onBusinessDirty = useCallback((d: boolean) => setBusinessDirty(d), []);

  // Aviso del navegador si se intenta cerrar o recargar con cambios sin guardar.
  useEffect(() => {
    if (!businessDirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [businessDirty]);

  const selectTab = (next: TabKey) => {
    if (next === tab) return;
    setParams(
      (prev) => {
        const p = new URLSearchParams(prev);
        p.set('tab', next);
        return p;
      },
      { replace: true },
    );
  };

  const onTabKeyDown = (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let target: number | null = null;
    if (e.key === 'ArrowRight') target = (index + 1) % TABS.length;
    else if (e.key === 'ArrowLeft') target = (index - 1 + TABS.length) % TABS.length;
    else if (e.key === 'Home') target = 0;
    else if (e.key === 'End') target = TABS.length - 1;
    if (target === null) return;
    e.preventDefault();
    selectTab(TABS[target].value);
    document.getElementById(`settings-tab-${TABS[target].value}`)?.focus();
  };

  return (
    <div className="page">
      <PageHeader
        title="Ajustes"
        description={DESCRIPTIONS[tab]}
        actions={
          <Button icon={SlidersHorizontal} onClick={() => navigate('/app/setter')}>
            Configurar el setter
          </Button>
        }
      />

      {!canEdit && tab === 'negocio' && (
        <div style={{ marginBottom: 16 }}>
          <Callout tone="info" icon={Lock}>
            Puedes consultar estos datos, pero solo las personas con rol Entrenador pueden cambiarlos.
          </Callout>
        </div>
      )}

      <div className="tabs" role="tablist" aria-label="Secciones de ajustes">
        {TABS.map((t, i) => {
          const selected = t.value === tab;
          const dirty = t.value === 'negocio' && businessDirty;
          return (
            <button
              key={t.value}
              id={`settings-tab-${t.value}`}
              role="tab"
              type="button"
              aria-selected={selected}
              aria-controls={`settings-panel-${t.value}`}
              tabIndex={selected ? 0 : -1}
              onClick={() => selectTab(t.value)}
              onKeyDown={(e) => onTabKeyDown(e, i)}
            >
              {t.label}
              {dirty && (
                <>
                  <span className="settings-dot settings-tab-dot" aria-hidden title="Cambios sin guardar" />
                  <span className="sr-only"> (cambios sin guardar)</span>
                </>
              )}
            </button>
          );
        })}
      </div>

      {businessDirty && tab !== 'negocio' && (
        <p className="small settings-pending" role="status">
          <span className="settings-dot" aria-hidden />
          Tienes cambios sin guardar en «Negocio». Se conservan mientras no salgas de esta página.
        </p>
      )}

      {TABS.map((t) => (
        <div key={t.value} id={`settings-panel-${t.value}`} role="tabpanel" aria-labelledby={`settings-tab-${t.value}`} hidden={t.value !== tab} className="settings-panel">
          {visited.has(t.value) &&
            (t.value === 'negocio' ? (
              <BusinessTab canEdit={canEdit} onDirtyChange={onBusinessDirty} />
            ) : t.value === 'equipo' ? (
              <TeamTab canEdit={canEdit} />
            ) : t.value === 'plan' ? (
              <PlanTab />
            ) : (
              <AccountTab />
            ))}
        </div>
      ))}
    </div>
  );
}
