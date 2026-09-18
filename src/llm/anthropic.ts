import Anthropic from '@anthropic-ai/sdk';
import type { LLMProvider, LLMResponse, Message, ToolSchema } from '../types.ts';

/**
 * Anthropic Messages API。手写 tool-use 协议转换（不用 SDK 的 toolRunner，
 * 因为 Agent Loop 要由我们自己控制）。
 */
export class AnthropicProvider implements LLMProvider {
  readonly name: string;
  private client: Anthropic;
  private model: string;

  constructor(model = process.env.ANTHROPIC_MODEL ?? 'claude-opus-5') {
    this.client = new Anthropic({ maxRetries: 3, timeout: 120_000 });
    this.model = model;
    this.name = `anthropic:${model}`;
  }

  async chat(system: string, messages: Message[], tools: ToolSchema[], onDelta?: (t: string) => void): Promise<LLMResponse> {
    // 流式：文字增量实时回传给 Agent；最终用 finalMessage() 拿完整消息（含 tool_use 块）
    const stream = this.client.messages.stream({
      model: this.model,
      max_tokens: 16000,
      system,
      tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema })),
      messages: toAnthropic(messages),
    });
    if (onDelta) stream.on('text', onDelta);
    const resp = await stream.finalMessage();

    let text = '';
    const toolCalls = [];
    for (const block of resp.content) {
      if (block.type === 'text') text += block.text;
      else if (block.type === 'tool_use') toolCalls.push({ id: block.id, name: block.name, input: block.input });
    }
    return {
      text,
      toolCalls,
      stopReason: resp.stop_reason ?? undefined,
      usage: { inputTokens: resp.usage.input_tokens, outputTokens: resp.usage.output_tokens },
    };
  }
}

function toAnthropic(messages: Message[]): Anthropic.MessageParam[] {
  return messages.map((m): Anthropic.MessageParam => {
    if (m.role === 'user') return { role: 'user', content: m.content };
    if (m.role === 'assistant') {
      const content: Anthropic.ContentBlockParam[] = [];
      if (m.content) content.push({ type: 'text', text: m.content });
      for (const c of m.toolCalls) content.push({ type: 'tool_use', id: c.id, name: c.name, input: (c.input ?? {}) as Record<string, unknown> });
      return { role: 'assistant', content };
    }
    return {
      role: 'user',
      content: m.results.map((r): Anthropic.ToolResultBlockParam => ({
        type: 'tool_result',
        tool_use_id: r.callId,
        content: r.result.ok ? r.result.output : r.result.error,
        is_error: !r.result.ok,
      })),
    };
  });
}
