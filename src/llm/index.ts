import type { LLMProvider } from '../types.ts';
import { AnthropicProvider } from './anthropic.ts';
import { OpenAICompatProvider } from './openai.ts';
import { MockLLM } from './mock.ts';

export function createProvider(kind = process.env.LLM_PROVIDER ?? 'mock'): LLMProvider {
  switch (kind) {
    case 'anthropic': return new AnthropicProvider();
    case 'openai': return new OpenAICompatProvider();
    case 'mock': return new MockLLM();
    default: throw new Error(`未知 LLM_PROVIDER: ${kind} (anthropic | openai | mock)`);
  }
}
