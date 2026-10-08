import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parse, uuidParam } from '../../lib/http.js';
import { requireTenant } from '../../auth/guards.js';
import { askCopilot, copilotHistory } from './copilot.service.js';
import { cancelPendingAction, confirmPendingAction, listPendingActions } from './copilot-actions.js';

export async function copilotRoutes(app: FastifyInstance) {
  app.post('/copilot/ask', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request) => {
    const ctx = await requireTenant(request, 'copilot:use');
    const body = parse(
      z.object({
        question: z.string().trim().min(1, 'Escribe una pregunta').max(2000),
        // Lead o conversación abiertos detrás del panel («este lead»). Es solo una ayuda: un identificador mal
        // formado se ignora, y askCopilot comprueba que pertenece al negocio activo.
        context: z
          .object({ leadId: z.string().uuid().optional().catch(undefined), conversationId: z.string().uuid().optional().catch(undefined) })
          .optional()
          .catch(undefined),
      }),
      request.body,
    );
    return askCopilot(ctx, body.question, request.authUser?.name ?? 'el entrenador', body.context);
  });

  app.get('/copilot/history', async (request) => {
    const ctx = await requireTenant(request, 'copilot:use');
    return { messages: await copilotHistory(ctx) };
  });

  app.get('/copilot/actions', async (request) => {
    const ctx = await requireTenant(request, 'copilot:use');
    return { actions: await listPendingActions(ctx) };
  });

  app.post('/copilot/actions/:id/confirm', async (request) => {
    const ctx = await requireTenant(request, 'copilot:use');
    const { id } = parse(uuidParam, request.params);
    return confirmPendingAction(ctx, id);
  });

  app.post('/copilot/actions/:id/cancel', async (request) => {
    const ctx = await requireTenant(request, 'copilot:use');
    const { id } = parse(uuidParam, request.params);
    return cancelPendingAction(ctx, id);
  });
}
