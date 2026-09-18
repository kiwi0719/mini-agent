import type { Message, ToolCall, ToolResultEntry } from './types.ts';

/**
 * 消息历史 + 上下文压缩。
 * 压缩采用不可变更新：生成新的 tool 消息对象替换旧的，绝不原地修改已交给 Provider 的对象，
 * 因此 Provider 即使缓存了对某条消息的转换结果也不会与 Context 失同步。
 */
export class Context {
  private _messages: Message[] = [];
  private compressThresholdChars: number;
  private sizeCache = 0;

  constructor(compressThresholdChars = 60_000) { this.compressThresholdChars = compressThresholdChars; }

  /** 只读视图；数组本身在每次追加后是新引用，便于 Provider/Mock 做基于引用的缓存 */
  get messages(): readonly Message[] { return this._messages; }

  addUser(content: string) { this.push({ role: 'user', content }); }

  addAssistant(content: string, toolCalls: ToolCall[]) { this.push({ role: 'assistant', content, toolCalls }); }

  /** 返回本次是否触发了压缩及节省的字符数，供 Agent 发事件 */
  addToolResults(results: ToolResultEntry[]): { compressed: boolean; savedChars: number; sizeChars: number } {
    this.push({ role: 'tool', results });
    const before = this.sizeCache;
    this.maybeCompress();
    return { compressed: this.sizeCache < before, savedChars: before - this.sizeCache, sizeChars: this.sizeCache };
  }

  /** 运行中注入的系统级提示 */
  addSystem(content: string) { this.push({ role: 'system', content }); }

  sizeChars(): number { return this.sizeCache; }

  private push(m: Message) {
    this._messages = [...this._messages, m];
    this.sizeCache += JSON.stringify(m).length;
  }

  /**
   * 压缩策略：超过阈值时，把除最近 2 条以外的 tool result 截断为 400 字符 + 标记。
   * 只压 tool result 正文，user / assistant / tool_call 结构一律不动，保证 tool_use ↔ tool_result 配对完整。
   */
  private maybeCompress() {
    if (this.sizeCache < this.compressThresholdChars) return;
    const toolIdx = this._messages.map((m, i) => (m.role === 'tool' ? i : -1)).filter((i) => i >= 0).slice(0, -2);
    if (!toolIdx.length) return;
    const next = [...this._messages];
    let changed = false;
    for (const i of toolIdx) {
      const m = next[i];
      if (m.role !== 'tool') continue;
      const results = m.results.map((r): ToolResultEntry => {
        if (r.compressed || !r.result.ok || r.result.output.length <= 400) return r;
        changed = true;
        return { ...r, compressed: true, result: { ok: true, output: r.result.output.slice(0, 400) + `\n…[已压缩，原始 ${r.result.output.length} 字符]` } };
      });
      next[i] = { role: 'tool', results };
    }
    if (!changed) return;
    this._messages = next;
    this.sizeCache = next.reduce((n, m) => n + JSON.stringify(m).length, 0);
  }
}
