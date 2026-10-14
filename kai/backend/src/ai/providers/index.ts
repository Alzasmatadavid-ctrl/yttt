import { env, resolveAiMode } from '../../config/env.js';
import { AnthropicProvider } from './anthropic.provider.js';
import type { LLMProvider } from './types.js';

let override: LLMProvider | null | undefined;
let cached: LLMProvider | null | undefined;

/**
 * Devuelve el proveedor de IA configurado o `null` en modo simulación
 * (sin API key: KAI funciona con un motor de reglas para poder probar todo el sistema).
 */
export function getLLMProvider(): LLMProvider | null {
  if (override !== undefined) return override;
  if (cached !== undefined) return cached;
  cached = resolveAiMode() === 'anthropic' && env.ANTHROPIC_API_KEY ? new AnthropicProvider(env.ANTHROPIC_API_KEY) : null;
  return cached;
}

/** Para tests o para inyectar otro proveedor (OpenAI, local…) sin tocar el resto del código. */
export function setLLMProvider(provider: LLMProvider | null | undefined) {
  override = provider;
}

export function aiModeInfo() {
  const p = getLLMProvider();
  return p ? { mode: 'llm' as const, ...p.describe() } : { mode: 'simulated' as const, provider: 'Simulación (motor de reglas)', mainModel: '-', fastModel: '-' };
}
