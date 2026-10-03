/* Página «Setter IA»: configuración de cómo conversa KAI, organizada en pestañas sincronizadas con ?tab=. */
import { useEffect, useMemo, useState, type ComponentType, type KeyboardEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { CircleAlert, FlaskConical, Lock, RefreshCw } from 'lucide-react';
import { api, errorText } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { Button, Callout, ConfirmDialog, EmptyState, PageHeader, PageLoading } from '../../components/ui';
import type { SettingsResponse } from '../../lib/types';
import type { TabProps } from './setter-shared';
import PersonalityTab from './PersonalityTab';
import QualificationTab from './QualificationTab';
import ScoringTab from './ScoringTab';
import ServicesTab from './ServicesTab';
import ObjectionsTab from './ObjectionsTab';
import FollowUpsTab from './FollowUpsTab';
import HandoffTab from './HandoffTab';
import CallTab from './CallTab';
import '../../styles/setter.css';

const TABS = [
  { value: 'personalidad', label: 'Personalidad', component: PersonalityTab },
  { value: 'cualificacion', label: 'Cualificación', component: QualificationTab },
  { value: 'puntuacion', label: 'Puntuación', component: ScoringTab },
  { value: 'servicio', label: 'Servicio y precio', component: ServicesTab },
  { value: 'objeciones', label: 'Objeciones', component: ObjectionsTab },
  { value: 'seguimientos', label: 'Seguimientos', component: FollowUpsTab },
  { value: 'escalado', label: 'Escalado', component: HandoffTab },
  { value: 'llamada', label: 'Llamada', component: CallTab },
] as const satisfies readonly { value: string; label: string; component: ComponentType<TabProps> }[];

type TabKey = (typeof TABS)[number]['value'];
const TAB_KEYS = TABS.map((t) => t.value) as TabKey[];
const isTabKey = (v: string | null): v is TabKey => v !== null && (TAB_KEYS as string[]).includes(v);
const NO_CHANGES = Object.fromEntries(TAB_KEYS.map((k) => [k, false])) as Record<TabKey, boolean>;

export default function SetterSettings() {
  const navigate = useNavigate();
  const { activeBusiness } = useAuth();
  const [params, setParams] = useSearchParams();
  const raw = params.get('tab');
  const tab: TabKey = isTabKey(raw) ? raw : 'personalidad';
  const [visited, setVisited] = useState<Set<TabKey>>(() => new Set([tab]));
  const [dirty, setDirty] = useState<Record<TabKey, boolean>>(NO_CHANGES);

  // Las pestañas se montan la primera vez que se visitan y después solo se ocultan: así no se pierden cambios sin guardar al cambiar de pestaña.
  if (!visited.has(tab)) setVisited(new Set(visited).add(tab));

  const settings = useQuery({ queryKey: ['settings'], queryFn: () => api.get<SettingsResponse>('/settings') });
  const canEdit = activeBusiness?.role === 'trainer';

  /** Un callback estable por pestaña para que cada una informe de sus cambios pendientes. */
  const dirtyHandlers = useMemo(
    () => Object.fromEntries(TAB_KEYS.map((k) => [k, (d: boolean) => setDirty((m) => (m[k] === d ? m : { ...m, [k]: d }))])) as Record<TabKey, (d: boolean) => void>,
    [],
  );
  const pendingTabs = TABS.filter((t) => dirty[t.value]);

  // Aviso del navegador si se intenta cerrar o recargar con cambios sin guardar.
  const anyDirty = pendingTabs.length > 0;
  useEffect(() => {
    if (!anyDirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [anyDirty]);

  // Aviso propio al ir a otra pantalla de la aplicación (menú lateral, enlaces…) con cambios sin guardar.
  const [leaveTo, setLeaveTo] = useState<string | null>(null);
  useEffect(() => {
    if (!anyDirty) return;
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const link = e.target instanceof Element ? e.target.closest<HTMLAnchorElement>('a[href]') : null;
      if (!link || (link.target && link.target !== '_self') || link.hasAttribute('download')) return;
      const url = new URL(link.href, window.location.href);
      if (url.origin !== window.location.origin || url.pathname === window.location.pathname) return;
      e.preventDefault();
      e.stopPropagation();
      setLeaveTo(url.pathname + url.search + url.hash);
    };
    document.addEventListener('click', onClick, true);
    return () => document.removeEventListener('click', onClick, true);
  }, [anyDirty]);
  const goTo = (path: string) => (anyDirty ? setLeaveTo(path) : navigate(path));

  // En pantallas estrechas, la pestaña activa siempre queda a la vista dentro de la barra de pestañas.
  useEffect(() => {
    document.getElementById(`setter-tab-${tab}`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [tab, settings.isSuccess]);

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
    document.getElementById(`setter-tab-${TABS[target].value}`)?.focus();
  };

  const header = (
    <PageHeader
      title="Setter IA"
      description="Configura cómo conversa KAI con tus leads: cómo se presenta, qué averigua, cómo puntúa, qué ofrece y cuándo te pasa la conversación. Los cambios se aplican a los mensajes nuevos."
      actions={
        <Button icon={FlaskConical} onClick={() => goTo('/app/simulador')}>
          Probar en el simulador
        </Button>
      }
    />
  );

  if (settings.isPending) return <PageLoading />;
  if (settings.isError || !settings.data) {
    return (
      <div className="page">
        {header}
        <div className="card">
          <EmptyState
            icon={CircleAlert}
            title="No hemos podido cargar la configuración"
            description={errorText(settings.error)}
            action={
              <Button icon={RefreshCw} loading={settings.isFetching} onClick={() => void settings.refetch()}>
                Reintentar
              </Button>
            }
          />
        </div>
      </div>
    );
  }

  const data = settings.data;

  return (
    <div className="page">
      {header}

      {!canEdit && (
        <div style={{ marginBottom: 16 }}>
          <Callout tone="info" icon={Lock}>
            Puedes consultar toda la configuración, pero solo la persona titular del negocio (rol Entrenador) puede cambiarla.
          </Callout>
        </div>
      )}

      <div className="tabs" role="tablist" aria-label="Secciones de la configuración del setter">
        {TABS.map((t, i) => {
          const selected = t.value === tab;
          return (
            <button
              key={t.value}
              id={`setter-tab-${t.value}`}
              role="tab"
              type="button"
              aria-selected={selected}
              aria-controls={`setter-panel-${t.value}`}
              tabIndex={selected ? 0 : -1}
              onClick={() => selectTab(t.value)}
              onKeyDown={(e) => onTabKeyDown(e, i)}
            >
              {t.label}
              {dirty[t.value] && (
                <>
                  <span className="setter-dot setter-tab-dot" aria-hidden title="Cambios sin guardar" />
                  <span className="sr-only"> (cambios sin guardar)</span>
                </>
              )}
            </button>
          );
        })}
      </div>

      {pendingTabs.some((t) => t.value !== tab) && (
        <p className="small setter-pending" role="status">
          <span className="setter-dot" aria-hidden />
          Tienes cambios sin guardar en: {pendingTabs.map((t) => `«${t.label}»`).join(', ')}. Se conservan mientras no salgas de esta página.
        </p>
      )}

      {TABS.map((t) => {
        const Component = t.component as ComponentType<TabProps>;
        return (
          <div key={t.value} id={`setter-panel-${t.value}`} role="tabpanel" aria-labelledby={`setter-tab-${t.value}`} hidden={t.value !== tab} className="setter-panel">
            {visited.has(t.value) && <Component settings={data} canEdit={canEdit} onDirtyChange={dirtyHandlers[t.value]} />}
          </div>
        );
      })}

      <ConfirmDialog
        open={leaveTo !== null}
        title="¿Salir sin guardar?"
        message={
          <>
            Tienes cambios sin guardar en {pendingTabs.map((t) => `«${t.label}»`).join(', ')}. Si sales ahora, se perderán. Para conservarlos, quédate y pulsa Guardar en cada sección.
          </>
        }
        confirmLabel="Salir sin guardar"
        danger
        onConfirm={() => {
          const target = leaveTo;
          setLeaveTo(null);
          if (target) navigate(target);
        }}
        onClose={() => setLeaveTo(null)}
      />
    </div>
  );
}
