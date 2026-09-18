import { createHash } from 'node:crypto';
import type { AgentEvent, AgentEventBody, AgentOptions, AgentRuntime, AgentState, FinishReason, LLMProvider, PlanStep, ToolCall, ToolResultEntry, Usage } from './types.ts';
import { ToolRegistry } from './tools/registry.ts';
import { Context } from './context.ts';
import { acquire, describeConflicts, makeOwner, releaseAll } from './tools/write-guard.ts';
import { resolveInWorkspace } from './tools/sandbox.ts';

export const SYSTEM_PROMPT = `你是一个在受限 workspace 中工作的任务型 Agent。
规则：
1. 只能通过提供的工具访问文件；所有路径相对于 workspace 根目录（不要加 "workspace/" 前缀）。
2. 多步任务先用 update_plan 制定计划；每完成一步或需要改变策略（例如工具失败）时用 update_plan 修订计划。
3. 需要精确数值计算时务必使用 calculator，不要自己心算。
4. 现有工具不够用时，先用 search_tools 搜索扩展工具；需要多步推理、或会产生大量中间输出而你只要结论的子任务可用 delegate 交给子 Agent（同一轮的多个 delegate 会并行；预计 1 步能做完的事自己直接调工具，不要派生）。
4.1 若任务会写文件，在第一次 update_plan 时用 writes 一次性声明全部输出路径，避免与其他并发任务写冲突到最后才发现。
5. 互不依赖的只读调用可以放在同一轮并行发出。
6. 工具失败时阅读错误信息并调整策略（换路径、先 list_files、跳过坏数据等），不要原样重复同一调用。
7. 若任务确实无法完成，明确说明原因并停止。
8. 任务完成后给出简洁的最终答案（做了什么、结果是什么、写了哪些文件），不要再调用工具。
9. 日志分析任务：用 log_stats / log_latency / log_errors / log_timeline 获取统计（互不依赖，可同一轮并行），对主要错误簇的 sampleTraceIds 用 log_trace 还原链路，再把报告写入文件。报告必须区分"统计事实"与"推断的原因"。
10. Kubernetes 故障诊断任务：先 get_pod，再根据其信号决定查 get_pod_events / get_node / get_metrics / get_logs（OOM 或重启类要看 previous=true 的日志），可用 search_runbook / search_cases 对照已知模式。最终答案必须使用下面的固定结构，"已确认事实"只能引用工具返回的原文，"可能原因"必须给置信度与依据；证据不足时不要强行下结论，在最后一节写明还缺什么信息。修复动作（apply_fix）是写操作，执行前必须在回复中说明动作与风险；被拒绝时把方案写进处理建议。修复后用 verify_fix 复查。

## 故障现象
## 关键证据
- [Pod|Event|Node|Metric|Log|Runbook|Case] 证据原文（来源工具）
## 已确认事实
## 可能原因（推测）
- 原因 · 置信度 高|中|低 · 依据
## 处理建议
## 证据不足说明
（无则写"无"）`;

export interface AgentRunResult {
  answer: string;
  reason: FinishReason;
  steps: number;
  usage: Usage;
  plan: PlanStep[];
}

type Resolved = Required<Omit<AgentOptions, 'onEvent' | 'signal'>> & { onEvent: (e: AgentEvent) => void; signal?: AbortSignal };

export class Agent {
  private opts: Resolved;
  private llm: LLMProvider;
  private tools: ToolRegistry;
  private workspace: string;
  readonly id: string;
  readonly depth: number;
  private parent?: { id: string; callId: string };
  private static counter = 0;

  /** 可查询的运行状态（问题 2：不再只存在于闭包里） */
  private state: AgentState;

  constructor(llm: LLMProvider, tools: ToolRegistry, workspace: string, opts: AgentOptions = {}, meta: { id?: string; depth?: number; parent?: { id: string; callId: string } } = {}) {
    this.llm = llm;
    this.tools = tools;
    this.workspace = workspace;
    this.depth = meta.depth ?? 0;
    this.parent = meta.parent;
    if (this.depth === 0) Agent.counter = 0; // 子 Agent 编号在每个主 Agent 内从 1 开始
    this.id = meta.id ?? (this.depth === 0 ? 'main' : `sub-${++Agent.counter}`);
    this.opts = {
      maxSteps: opts.maxSteps ?? 15,
      maxConsecutiveFailures: opts.maxConsecutiveFailures ?? 3,
      toolTimeoutMs: opts.toolTimeoutMs ?? 10_000,
      allowWrite: opts.allowWrite ?? true,
      compressThresholdChars: opts.compressThresholdChars ?? 60_000,
      subAgentMaxSteps: opts.subAgentMaxSteps ?? 8,
      maxDepth: opts.maxDepth ?? 1,
      subAgentAllowWrite: opts.subAgentAllowWrite ?? false,
      signal: opts.signal,
      // 子 Agent 继承父级 owner：同一任务树共享写预约，不会自锁；不同任务之间才互斥
      owner: opts.owner ?? makeOwner(meta.id ?? (meta.depth ? `sub${meta.depth}` : 'main')),
      delegateMinExpectedSteps: opts.delegateMinExpectedSteps ?? 2,
      onEvent: opts.onEvent ?? (() => {}),
    };
    this.state = { id: this.id, depth: this.depth, status: 'idle', step: 0, plan: [], activatedTools: [], usage: { inputTokens: 0, outputTokens: 0 }, consecutiveFailedRounds: 0, failedCallStreak: 0 };
  }

  getState(): AgentState { return structuredClone(this.state); }

  async run(task: string): Promise<AgentRunResult> {
    const st = this.state;
    if (st.status === 'running') throw new Error(`Agent ${this.id} 已在运行`);
    Object.assign(st, { status: 'running', step: 0, plan: [], activatedTools: [], usage: { inputTokens: 0, outputTokens: 0 }, consecutiveFailedRounds: 0, failedCallStreak: 0, finishReason: undefined });

    const ctx = new Context(this.opts.compressThresholdChars);
    const base = { agent: this.id, depth: this.depth, ...(this.parent ? { parent: this.parent.id, parentCallId: this.parent.callId } : {}) };
    const emit = (e: AgentEventBody) => this.opts.onEvent({ ...base, ...e });
    const signal = this.opts.signal;
    const activated = new Set<string>();
    const recentCallHashes: string[] = [];
    let noticedHash: string | undefined;   // 问题 7：已针对哪个指纹发过提醒
    let roundsSinceNotice = 0;

    const runtime: AgentRuntime = {
      depth: this.depth,
      getPlan: () => st.plan,
      setPlan: (steps) => { st.plan = steps; emit({ type: 'plan', step: st.step, plan: steps, ts: Date.now() }); },
      searchTools: (q) => this.tools.search(q).filter((t) => t.deferred).map((t) => ({ name: t.name, description: t.description, activated: activated.has(t.name) })),
      listDeferredTools: () => this.tools.all().filter((t) => t.deferred).map((t) => ({ name: t.name, description: t.description, activated: activated.has(t.name) })),
      activateTools: (names) => {
        const fresh = names.filter((n) => this.tools.get(n)?.deferred && !activated.has(n));
        fresh.forEach((n) => activated.add(n));
        st.activatedTools = [...activated];
        if (fresh.length) emit({ type: 'tools_activated', step: st.step, names: fresh, ts: Date.now() });
        return names;
      },
      reserveWrites: (paths) => {
        // 相对路径按 workspace 解析为绝对路径，与 write_file 的 writeTargets 口径一致
        const targets: string[] = [];
        for (const p of paths) {
          try { targets.push(resolveInWorkspace(this.workspace, p)); }
          catch (e) { return `"${p}" 不在 workspace 内（${(e as Error).message}）`; }
        }
        const got = acquire(targets, this.opts.owner);
        if (!got.ok) return describeConflicts(got.conflicts);
        emit({ type: 'writes_reserved', step: st.step, targets: paths.slice(), ts: Date.now() });
        return null;
      },
      delegate: async (subTask, callId, o = {}) => {
        // expected_steps 门槛：派生子 Agent 至少要多花两次模型调用（子 Agent 决策 + 收尾），
        // 预计 1 步能完成的子任务自己直接调工具更快更省。这是事前拦截，不是事后提醒。
        const expected = o.expectedSteps ?? 0;
        if (expected < this.opts.delegateMinExpectedSteps) {
          return { answer: '', steps: 0, reason: 'completed', rejected: `子任务预计只需 ${expected} 步，低于派生门槛 ${this.opts.delegateMinExpectedSteps} 步。派生子 Agent 本身要额外消耗模型调用，这种情况直接自己调用工具更快。请自己执行这个子任务。` };
        }
        if (this.depth >= this.opts.maxDepth) return { answer: `已达到最大嵌套深度 ${this.opts.maxDepth}，不能再派生子 Agent`, steps: 0, reason: 'max_steps' };
        // 问题 8：子 Agent 权限只能收窄，不能超过父 Agent
        const allowWrite = this.opts.allowWrite && (o.allowWrite ?? this.opts.subAgentAllowWrite);
        const child = new Agent(this.llm, this.tools, this.workspace, { ...this.opts, maxSteps: this.opts.subAgentMaxSteps, allowWrite, owner: this.opts.owner }, { depth: this.depth + 1, parent: { id: this.id, callId } });
        const r = await child.run(subTask);
        st.usage.inputTokens += r.usage.inputTokens;
        st.usage.outputTokens += r.usage.outputTokens;
        return { answer: r.answer, steps: r.steps, reason: r.reason };
      },
    };
    const toolCtx = { workspace: this.workspace, allowWrite: this.opts.allowWrite, runtime, signal, owner: this.opts.owner };

    ctx.addUser(task);
    emit({ type: 'user', task, ts: Date.now() });

    const finish = (answer: string, reason: FinishReason): AgentRunResult => {
      st.status = 'finished';
      st.finishReason = reason;
      // 只有根 Agent 释放：子 Agent 与父级共享 owner，提前释放会把父级的预约一并撤掉
      if (this.depth === 0) releaseAll(this.opts.owner);
      emit({ type: 'final', answer, reason, steps: st.step, usage: st.usage, ts: Date.now() });
      return { answer, reason, steps: st.step, usage: st.usage, plan: st.plan };
    };

    while (st.step < this.opts.maxSteps) {
      if (signal?.aborted) return finish('任务被外部中止。', 'aborted');
      st.step++;
      const step = st.step;

      // ---- 1. 询问 LLM ----
      let resp;
      const tLlm = Date.now();
      try {
        const schemas = this.tools.schemas(activated).filter((s) => !(this.depth >= this.opts.maxDepth && s.name === 'delegate'));
        resp = await this.llm.chat(SYSTEM_PROMPT, ctx.messages, schemas, (text) => emit({ type: 'delta', step, text, ts: Date.now() }), signal);
      } catch (e) {
        if (signal?.aborted) return finish('任务被外部中止。', 'aborted');
        return finish(`LLM 调用失败，任务中止: ${(e as Error).message}`, 'llm_error');
      }
      st.usage.inputTokens += resp.usage.inputTokens;
      st.usage.outputTokens += resp.usage.outputTokens;
      emit({ type: 'decision', step, text: resp.text, toolCalls: resp.toolCalls, usage: resp.usage, durationMs: Date.now() - tLlm, ts: Date.now() });

      // ---- 2. 没有 tool call → 最终答案 ----
      if (resp.toolCalls.length === 0) return finish(resp.text.trim() || '(模型未给出文字答案)', 'completed');
      ctx.addAssistant(resp.text, resp.toolCalls);

      // ---- 3. 执行 tool call：只读工具并行，写工具在其后串行（问题 5） ----
      const results = await this.executeRound(resp.toolCalls, toolCtx, step, emit);
      const c = ctx.addToolResults(results);
      if (c.compressed) emit({ type: 'compressed', step, savedChars: c.savedChars, sizeChars: c.sizeChars, ts: Date.now() });
      if (signal?.aborted) return finish('任务被外部中止。', 'aborted');

      // ---- 4. 失败保护（问题 6：轮级多数失败 + 单调用连续失败两条线） ----
      const failed = results.filter((r) => !r.result.ok).length;
      st.consecutiveFailedRounds = failed >= results.length - failed ? st.consecutiveFailedRounds + 1 : 0; // 失败数 ≥ 成功数即视为失败轮
      for (const r of results) st.failedCallStreak = r.result.ok ? 0 : st.failedCallStreak + 1;
      if (st.consecutiveFailedRounds >= this.opts.maxConsecutiveFailures || st.failedCallStreak >= this.opts.maxConsecutiveFailures * 2) {
        const errs = results.filter((r) => !r.result.ok).map((r) => (r.result as { error: string }).error).join('; ');
        return finish(`工具调用持续失败（连续 ${st.consecutiveFailedRounds} 轮多数失败 / 连续 ${st.failedCallStreak} 次调用失败），任务中止。最后错误: ${errs}`, 'too_many_failures');
      }

      // ---- 5. 重复调用保护（问题 7：只提醒一次；提醒后仍重复 2 轮则终止） ----
      const hash = callsHash(resp.toolCalls);
      recentCallHashes.push(hash);
      const repeating = recentCallHashes.length >= 3 && recentCallHashes.slice(-3).every((h) => h === hash);
      if (repeating && noticedHash !== hash) {
        noticedHash = hash;
        roundsSinceNotice = 0;
        const msg = '检测到连续 3 次完全相同的工具调用，请更换策略或直接给出结论。';
        ctx.addSystem(msg);
        emit({ type: 'notice', step, message: msg, ts: Date.now() });
      } else if (noticedHash === hash) {
        roundsSinceNotice++;
        if (roundsSinceNotice >= 2) return finish(`提醒后仍连续重复相同的工具调用（${resp.toolCalls.map((c) => c.name).join(', ')}），判定为死循环，任务中止。`, 'stuck_loop');
      } else if (noticedHash && hash !== noticedHash) {
        noticedHash = undefined; // 模型已换策略，重置
      }
    }

    return finish(`已达到最大轮数 (${this.opts.maxSteps})，任务未完成。请缩小任务范围或提高 maxSteps。`, 'max_steps');
  }

  /**
   * 一轮内的调用分两组：read 权限工具（含 delegate、search_tools 等）并行执行；
   * write 工具在只读组全部完成后按顺序执行，避免同一轮内对同一文件的写入竞争。
   * 结果按原调用顺序返回，保证 tool_use ↔ tool_result 一一对应。
   */
  private async executeRound(calls: ToolCall[], toolCtx: Parameters<ToolRegistry['execute']>[1], step: number, emit: (e: AgentEventBody) => void): Promise<ToolResultEntry[]> {
    const run = async (call: ToolCall): Promise<ToolResultEntry> => {
      emit({ type: 'tool_call', step, call, ts: Date.now() });
      const t0 = Date.now();
      const timeout = call.name === 'delegate' ? this.opts.toolTimeoutMs * this.opts.subAgentMaxSteps * 3 : this.opts.toolTimeoutMs;
      const result = await this.tools.execute(call, toolCtx, timeout);
      emit({ type: 'tool_result', step, callId: call.id, name: call.name, result, durationMs: Date.now() - t0, ts: Date.now() });
      return { callId: call.id, name: call.name, result };
    };
    const isWrite = (c: ToolCall) => this.tools.get(c.name)?.permission === 'write';
    const readResults = await Promise.all(calls.filter((c) => !isWrite(c)).map(run));

    // 同一轮内多个写调用指向同一目标：锁按 owner 判定，自己不会拦自己，这里显式检测。
    // 后写的会静默覆盖先写的，几乎总是模型自相矛盾，直接报错让它合并成一次写入。
    const writeCalls = calls.filter(isWrite);
    const seen = new Map<string, string>();
    const dupErr = new Map<string, string>();
    for (const c of writeCalls) {
      const tool = this.tools.get(c.name)!;
      const input = typeof c.input === 'string' ? safeParse(c.input) : c.input;
      for (const t of tool.writeTargets?.(input, toolCtx) ?? []) {
        const prev = seen.get(t);
        if (prev) dupErr.set(c.id, `本轮已有另一个调用(${prev})写同一个目标 "${t}"，后写会覆盖先写。请合并成一次写入，或写到不同文件。`);
        else seen.set(t, c.name);
      }
    }

    const writeResults: ToolResultEntry[] = [];
    for (const c of writeCalls) {
      const err = dupErr.get(c.id);
      if (err) {
        emit({ type: 'tool_call', step, call: c, ts: Date.now() });
        const result = { ok: false as const, error: err };
        emit({ type: 'tool_result', step, callId: c.id, name: c.name, result, durationMs: 0, ts: Date.now() });
        writeResults.push({ callId: c.id, name: c.name, result });
        continue;
      }
      writeResults.push(await run(c));
    }
    const byId = new Map([...readResults, ...writeResults].map((r) => [r.callId, r]));
    return calls.map((c) => byId.get(c.id)!);
  }
}

/** 一轮工具调用的指纹：对 (name, 规范化 input) 排序后取 sha1，避免保存/比较大段参数文本 */
function callsHash(calls: ToolCall[]): string {
  const canonical = calls.map((c) => `${c.name}:${stableStringify(c.input)}`).sort().join('|');
  return createHash('sha1').update(canonical).digest('hex');
}

function safeParse(s: string): unknown {
  try { return JSON.parse(s); } catch { return {}; }
}

function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(',')}}`;
}
