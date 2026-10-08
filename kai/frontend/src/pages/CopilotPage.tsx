import { Sparkles } from 'lucide-react';
import { Card, PageHeader } from '../components/ui';
import CopilotPanel from '../components/CopilotPanel';

export default function CopilotPage() {
  return (
    <div className="page" style={{ maxWidth: 980 }}>
      <PageHeader title="KAI Copilot" description="Tu asistente para gestionar leads, agenda y configuración. Las acciones sensibles siempre requieren tu confirmación." />
      <Card flush title={undefined} icon={Sparkles}>
        <div style={{ height: 'calc(100vh - 220px)', minHeight: 460 }}>
          <CopilotPanel />
        </div>
      </Card>
    </div>
  );
}
