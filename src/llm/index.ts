import type { LLMProvider } from '../types.ts';
import { AnthropicProvider } from './anthropic.ts';
import { OpenAICompatProvider, type OpenAICompatOptions } from './openai.ts';
import { MockLLM } from './mock.ts';

export type ProviderKind = 'anthropic' | 'openai' | 'local' | 'mock';

/** 前端 / CLI / worker 传入的 LLM 连接参数（全部可选，缺省走环境变量与 flavor 默认值） */
export interface LLMConfig extends OpenAICompatOptions {}

export function createProvider(kind: string = process.env.LLM_PROVIDER ?? 'mock', cfg: LLMConfig = {}): LLMProvider {
  switch (kind) {
    case 'anthropic': return new AnthropicProvider(cfg.model);
    case 'openai': return new OpenAICompatProvider({ ...cfg, flavor: cfg.flavor ?? 'openai' });
    // 本地模型：Ollama / vLLM / 其他 OpenAI 兼容服务，走同一个 Provider，只是 flavor 与默认地址不同
    case 'local': return new OpenAICompatProvider({ ...cfg, flavor: cfg.flavor ?? (process.env.LLM_FLAVOR as LLMConfig['flavor']) ?? 'ollama' });
    case 'mock': return new MockLLM();
    default: throw new Error(`未知 LLM_PROVIDER: ${kind} (anthropic | openai | local | mock)`);
  }
}
