/* Pestaña «Escalado»: cuándo KAI deja de responder y te pasa la conversación. */
import { useId } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Angry, BellRing, Compass, Handshake, HeartPulse, LifeBuoy, MessageSquareText, ShieldCheck, UserRound, Wrench, type LucideIcon } from 'lucide-react';
import { HANDOFF_REASONS, type HandoffReason, type HandoffRules } from '@shared';
import { api, errorText } from '../../lib/api';
import { Callout, Card, Field, Switch, Textarea, useToast } from '../../components/ui';
import { CharCount, SaveBar, useDraft, useReportDirty, type TabProps } from './setter-shared';

type RuleKey = Exclude<keyof HandoffRules, 'handoffMessage'>;

const MAX_MESSAGE = 500;

const DEFAULT_RULES: HandoffRules = {
  angry: true,
  medical: true,
  humanRequest: true,
  complexNegotiation: true,
  outOfScope: true,
  technicalIssue: true,
  handoffMessage: '',
};

const RULES: { key: RuleKey; reason: HandoffReason; icon: LucideIcon; when: string; action: string; off: string }[] = [
  {
    key: 'humanRequest',
    reason: 'human_request',
    icon: UserRound,
    when: 'El lead pide hablar contigo o con una persona.',
    action: 'KAI le contesta que te pasa su mensaje y deja de responder en esa conversación.',
    off: 'KAI intentará seguir atendiéndole él mismo.',
  },
  {
    key: 'angry',
    reason: 'angry',
    icon: Angry,
    when: 'El lead se muestra molesto, ofendido o enfadado.',
    action: 'KAI deja de escribir de inmediato, sin enviar ningún mensaje más, y te avisa como urgente.',
    off: 'KAI intentará calmar la situación y seguir la conversación.',
  },
  {
    key: 'medical',
    reason: 'medical',
    icon: HeartPulse,
    when: 'El lead menciona una enfermedad, una lesión, medicación, un embarazo o un trastorno alimentario, o pide consejo médico.',
    action: 'KAI le recomienda revisarlo con un profesional sanitario, deja de responder y te avisa como urgente.',
    off: 'KAI le recomendará igualmente consultarlo con un profesional sanitario, pero seguirá la conversación.',
  },
  {
    key: 'complexNegotiation',
    reason: 'complex_negotiation',
    icon: Handshake,
    when: 'El lead pide descuentos o condiciones especiales, o intenta negociar el precio.',
    action: 'KAI no negocia: le dice que prefiere que lo veáis directamente y te pasa la conversación.',
    off: 'KAI responderá solo con la información de tus servicios, sin ofrecer descuentos ni condiciones especiales.',
  },
  {
    key: 'outOfScope',
    reason: 'out_of_scope',
    icon: Compass,
    when: 'El lead escribe por temas ajenos a tu servicio: facturas, colaboraciones, ofertas de empleo…',
    action: 'KAI le dice que te pasa su mensaje para que le respondas tú directamente.',
    off: 'KAI intentará responder o reconducir la conversación por su cuenta.',
  },
  {
    key: 'technicalIssue',
    reason: 'technical_issue',
    icon: Wrench,
    when: 'El lead tiene un problema técnico, por ejemplo un enlace que no funciona.',
    action: 'KAI se disculpa, le dice que el equipo lo revisa y te pasa la conversación.',
    off: 'KAI intentará ayudarle él mismo con lo que sabe.',
  },
];

function toDraft(rules: HandoffRules | null | undefined): HandoffRules {
  const r = { ...DEFAULT_RULES, ...(rules ?? {}) };
  return {
    angry: Boolean(r.angry),
    medical: Boolean(r.medical),
    humanRequest: Boolean(r.humanRequest),
    complexNegotiation: Boolean(r.complexNegotiation),
    outOfScope: Boolean(r.outOfScope),
    technicalIssue: Boolean(r.technicalIssue),
    handoffMessage: r.handoffMessage ?? '',
  };
}

export default function HandoffTab({ settings, canEdit, onDirtyChange }: TabProps) {
  const qc = useQueryClient();
  const toast = useToast();
  const messageId = useId();
  const { draft, setDraft, dirty, reset, markSaved } = useDraft(toDraft(settings.aiSettings.handoffRules));
  useReportDirty(onDirtyChange, dirty);
  const trainer = settings.trainer.displayName?.trim() || 'el entrenador';
  const error = draft.handoffMessage.length > MAX_MESSAGE ? `El mensaje puede tener como máximo ${MAX_MESSAGE} caracteres.` : null;
  const activeCount = RULES.filter((r) => draft[r.key]).length;

  const save = useMutation({
    mutationFn: async () => {
      const handoffRules: HandoffRules = { ...draft, handoffMessage: draft.handoffMessage.trim() };
      await api.put('/settings/ai', { handoffRules });
      return handoffRules;
    },
    onSuccess: (saved) => {
      markSaved(saved);
      toast('Reglas de escalado guardadas');
      void qc.invalidateQueries({ queryKey: ['settings'] });
    },
    onError: (e) => toast(errorText(e), 'error'),
  });

  return (
    <>
      <p className="setter-lead">
        «Escalar» significa que KAI te pasa la conversación. Cuando ocurre, KAI deja de responder a ese lead y te avisa (en la campana de Avisos) para que sigas tú desde la bandeja. Cuando lo consideres, puedes devolverle la conversación a KAI.
      </p>

      <Card title={`¿Cuándo te pasa KAI la conversación? (${activeCount} de ${RULES.length} activados)`} icon={LifeBuoy}>
        <div>
          {RULES.map((r) => {
            const Icon = r.icon;
            const on = draft[r.key];
            const label = HANDOFF_REASONS[r.reason];
            return (
              <div key={r.key} className="setter-toggle-row">
                <div className="row" style={{ alignItems: 'flex-start', gap: 12 }}>
                  <span className="setter-icon" aria-hidden>
                    <Icon />
                  </span>
                  <div>
                    <strong>{label}</strong>
                    <p className="muted small mt-4">{r.when}</p>
                    <p className="small mt-4">{on ? r.action : <span className="subtle">Desactivado: {r.off}</span>}</p>
                  </div>
                </div>
                <Switch checked={on} onChange={(v) => setDraft((d) => ({ ...d, [r.key]: v }))} label={<span className="sr-only">{`Escalar: ${label}`}</span>} />
              </div>
            );
          })}
        </div>
        {(!draft.medical || !draft.angry) && (
          <div className="mt-12">
            <Callout tone="warning">Te recomendamos mantener activados los casos de enfado y de salud: son conversaciones delicadas en las que conviene que intervenga una persona.</Callout>
          </div>
        )}
      </Card>

      <Card title="Mensaje al pasarte la conversación (opcional)" icon={MessageSquareText}>
        <Field
          label="¿Qué le dice KAI al lead antes de pasarte la conversación?"
          htmlFor={messageId}
          error={error}
          hint={`Si lo dejas vacío, KAI usa un mensaje breve adaptado a cada caso, por ejemplo: «¡Claro! Le paso tu mensaje a ${trainer} y te escribe directamente en cuanto pueda».`}
        >
          <Textarea
            id={messageId}
            rows={3}
            maxLength={MAX_MESSAGE}
            value={draft.handoffMessage}
            placeholder={`Ej.: Le paso tu mensaje a ${trainer} y te responde personalmente lo antes posible.`}
            onChange={(e) => setDraft((d) => ({ ...d, handoffMessage: e.target.value }))}
          />
          <CharCount value={draft.handoffMessage} max={MAX_MESSAGE} />
        </Field>
        <p className="subtle xs mt-8">Este mensaje no se envía cuando el lead está enfadado (KAI simplemente deja de escribir) ni en temas de salud (KAI envía la recomendación de consultar con un profesional sanitario).</p>
      </Card>

      <Card title="Siempre activo" icon={ShieldCheck}>
        <ul className="small" style={{ margin: 0, paddingLeft: 18, lineHeight: 1.7 }}>
          <li>Si KAI no consigue redactar una respuesta que supere su control de calidad, no envía nada y te pasa la conversación.</li>
          <li>Si un lead pide que no le escriban más, KAI se despide y no vuelve a escribirle.</li>
          <li>Si un lead pregunta si está hablando con un bot, KAI nunca lo niega.</li>
        </ul>
        <p className="subtle xs mt-12 row" style={{ gap: 6 }}>
          <BellRing size={13} aria-hidden /> Puedes tomar el control de cualquier conversación cuando quieras desde la bandeja, aunque no se cumpla ninguno de estos casos.
        </p>
      </Card>

      <SaveBar dirty={dirty} saving={save.isPending} canEdit={canEdit} error={error} onDiscard={reset} onSave={() => save.mutate()} saveLabel="Guardar escalado" />
    </>
  );
}
