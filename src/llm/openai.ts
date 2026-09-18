import type { LLMProvider, LLMResponse, Message, ToolSchema } from '../types.ts';

/**
 * OpenAI 兼容的 /v1/chat/completions（DeepSeek、Qwen、Ollama、vLLM 等）。用 fetch 直接调用，
 * 带指数退避重试。
 */
export class OpenAICompatProvider implements LLMProvider {
  readonly name: string;
  private baseUrl: string;
  private apiKey: string;
  private model: string;

  constructor(opts: { baseUrl?: string; apiKey?: string; model?: string } = {}) {
    this.baseUrl = (opts.baseUrl ?? process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1').replace(/\/$/, '');
    this.apiKey = opts.apiKey ?? process.env.OPENAI_API_KEY ?? '';
    this.model = opts.model ?? process.env.OPENAI_MODEL ?? 'gpt-4o-mini';
    this.name = `openai-compat:${this.model}`;
  }

  async chat(system: string, messages: Message[], tools: ToolSchema[], onDelta?: (t: string) => void): Promise<LLMResponse> {
    const body = {
      model: this.model,
      messages: [{ role: 'system', content: system }, ...toOpenAI(messages)],
      tools: tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } })),
      tool_choice: 'auto',
      stream: true,
      stream_options: { include_usage: true },
    };
    const res = await this.post('/chat/completions', body);

    // 解析 SSE：拼接文字增量与 tool_calls 参数片段
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
        const cur = calls.get(tc.index) ?? { id: '', name: '', args: '' };
        if (tc.id) cur.id = tc.id;
        if (tc.function?.name) cur.name = tc.function.name;
        if (tc.function?.arguments) cur.args += tc.function.arguments;
        calls.set(tc.index, cur);
      }
    }
    const toolCalls = [...calls.values()].map((c) => {
      let input: unknown = c.args;
      try { input = JSON.parse(c.args || '{}'); } catch { /* 保留字符串，registry 会报错给模型 */ }
      return { id: c.id || `call_${Math.random().toString(36).slice(2)}`, name: c.name, input };
    });
    return { text, toolCalls, stopReason: finish, usage };
  }

  private async post(path: string, body: unknown, attempt = 0): Promise<Response> {
    const res = await fetch(this.baseUrl + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    }).catch((e) => { throw new Error(`LLM 网络错误: ${e.message}`); });
    if (res.ok) return res;
    const text = await res.text();
    if ((res.status === 429 || res.status >= 500) && attempt < 3) {
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
      return this.post(path, body, attempt + 1);
    }
    throw new Error(`LLM API ${res.status}: ${text.slice(0, 300)}`);
  }
}

function toOpenAI(messages: Message[]): any[] {
  const out: any[] = [];
  for (const m of messages) {
    if (m.role === 'user') out.push({ role: 'user', content: m.content });
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
