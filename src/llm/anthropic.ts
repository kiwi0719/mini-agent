import type { LLMProvider, LLMResponse, Message, ToolSchema, ToolCall } from '../types.ts';

/**
 * Anthropic Messages API 兼容 Provider —— 不依赖官方 SDK，直接 fetch，因此可以指向任何实现了
 * `POST {base}/v1/messages` 的服务：官方、企业网关 / 中转、以及各厂商提供的 Anthropic 兼容端点
 * （Kimi / 智谱 GLM / DeepSeek / MiniMax …，它们的模型名与 max_tokens 上限各不相同）。
 *
 * 兼容性处理集中在这里：
 *  - 鉴权：官方用 x-api-key，部分网关只认 Authorization: Bearer。两者都发（值相同或分别来自 ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN）。
 *  - 路径：baseUrl 可写到域名、写到 /anthropic、或写到 /v1，统一归一化为 …/v1/messages。
 *  - 流式：解析 message_start / content_block_start / content_block_delta(text_delta|input_json_delta) / message_delta / message_stop；
 *    第三方实现常见的偏差（tool_use.input 在 start 里已给全、partial_json 为空、缺 usage、多出 thinking 块、事件名缺失只有 data）都能容忍。
 *  - 非流式：有的中转对 SSE 处理不好，`stream:false` 直接解析 JSON。
 *  - 参数：max_tokens 可配（厂商上限不同）；不发 Anthropic 专有 beta 头。
 */
export type AnthropicPreset = 'anthropic' | 'kimi' | 'glm' | 'deepseek' | 'minimax' | 'custom';

export interface AnthropicOptions {
  /** 预设端点（决定默认 baseUrl / model / maxTokens）；custom 时必须给 baseUrl */
  preset?: AnthropicPreset;
  baseUrl?: string;
  apiKey?: string;
  /** 只认 Bearer 的网关用这个；不传则用 apiKey 同时填两种头 */
  authToken?: string;
  model?: string;
  stream?: boolean;
  maxTokens?: number;
  /** anthropic-version 头，默认 2023-06-01 */
  version?: string;
}

/** 各端点默认值（按厂商公开文档；可被参数 / 环境变量覆盖） */
export const ANTHROPIC_PRESETS: Record<AnthropicPreset, { baseUrl: string; model: string; maxTokens: number; label: string }> = {
  anthropic: { baseUrl: 'https://api.anthropic.com', model: 'claude-opus-5', maxTokens: 16000, label: 'Anthropic 官方 / 同格式网关' },
  kimi: { baseUrl: 'https://api.moonshot.cn/anthropic', model: 'kimi-k2-0905-preview', maxTokens: 8192, label: 'Moonshot Kimi（Anthropic 兼容端点）' },
  glm: { baseUrl: 'https://open.bigmodel.cn/api/anthropic', model: 'glm-4.5', maxTokens: 8192, label: '智谱 GLM（Anthropic 兼容端点）' },
  deepseek: { baseUrl: 'https://api.deepseek.com/anthropic', model: 'deepseek-chat', maxTokens: 8192, label: 'DeepSeek（Anthropic 兼容端点）' },
  minimax: { baseUrl: 'https://api.minimax.io/anthropic', model: 'MiniMax-M2', maxTokens: 8192, label: 'MiniMax（Anthropic 兼容端点）' },
  custom: { baseUrl: '', model: '', maxTokens: 8192, label: '其他 Anthropic 兼容接口（自填地址）' },
};

export class AnthropicProvider implements LLMProvider {
  readonly name: string;
  readonly preset: AnthropicPreset;
  private baseUrl: string;
  private apiKey: string;
  private authToken: string;
  private model: string;
  private stream: boolean;
  private maxTokens: number;
  private version: string;

  constructor(opts: AnthropicOptions | string = {}) {
    if (typeof opts === 'string') opts = { model: opts };
    this.preset = opts.preset ?? (process.env.ANTHROPIC_PRESET as AnthropicPreset) ?? 'anthropic';
    const d = ANTHROPIC_PRESETS[this.preset];
    if (!d) throw new Error(`未知 Anthropic 预设: ${this.preset} (${Object.keys(ANTHROPIC_PRESETS).join(' | ')})`);
    this.baseUrl = normalizeBase(opts.baseUrl ?? process.env.ANTHROPIC_BASE_URL ?? d.baseUrl);
    if (!this.baseUrl) throw new Error('custom 预设需要指定 baseUrl（--base-url 或 ANTHROPIC_BASE_URL）');
    // 凭证：显式传入（CLI / Web 面板）时完全不碰环境变量。
    // 否则宿主机里残留的 ANTHROPIC_AUTH_TOKEN 会被填进 Authorization 头，
    // 而用户以为自己用的是刚传进来的 --api-key —— 对只认 Bearer 的网关就是一个很难查的 401。
    if (opts.apiKey !== undefined || opts.authToken !== undefined) {
      this.apiKey = opts.apiKey ?? '';
      this.authToken = opts.authToken ?? '';
    } else {
      this.apiKey = process.env.ANTHROPIC_API_KEY ?? '';
      this.authToken = process.env.ANTHROPIC_AUTH_TOKEN ?? '';
    }
    if (!this.apiKey && !this.authToken) throw new Error('需要 API key：--api-key / ANTHROPIC_API_KEY（或 ANTHROPIC_AUTH_TOKEN）');
    this.model = opts.model ?? process.env.ANTHROPIC_MODEL ?? d.model;
    if (!this.model) throw new Error('需要指定 model（--model 或 ANTHROPIC_MODEL）');
    this.stream = opts.stream ?? (process.env.ANTHROPIC_STREAM ? process.env.ANTHROPIC_STREAM !== 'false' : true);
    this.maxTokens = opts.maxTokens ?? Number(process.env.ANTHROPIC_MAX_TOKENS ?? d.maxTokens);
    this.version = opts.version ?? process.env.ANTHROPIC_VERSION ?? '2023-06-01';
    this.name = `${this.preset}:${this.model}`;
  }

  /** 组装请求体（纯函数，便于离线校验） */
  buildRequestBody(system: string, messages: readonly Message[], tools: ToolSchema[]): Record<string, unknown> {
    const body: Record<string, unknown> = { model: this.model, max_tokens: this.maxTokens, system, messages: toAnthropic(messages), stream: this.stream };
    if (tools.length) body.tools = tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema }));
    return body;
  }

  buildHeaders(): Record<string, string> {
    const h: Record<string, string> = { 'content-type': 'application/json', 'anthropic-version': this.version };
    // 两种鉴权头都带：官方只看 x-api-key，一些网关 / 厂商端点只看 Bearer；多带一个不会被拒
    const key = this.apiKey || this.authToken; const token = this.authToken || this.apiKey;
    h['x-api-key'] = key; h.authorization = `Bearer ${token}`;
    return h;
  }

  async chat(system: string, messages: readonly Message[], tools: ToolSchema[], onDelta?: (t: string) => void, signal?: AbortSignal): Promise<LLMResponse> {
    const res = await this.post(this.buildRequestBody(system, messages, tools), 0, signal);
    const ct = res.headers.get('content-type') ?? '';
    // 有的中转会无视 stream:true 直接返回 JSON；反之亦然，按实际 content-type 解析
    if (ct.includes('text/event-stream')) return parseStream(res, onDelta);
    return parseJson(await res.json(), onDelta);
  }

  private async post(body: unknown, attempt: number, signal?: AbortSignal): Promise<Response> {
    const url = this.baseUrl + '/messages';
    const res = await fetch(url, {
      method: 'POST', headers: this.buildHeaders(), body: JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(300_000)]) : AbortSignal.timeout(300_000),
    }).catch((e) => { throw new Error(`LLM 网络错误 (${url}): ${e.message}`); });
    if (res.ok) return res;
    const text = await res.text();
    if ((res.status === 429 || res.status === 529 || res.status >= 500) && attempt < 3 && !signal?.aborted) {
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
      return this.post(body, attempt + 1, signal);
    }
    throw new Error(`LLM API ${res.status} (${url}): ${text.slice(0, 300)}`);
  }
}

/** 把用户填的各种写法归一到 …/v1：域名 → 加 /v1；…/anthropic → 加 /v1；…/v1 或 …/v1/ → 原样；…/v1/messages → 去掉 /messages */
export function normalizeBase(u: string): string {
  let b = (u ?? '').trim().replace(/\/+$/, '');
  if (!b) return '';
  b = b.replace(/\/messages$/, '');
  if (!/\/v\d+$/.test(b)) b += '/v1';
  return b;
}

// ---------------- 消息转换 ----------------

export function toAnthropic(messages: readonly Message[]): unknown[] {
  return messages.map((m) => {
    if (m.role === 'user') return { role: 'user', content: m.content };
    // Messages API 没有对话中的 system 角色，用带明确标记的 user 消息承载
    if (m.role === 'system') return { role: 'user', content: `<system_notice>${m.content}</system_notice>` };
    if (m.role === 'assistant') {
      const content: unknown[] = [];
      if (m.content) content.push({ type: 'text', text: m.content });
      for (const c of m.toolCalls) content.push({ type: 'tool_use', id: c.id, name: c.name, input: (c.input && typeof c.input === 'object' ? c.input : {}) });
      // 部分兼容端点不接受空 content 数组
      if (!content.length) content.push({ type: 'text', text: '(no content)' });
      return { role: 'assistant', content };
    }
    return { role: 'user', content: m.results.map((r) => ({ type: 'tool_result', tool_use_id: r.callId, content: r.result.ok ? r.result.output : r.result.error, is_error: !r.result.ok })) };
  });
}

// ---------------- 响应解析 ----------------

/** 非流式响应 */
export function parseJson(json: any, onDelta?: (t: string) => void): LLMResponse {
  if (json?.type === 'error' || json?.error) throw new Error(`LLM API 错误: ${JSON.stringify(json.error ?? json).slice(0, 300)}`);
  let text = '';
  const toolCalls: ToolCall[] = [];
  for (const block of json?.content ?? []) {
    if (block.type === 'text') text += block.text ?? '';
    else if (block.type === 'tool_use') toolCalls.push({ id: block.id || newId(), name: block.name, input: parseInput(block.input) });
    // thinking / redacted_thinking 等其他块忽略
  }
  if (text && onDelta) onDelta(text);
  return { text, toolCalls, stopReason: json?.stop_reason ?? undefined, usage: readUsage(json?.usage) };
}

/** 流式 SSE 响应 */
export async function parseStream(res: Response, onDelta?: (t: string) => void): Promise<LLMResponse> {
  let text = '';
  let stopReason: string | undefined;
  let usage = { inputTokens: 0, outputTokens: 0 };
  const blocks = new Map<number, { type: string; id: string; name: string; json: string; input?: unknown }>();
  for await (const data of sseData(res)) {
    let ev: any;
    try { ev = JSON.parse(data); } catch { continue; }
    switch (ev.type) {
      case 'message_start': usage = mergeUsage(usage, ev.message?.usage); break;
      case 'content_block_start': {
        const b = ev.content_block ?? {};
        blocks.set(ev.index ?? blocks.size, { type: b.type, id: b.id || newId(), name: b.name, json: '', input: b.input });
        if (b.type === 'text' && b.text) { text += b.text; onDelta?.(b.text); }
        break;
      }
      case 'content_block_delta': {
        const d = ev.delta ?? {};
        const b = blocks.get(ev.index ?? 0) ?? (blocks.set(ev.index ?? 0, { type: d.type === 'input_json_delta' ? 'tool_use' : 'text', id: newId(), name: '', json: '' }), blocks.get(ev.index ?? 0)!);
        if (d.type === 'text_delta' && d.text) { text += d.text; onDelta?.(d.text); }
        else if (d.type === 'input_json_delta' && d.partial_json) b.json += d.partial_json;
        break;
      }
      case 'message_delta': stopReason = ev.delta?.stop_reason ?? stopReason; usage = mergeUsage(usage, ev.usage); break;
      case 'error': throw new Error(`LLM 流式错误: ${JSON.stringify(ev.error ?? ev).slice(0, 300)}`);
      case 'message_stop': case 'content_block_stop': case 'ping': default: break;
    }
  }
  const toolCalls: ToolCall[] = [];
  for (const [, b] of [...blocks.entries()].sort((a, c) => a[0] - c[0])) {
    if (b.type !== 'tool_use') continue;
    // 标准实现：input 通过 partial_json 拼出来；某些实现：start 里直接给全 input、没有 delta
    const input = b.json.trim() ? parseInput(b.json) : parseInput(b.input);
    toolCalls.push({ id: b.id, name: b.name, input });
  }
  return { text, toolCalls, stopReason, usage };
}

function parseInput(v: unknown): unknown {
  if (v == null || v === '') return {};
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch { return v; }   // 解析失败保留原文，registry 会把校验错误回传模型
}
function readUsage(u: any) { return { inputTokens: u?.input_tokens ?? u?.prompt_tokens ?? 0, outputTokens: u?.output_tokens ?? u?.completion_tokens ?? 0 }; }
function mergeUsage(cur: { inputTokens: number; outputTokens: number }, u: any) {
  if (!u) return cur;
  const n = readUsage(u);
  return { inputTokens: n.inputTokens || cur.inputTokens, outputTokens: n.outputTokens || cur.outputTokens };
}
let seq = 0;
const newId = () => `toolu_${Date.now().toString(36)}_${++seq}`;

/** 逐条读取 SSE 的 data 段（忽略 event: 行，只看 data:，因为个别实现不发 event 行） */
async function* sseData(res: Response): AsyncGenerator<string> {
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
      if (line.startsWith('data:')) { const d = line.slice(5).trim(); if (d && d !== '[DONE]') yield d; }
    }
  }
}
