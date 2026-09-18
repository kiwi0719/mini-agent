import type { LLMProvider } from '../types.ts';
import { AnthropicProvider, type AnthropicOptions } from './anthropic.ts';
import { OpenAICompatProvider, type OpenAICompatOptions } from './openai.ts';
import { MockLLM } from './mock.ts';

export type ProviderKind = 'anthropic' | 'openai' | 'local' | 'mock';

/** 前端 / CLI / worker 传入的 LLM 连接参数（全部可选，缺省走环境变量与 flavor / preset 默认值） */
export interface LLMConfig extends OpenAICompatOptions {
  /** anthropic 专用：端点预设（anthropic | kimi | glm | deepseek | minimax | custom）与只认 Bearer 的网关 token */
  preset?: AnthropicOptions['preset'];
  authToken?: string;
  maxTokens?: number;
}

export function createProvider(kind: string = process.env.LLM_PROVIDER ?? 'mock', cfg: LLMConfig = {}): LLMProvider {
  switch (kind) {
    // Anthropic 格式：官方 / 网关中转 / 各厂商 Anthropic 兼容端点，同一 Provider，靠 preset + baseUrl 区分
    case 'anthropic': return new AnthropicProvider({ preset: cfg.preset, baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, authToken: cfg.authToken, model: cfg.model, stream: cfg.stream, maxTokens: cfg.maxTokens });
    case 'openai': return new OpenAICompatProvider({ ...cfg, flavor: cfg.flavor ?? 'openai' });
    // 本地模型：Ollama / vLLM / 其他 OpenAI 兼容服务，走同一个 Provider，只是 flavor 与默认地址不同
    case 'local': return new OpenAICompatProvider({ ...cfg, flavor: cfg.flavor ?? (process.env.LLM_FLAVOR as LLMConfig['flavor']) ?? 'ollama' });
    case 'mock': return new MockLLM();
    default: throw new Error(`未知 LLM_PROVIDER: ${kind} (anthropic | openai | local | mock)`);
  }
}
