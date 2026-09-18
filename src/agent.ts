import { createHash } from 'node:crypto';
import type { AgentEvent, AgentEventBody, AgentOptions, AgentRuntime, FinishReason, LLMProvider, PlanStep, ToolCall, ToolResult, Usage } from './types.ts';
import { ToolRegistry } from './tools/registry.ts';
import { Context } from './context.ts';

export const SYSTEM_PROMPT = `你是一个在受限 workspace 中工作的任务型 Agent。
规则：
1. 只能通过提供的工具访问文件；所有路径相对于 workspace 根目录（不要加 "workspace/" 前缀）。
2. 多步任务先用 update_plan 制定计划；每完成一步或需要改变策略（例如工具失败）时用 update_plan 修订计划。
3. 需要精确数值计算时务必使用 calculator，不要自己心算。
4. 现有工具不够用时，先用 search_tools 搜索扩展工具；相互独立、可重复的子任务可用 delegate 交给子 Agent。
5. 工具失败时阅读错误信息并调整策略（换路径、先 list_files、跳过坏数据等），不要原样重复同一调用。
6. 若任务确实无法完成，明确说明原因并停止。
7. 任务完成后给出简洁的最终答案（做了什么、结果是什么、写了哪些文件），不要再调用工具。`;

export interface AgentRunResult {
  answer: string;
  reason: FinishReason;
  steps: number;
  usage: Usage;
  plan: PlanStep[];
}

type Resolved = Required<Omit<AgentOptions, 'onEvent'>> & { onEvent: (e: AgentEvent) => void };

export class Agent {
  private opts: Resolved;
  private llm: LLMProvider;
  private tools: ToolRegistry;
  private workspace: string;
  private id: string;
  private depth: number;
  private static counter = 0;

  constructor(llm: LLMProvider, tools: ToolRegistry, workspace: string, opts: AgentOptions = {}, meta: { id?: string; depth?: number } = {}) {
    this.llm = llm;
    this.tools = tools;
    this.workspace = workspace;
    this.depth = meta.depth ?? 0;
    this.id = meta.id ?? (this.depth === 0 ? 'main' : `sub-${++Agent.counter}`);
    this.opts = {
      maxSteps: opts.maxSteps ?? 15,
      maxConsecutiveFailures: opts.maxConsecutiveFailures ?? 3,
      toolTimeoutMs: opts.toolTimeoutMs ?? 10_000,
      allowWrite: opts.allowWrite ?? true,
      compressThresholdChars: opts.compressThresholdChars ?? 60_000,
      subAgentMaxSteps: opts.subAgentMaxSteps ?? 8,
      maxDepth: opts.maxDepth ?? 1,
      onEvent: opts.onEvent ?? (() => {}),
    };
  }

  async run(task: string): Promise<AgentRunResult> {
    const ctx = new Context(this.opts.compressThresholdChars);
    const base = { agent: this.id, depth: this.depth };
    const emit = (e: AgentEventBody) => this.opts.onEvent({ ...base, ...e });
    const usage: Usage = { inputTokens: 0, outputTokens: 0 };
    let plan: PlanStep[] = [];
    const activated = new Set<string>();
    let consecutiveFailures = 0;
    const recentCallHashes: string[] = [];
    let step = 0;

    // 暴露给 agent 级工具的运行时
    const runtime: AgentRuntime = {
      depth: this.depth,
      getPlan: () => plan,
      setPlan: (steps) => { plan = steps; emit({ type: 'plan', step, plan, ts: Date.now() }); },
      searchTools: (q) => this.tools.search(q).filter((t) => t.deferred).map((t) => ({ name: t.name, description: t.description, activated: activated.has(t.name) })),
      activateTools: (names) => {
        const fresh = names.filter((n) => this.tools.get(n)?.deferred && !activated.has(n));
        fresh.forEach((n) => activated.add(n));
        if (fresh.length) emit({ type: 'tools_activated', step, names: fresh, ts: Date.now() });
        return names;
      },
      delegate: async (subTask) => {
        if (this.depth >= this.opts.maxDepth) return { answer: `已达到最大嵌套深度 ${this.opts.maxDepth}，不能再派生子 Agent`, steps: 0, reason: 'max_steps' };
        const child = new Agent(this.llm, this.tools, this.workspace, { ...this.opts, maxSteps: this.opts.subAgentMaxSteps }, { depth: this.depth + 1 });
        const r = await child.run(subTask);
        usage.inputTokens += r.usage.inputTokens;
        usage.outputTokens += r.usage.outputTokens;
        return { answer: r.answer, steps: r.steps, reason: r.reason };
      },
    };
    const toolCtx = { workspace: this.workspace, allowWrite: this.opts.allowWrite, runtime };

    ctx.addUser(task);
    emit({ type: 'user', task, ts: Date.now() });

    const finish = (answer: string, reason: FinishReason): AgentRunResult => {
      emit({ type: 'final', answer, reason, steps: step, usage, ts: Date.now() });
      return { answer, reason, steps: step, usage, plan };
    };

    while (step < this.opts.maxSteps) {
      step++;

      // ---- 1. 询问 LLM（流式增量通过 delta 事件透出） ----
      let resp;
      const tLlm = Date.now();
      try {
        const schemas = this.tools.schemas(activated).filter((s) => !(this.depth >= this.opts.maxDepth && s.name === 'delegate'));
        resp = await this.llm.chat(SYSTEM_PROMPT, ctx.messages, schemas, (text) => emit({ type: 'delta', step, text, ts: Date.now() }));
      } catch (e) {
        return finish(`LLM 调用失败，任务中止: ${(e as Error).message}`, 'llm_error');
      }
      usage.inputTokens += resp.usage.inputTokens;
      usage.outputTokens += resp.usage.outputTokens;
      emit({ type: 'decision', step, text: resp.text, toolCalls: resp.toolCalls, usage: resp.usage, durationMs: Date.now() - tLlm, ts: Date.now() });

      // ---- 2. 没有 tool call → 最终答案 ----
      if (resp.toolCalls.length === 0) {
        return finish(resp.text.trim() || '(模型未给出文字答案)', 'completed');
      }
      ctx.addAssistant(resp.text, resp.toolCalls);

      // ---- 3. 执行所有 tool call（同一轮可多个） ----
      const results: { callId: string; name: string; result: ToolResult }[] = [];
      let allFailed = true;
      for (const call of resp.toolCalls) {
        emit({ type: 'tool_call', step, call, ts: Date.now() });
        const t0 = Date.now();
        // delegate 内部会跑一个完整子 Agent，超时按子 Agent 轮数放大
        const timeout = call.name === 'delegate' ? this.opts.toolTimeoutMs * this.opts.subAgentMaxSteps * 3 : this.opts.toolTimeoutMs;
        const result = await this.tools.execute(call, toolCtx, timeout);
        emit({ type: 'tool_result', step, callId: call.id, name: call.name, result, durationMs: Date.now() - t0, ts: Date.now() });
        results.push({ callId: call.id, name: call.name, result });
        if (result.ok) allFailed = false;
      }
      ctx.addToolResults(results);

      // ---- 4. 失败与循环保护 ----
      consecutiveFailures = allFailed ? consecutiveFailures + 1 : 0;
      if (consecutiveFailures >= this.opts.maxConsecutiveFailures) {
        return finish(`连续 ${consecutiveFailures} 轮工具调用全部失败，任务中止。最后错误: ${results.map((r) => (r.result.ok ? '' : r.result.error)).filter(Boolean).join('; ')}`, 'too_many_failures');
      }
      const hash = callsHash(resp.toolCalls);
      recentCallHashes.push(hash);
      if (recentCallHashes.length >= 3 && recentCallHashes.slice(-3).every((h) => h === hash)) {
        const msg = '检测到连续 3 次完全相同的工具调用，请更换策略或直接给出结论。';
        ctx.addNotice(msg);
        emit({ type: 'notice', step, message: msg, ts: Date.now() });
      }
    }

    return finish(`已达到最大轮数 (${this.opts.maxSteps})，任务未完成。请缩小任务范围或提高 maxSteps。`, 'max_steps');
  }
}

/** 一轮工具调用的指纹：对 (name, 规范化 input) 排序后取 sha1，避免保存/比较大段参数文本 */
function callsHash(calls: ToolCall[]): string {
  const canonical = calls.map((c) => `${c.name}:${stableStringify(c.input)}`).sort().join('|');
  return createHash('sha1').update(canonical).digest('hex');
}

function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(',')}}`;
}
