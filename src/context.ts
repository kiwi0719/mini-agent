import type { Message, ToolCall, ToolResult } from './types.ts';

/** 消息历史 + 简单的上下文压缩 */
export class Context {
  readonly messages: Message[] = [];

  private compressThresholdChars: number;
  constructor(compressThresholdChars = 60_000) { this.compressThresholdChars = compressThresholdChars; }

  addUser(content: string) { this.messages.push({ role: 'user', content }); }

  addAssistant(content: string, toolCalls: ToolCall[]) { this.messages.push({ role: 'assistant', content, toolCalls }); }

  addToolResults(results: { callId: string; name: string; result: ToolResult }[]) {
    this.messages.push({ role: 'tool', results });
    this.maybeCompress();
  }

  /** 以 user 消息形式注入提醒（例如检测到重复调用） */
  addNotice(text: string) { this.messages.push({ role: 'user', content: `[系统提示] ${text}` }); }

  sizeChars(): number { return JSON.stringify(this.messages).length; }

  /**
   * 压缩策略：超过阈值时，把除最近 2 条以外的 tool result 截断成摘要。
   * 粗粒度但可预测；保留最近结果确保模型仍能基于最新信息决策。
   */
  private maybeCompress() {
    if (this.sizeChars() < this.compressThresholdChars) return;
    const toolMsgs = this.messages.filter((m) => m.role === 'tool');
    for (const m of toolMsgs.slice(0, -2)) {
      if (m.role !== 'tool') continue;
      for (const r of m.results) {
        if (r.result.ok && r.result.output.length > 400) {
          r.result = { ok: true, output: r.result.output.slice(0, 400) + `\n…[已压缩，原始 ${r.result.output.length} 字符]` };
        }
      }
    }
  }
}
