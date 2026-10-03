/**
 * Contrato neutral de proveedor de IA.
 * El resto de KAI (setter, copilot, análisis) solo conoce esta interfaz, de modo que cambiar
 * de proveedor o de modelo no obliga a reconstruir la aplicación: basta con otro adaptador.
 */
import type { z } from 'zod';

export type ModelTier = 'main' | 'fast';

export interface TextBlock {
  type: 'text';
  text: string;
}
export interface ToolCallBlock {
  type: 'tool_call';
  id: string;
  name: string;
  input: Record<string, unknown>;
}
export interface ToolResultBlock {
  type: 'tool_result';
  toolCallId: string;
  content: string;
  isError?: boolean;
}
export type ChatBlock = TextBlock | ToolCallBlock | ToolResultBlock;

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string | ChatBlock[];
  /** Contenido original del proveedor (p. ej. bloques de razonamiento) para reenviarlo sin cambios. */
  providerRaw?: unknown;
}

export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema del input. */
  inputSchema: Record<string, unknown>;
}

export interface SystemPart {
  text: string;
  /** Marcar la parte estable del prompt para cachearla (más rápido y barato). */
  cache?: boolean;
}

export interface ChatRequest {
  tier: ModelTier;
  system: SystemPart[];
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  maxTokens?: number;
  effort?: 'low' | 'medium' | 'high';
}

export interface ChatUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
}

export interface ChatResponse {
  blocks: (TextBlock | ToolCallBlock)[];
  stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'refusal' | 'other';
  raw: unknown;
  usage: ChatUsage;
  model: string;
}

export interface StructuredRequest<T extends z.ZodType> {
  tier: ModelTier;
  system: SystemPart[];
  messages: ChatMessage[];
  schema: T;
  maxTokens?: number;
}

export interface LLMProvider {
  id: string;
  describe(): { provider: string; mainModel: string; fastModel: string };
  chat(req: ChatRequest): Promise<ChatResponse>;
  structured<T extends z.ZodType>(req: StructuredRequest<T>): Promise<z.infer<T>>;
}

export const textOf = (blocks: ChatBlock[]) =>
  blocks
    .filter((b): b is TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
