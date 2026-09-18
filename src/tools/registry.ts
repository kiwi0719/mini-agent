import { Ajv } from 'ajv';
import type { Tool, ToolCall, ToolContext, ToolResult, ToolSchema } from '../types.ts';
import { acquire, describeConflicts } from './write-guard.ts';

const ajv = new Ajv({ allErrors: true, strict: false });

export class ToolRegistry {
  private tools = new Map<string, Tool>();
  private validators = new Map<string, ReturnType<typeof ajv.compile>>();

  register(tool: Tool): this {
    if (this.tools.has(tool.name)) throw new Error(`duplicate tool: ${tool.name}`);
    this.tools.set(tool.name, tool);
    this.validators.set(tool.name, ajv.compile(tool.inputSchema));
    return this;
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  names(): string[] {
    return [...this.tools.keys()];
  }

  all(): Tool[] {
    return [...this.tools.values()];
  }

  /** Tool Search：按关键词匹配名称/描述（简单打分） */
  search(query: string): Tool[] {
    const terms = query.toLowerCase().split(/[\s,，、]+/).filter(Boolean);
    return this.all()
      .map((t) => ({ t, score: terms.reduce((n, w) => n + (t.name.toLowerCase().includes(w) ? 2 : 0) + (t.description.toLowerCase().includes(w) ? 1 : 0), 0) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((x) => x.t);
  }

  /** 输出给 LLM 的 schema 列表：非 deferred 工具 + 已激活的 deferred 工具 */
  schemas(activated: Set<string> = new Set()): ToolSchema[] {
    return [...this.tools.values()].filter((t) => !t.deferred || activated.has(t.name)).map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema,
    }));
  }

  /**
   * 解析参数 → 校验 → 权限 → 超时 → 执行。任何失败都以 ToolResult 形式返回，不抛异常。
   */
  async execute(call: ToolCall, baseCtx: ToolContext, timeoutMs: number): Promise<ToolResult> {
    const ctx: ToolContext = { ...baseCtx, callId: call.id };
    if (ctx.signal?.aborted) return { ok: false, error: '任务已被中止' };
    const tool = this.tools.get(call.name);
    if (!tool) {
      return { ok: false, error: `未知工具 "${call.name}"。可用工具: ${this.names().join(', ')}` };
    }

    // 1. 参数解析（模型偶尔会把 JSON 当字符串传回）
    let input: unknown = call.input;
    if (typeof input === 'string') {
      try {
        input = JSON.parse(input);
      } catch {
        return { ok: false, error: `参数不是合法 JSON: ${(input as string).slice(0, 200)}` };
      }
    }
    if (input === undefined || input === null) input = {};

    // 2. schema 校验
    const validate = this.validators.get(call.name)!;
    if (!validate(input)) {
      const msg = (validate.errors ?? [])
        .map((e) => `${e.instancePath || '(root)'} ${e.message}`)
        .join('; ');
      return { ok: false, error: `参数校验失败: ${msg}` };
    }

    // 3. 权限
    if (tool.permission === 'write' && !ctx.allowWrite) {
      return { ok: false, error: `工具 "${tool.name}" 需要写权限，当前未授权 (--allow-write)` };
    }

    // 3.5 并发写冲突：只有声明了 writeTargets 的写工具会走这里，只读工具零开销
    if (tool.permission === 'write' && tool.writeTargets && ctx.owner) {
      const targets = tool.writeTargets(input, ctx);
      if (targets.length) {
        const got = acquire(targets, ctx.owner);
        if (!got.ok) {
          return { ok: false, error: `写目标冲突：${describeConflicts(got.conflicts)}。请改写到其他文件，或先完成/放弃占用方的任务。` };
        }
      }
    }

    // 4. 超时 + 执行。重试边界（见 DESIGN.md §4）：
    //    仅当 (a) 工具声明幂等 且 (b) 错误被判定为“瞬时错误”时，重试 1 次。
    //    文件不存在 / 路径越界 / 二进制文件 / 参数错误 等确定性错误重试无意义，直接返回给模型决策。
    const maxAttempts = tool.idempotent ? 2 : 1;
    let last: ToolResult = { ok: false, error: 'unknown' };
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      last = await withTimeout(tool.execute(input, ctx), timeoutMs).catch((e: unknown) => ({
        ok: false as const,
        error: e instanceof Error ? e.message : String(e),
      }));
      if (last.ok || !isTransientError(last.error) || attempt === maxAttempts) break;
      last = { ok: false, error: `${last.error} (已自动重试 1 次)` };
    }
    return last;
  }
}

/** 瞬时错误：重试可能成功。其余（ENOENT、EACCES、越界、校验失败……）视为确定性错误。 */
export function isTransientError(message: string): boolean {
  return /timeout|超时|EBUSY|EAGAIN|EMFILE|ENFILE|ETIMEDOUT|ECONNRESET/i.test(message);
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`工具执行超时 (timeout ${ms}ms)`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}
