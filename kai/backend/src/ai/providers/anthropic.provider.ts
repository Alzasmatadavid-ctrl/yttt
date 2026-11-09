/**
 * Adaptador de Claude (Anthropic) mediante el SDK oficial `@anthropic-ai/sdk`.
 * - Modelo principal (conversación, copilot): AI_MODEL_MAIN (por defecto claude-opus-5-5).
 * - Modelo rápido (extracción estructurada, control de calidad): AI_MODEL_FAST (por defecto claude-haiku-4-5).
 * - Prompt caching de la parte estable del prompt.
 * - Fallback de servidor ante rechazos (`fallbacks: "default"`) en los modelos que lo admiten.
 */
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import type { z } from 'zod';
import { env } from '../../config/env.js';
import type { ChatMessage, ChatRequest, ChatResponse, LLMProvider, StructuredRequest, SystemPart, TextBlock, ToolCallBlock } from './types.js';

type BetaMessageParam = Anthropic.Beta.Messages.BetaMessageParam;
type BetaContentBlockParam = Anthropic.Beta.Messages.BetaContentBlockParam;

const FALLBACK_MODELS = /^claude-(opus-5-5|opus-5|sonnet-5-5|fable-5-1|fable-5)$/;
const NO_EFFORT_MODELS = /haiku|sonnet-4-5|claude-3/;

export class AnthropicProvider implements LLMProvider {
  id = 'anthropic';
  private client: Anthropic;

  constructor(apiKey: string, private readonly models = { main: env.AI_MODEL_MAIN, fast: env.AI_MODEL_FAST }) {
    this.client = new Anthropic({ apiKey, maxRetries: 2, timeout: 90_000 });
  }

  describe() {
    return { provider: 'Anthropic (Claude)', mainModel: this.models.main, fastModel: this.models.fast };
  }

  private system(parts: SystemPart[]) {
    return parts
      .filter((p) => p.text.trim())
      .map((p) => ({ type: 'text' as const, text: p.text, ...(p.cache ? { cache_control: { type: 'ephemeral' as const } } : {}) }));
  }

  private messages(msgs: ChatMessage[]): BetaMessageParam[] {
    return msgs.map((m) => {
      if (m.role === 'assistant' && m.providerRaw) return { role: 'assistant', content: m.providerRaw as BetaContentBlockParam[] };
      if (typeof m.content === 'string') return { role: m.role, content: m.content };
      const content: BetaContentBlockParam[] = m.content.map((b) => {
        if (b.type === 'text') return { type: 'text', text: b.text };
        if (b.type === 'tool_call') return { type: 'tool_use', id: b.id, name: b.name, input: b.input };
        return { type: 'tool_result', tool_use_id: b.toolCallId, content: b.content, is_error: b.isError ?? false };
      });
      return { role: m.role, content };
    });
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const model = this.models[req.tier];
    const useFallbacks = env.AI_SERVER_FALLBACKS && FALLBACK_MODELS.test(model);
    const response = await this.client.beta.messages.create({
      model,
      max_tokens: req.maxTokens ?? 2048,
      system: this.system(req.system),
      messages: this.messages(req.messages),
      cache_control: { type: 'ephemeral' },
      ...(req.tools?.length
        ? {
            tools: req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema as Anthropic.Beta.Messages.BetaTool.InputSchema, strict: true })),
            tool_choice: { type: 'auto' as const },
          }
        : {}),
      ...(req.effort && !NO_EFFORT_MODELS.test(model) ? { output_config: { effort: req.effort } } : {}),
      ...(useFallbacks ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
    });

    const blocks: (TextBlock | ToolCallBlock)[] = [];
    for (const b of response.content) {
      if (b.type === 'text') blocks.push({ type: 'text', text: b.text });
      else if (b.type === 'tool_use') blocks.push({ type: 'tool_call', id: b.id, name: b.name, input: (b.input ?? {}) as Record<string, unknown> });
    }
    const stop = response.stop_reason;
    return {
      blocks,
      stopReason: stop === 'end_turn' || stop === 'tool_use' || stop === 'max_tokens' || stop === 'refusal' ? stop : 'other',
      raw: response.content,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
      },
      model: response.model,
    };
  }

  async structured<T extends z.ZodType>(req: StructuredRequest<T>): Promise<z.infer<T>> {
    const model = this.models[req.tier];
    const response = await this.client.messages.parse({
      model,
      max_tokens: req.maxTokens ?? 2048,
      system: this.system(req.system),
      messages: req.messages.map((m) => ({
        role: m.role,
        content: typeof m.content === 'string' ? m.content : m.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n'),
      })),
      output_config: { format: zodOutputFormat(req.schema) },
    });
    if (response.stop_reason === 'refusal') throw new Error('El modelo rechazó la solicitud.');
    if (response.parsed_output == null) throw new Error('La IA no devolvió datos estructurados válidos.');
    return response.parsed_output as z.infer<T>;
  }
}
