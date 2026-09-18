import type { LLMProvider, LLMResponse, Message, ToolSchema } from '../types.ts';

/**
 * OpenAI 兼容的 /v1/chat/completions。一套代码覆盖三种“口味”(flavor)：
 *  - openai : OpenAI / DeepSeek / Qwen 等云端兼容接口（默认流式）
 *  - vllm   : vLLM OpenAI server（默认流式；需服务端 --enable-auto-tool-choice --tool-call-parser <parser>）
 *  - ollama : Ollama 的 /v1 兼容层（默认非流式；不发 tool_choice / stream_options / parallel_tool_calls，Ollama 文档列为不支持）
 * 差异全部收敛在 buildRequestBody() 里，便于用 scripts/check-request-schema.ts 做离线校验。
 */
export type Flavor = 'openai' | 'vllm' | 'ollama';

export interface OpenAICompatOptions {
  flavor?: Flavor;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  /** 是否流式；不传则按 flavor 默认（ollama=false，其余 true） */
  stream?: boolean;
}

export const FLAVOR_DEFAULTS: Record<Flavor, { baseUrl: string; model: string; stream: boolean; apiKey: string }> = {
  openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', stream: true, apiKey: '' },
  vllm: { baseUrl: 'http://localhost:8000/v1', model: '', stream: true, apiKey: '' },
  // Ollama 要求客户端带一个 key 但会忽略其值
  ollama: { baseUrl: 'http://localhost:11434/v1', model: 'qwen2.5:7b', stream: false, apiKey: 'ollama' },
};

export class OpenAICompatProvider implements LLMProvider {
  readonly name: string;
  readonly flavor: Flavor;
  private baseUrl: string;
  private apiKey: string;
  private model: string;
  private stream: boolean;

  constructor(opts: OpenAICompatOptions = {}) {
    this.flavor = opts.flavor ?? (process.env.LLM_FLAVOR as Flavor) ?? 'openai';
    const d = FLAVOR_DEFAULTS[this.flavor];
    if (!d) throw new Error(`未知 flavor: ${this.flavor} (openai | vllm | ollama)`);
    this.baseUrl = (opts.baseUrl ?? process.env.OPENAI_BASE_URL ?? d.baseUrl).replace(/\/$/, '');
    this.apiKey = opts.apiKey ?? process.env.OPENAI_API_KEY ?? d.apiKey;
    this.model = opts.model ?? process.env.OPENAI_MODEL ?? d.model;
    this.stream = opts.stream ?? d.stream;
    if (!this.model) throw new Error(`${this.flavor} 需要指定 model（vLLM 以 --served-model-name 或权重路径为模型名）`);
    this.name = `${this.flavor}:${this.model}`;
  }

  /** 组装请求体。纯函数，供离线 schema 校验。 */
  buildRequestBody(system: string, messages: readonly Message[], tools: ToolSchema[]): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: [{ role: 'system', content: system }, ...toOpenAI(messages)],
      stream: this.stream,
    };
    if (tools.length) {
      body.tools = tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } }));
      // Ollama 不支持 tool_choice（发了可能被拒或被忽略），其余两种用 auto
      if (this.flavor !== 'ollama') body.tool_choice = 'auto';
    }
    // stream_options 是 OpenAI/vLLM 的扩展字段，Ollama 未列入支持列表，不发
    if (this.stream && this.flavor !== 'ollama') body.stream_options = { include_usage: true };
    return body;
  }

  async chat(system: string, messages: readonly Message[], tools: ToolSchema[], onDelta?: (t: string) => void, signal?: AbortSignal): Promise<LLMResponse> {
    const body = this.buildRequestBody(system, messages, tools);
    const res = await this.post('/chat/completions', body, 0, signal);
    return this.stream ? this.parseStream(res, onDelta) : this.parseJson(await res.json(), onDelta);
  }

  /** 非流式：直接解析 choices[0].message */
  private parseJson(json: any, onDelta?: (t: string) => void): LLMResponse {
    const msg = json.choices?.[0]?.message ?? {};
    const text: string = msg.content ?? '';
    if (text && onDelta) onDelta(text);
    const toolCalls = (msg.tool_calls ?? []).map((tc: any, i: number) => ({
      id: tc.id || `call_${i}_${Math.random().toString(36).slice(2, 8)}`,
      name: tc.function?.name,
      input: parseArgs(tc.function?.arguments),
    }));
    return {
      text,
      toolCalls,
      stopReason: json.choices?.[0]?.finish_reason,
      usage: { inputTokens: json.usage?.prompt_tokens ?? 0, outputTokens: json.usage?.completion_tokens ?? 0 },
    };
  }

  /** 流式：拼接文字增量与 tool_calls 参数片段 */
  private async parseStream(res: Response, onDelta?: (t: string) => void): Promise<LLMResponse> {
    let text = '';
    let finish: string | undefined;
    let usage = { inputTokens: 0, outputTokens: 0 };
    const calls = new Map<number, { id: string; name: string; args: string }>();
    for await (const data of sseLines(res)) {
      if (data === '[DONE]') break;
      let json: any;
      try { json = JSON.parse(data); } catch { continue; }
      if (json.usage) usage = { inputTokens: json.usage.prompt_tokens ?? 0, outputTokens: json.usage.completion_tokens ?? 0 };
      const choice = json.choices?.[0];
      if (!choice) continue;
      if (choice.finish_reason) finish = choice.finish_reason;
      const d = choice.delta ?? {};
      if (d.content) { text += d.content; onDelta?.(d.content); }
      for (const tc of d.tool_calls ?? []) {
        const idx = tc.index ?? 0;
        const cur = calls.get(idx) ?? { id: '', name: '', args: '' };
        if (tc.id) cur.id = tc.id;
        if (tc.function?.name) cur.name = tc.function.name;
        if (tc.function?.arguments) cur.args += tc.function.arguments;
        calls.set(idx, cur);
      }
    }
    const toolCalls = [...calls.values()].map((c, i) => ({ id: c.id || `call_${i}_${Math.random().toString(36).slice(2, 8)}`, name: c.name, input: parseArgs(c.args) }));
    return { text, toolCalls, stopReason: finish, usage };
  }

  private async post(path: string, body: unknown, attempt = 0, signal?: AbortSignal): Promise<Response> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
    const res = await fetch(this.baseUrl + path, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(300_000)]) : AbortSignal.timeout(300_000), // 本地模型可能很慢
    }).catch((e) => { throw new Error(`LLM 网络错误 (${this.baseUrl}): ${e.message}`); });
    if (res.ok) return res;
    const text = await res.text();
    if ((res.status === 429 || res.status >= 500) && attempt < 3) {
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
      return this.post(path, body, attempt + 1, signal);
    }
    throw new Error(`LLM API ${res.status}: ${text.slice(0, 300)}`);
  }
}

/** 参数可能是 JSON 字符串（OpenAI/vLLM/Ollama-v1）或已解析的对象（个别实现）；解析失败保留原文让 registry 报错给模型 */
function parseArgs(a: unknown): unknown {
  if (a == null || a === '') return {};
  if (typeof a !== 'string') return a;
  try { return JSON.parse(a); } catch { return a; }
}

export function toOpenAI(messages: readonly Message[]): any[] {
  const out: any[] = [];
  for (const m of messages) {
    if (m.role === 'user') out.push({ role: 'user', content: m.content });
    else if (m.role === 'system') out.push({ role: 'system', content: m.content }); // 原生支持对话中 system
    else if (m.role === 'assistant') {
      out.push({
        role: 'assistant',
        content: m.content || null,
        tool_calls: m.toolCalls.length
          ? m.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.input ?? {}) } }))
          : undefined,
      });
    } else {
      for (const r of m.results) {
        out.push({ role: 'tool', tool_call_id: r.callId, content: r.result.ok ? r.result.output : `ERROR: ${r.result.error}` });
      }
    }
  }
  return out;
}

async function* sseLines(res: Response): AsyncGenerator<string> {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (line.startsWith('data:')) yield line.slice(5).trim();
    }
  }
}
