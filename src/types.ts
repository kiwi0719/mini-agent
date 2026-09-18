// ===== 统一的内部消息 / 工具 / 事件类型 =====

export type JSONSchema = {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
};

export interface ToolCall {
  id: string;
  name: string;
  /** 模型给出的原始参数（可能是对象，也可能是解析失败的字符串） */
  input: unknown;
}

export type ToolResult =
  | { ok: true; output: string }
  | { ok: false; error: string };

export interface PlanStep {
  id: number;
  title: string;
  status: 'pending' | 'in_progress' | 'done' | 'blocked' | 'skipped';
  note?: string;
}

/** Agent 暴露给“agent 级工具”（plan / delegate / search_tools）的运行时能力 */
export interface AgentRuntime {
  depth: number;
  getPlan(): PlanStep[];
  setPlan(steps: PlanStep[]): void;
  searchTools(query: string): { name: string; description: string; activated: boolean }[];
  listDeferredTools(): { name: string; description: string; activated: boolean }[];
  activateTools(names: string[]): string[];
  delegate(task: string, callId: string, opts?: { allowWrite?: boolean }): Promise<{ answer: string; steps: number; reason: FinishReason }>;
}

export interface ToolContext {
  workspace: string;
  allowWrite: boolean;
  runtime?: AgentRuntime;
  /** 当前正在执行的调用 id（agent 级工具需要它建立父子关系） */
  callId?: string;
  signal?: AbortSignal;
}

export interface Tool {
  name: string;
  description: string;
  inputSchema: JSONSchema;
  permission: 'read' | 'write';
  /** 只读且幂等的工具可以在超时后自动重试 */
  idempotent?: boolean;
  /** 延迟加载：默认不发给 LLM，需通过 search_tools 激活（Tool Search） */
  deferred?: boolean;
  execute(input: any, ctx: ToolContext): Promise<ToolResult>;
}

export interface ToolSchema {
  name: string;
  description: string;
  input_schema: JSONSchema;
}

export interface ToolResultEntry {
  callId: string;
  name: string;
  result: ToolResult;
  /** 由 Context 压缩过（正文被截断） */
  compressed?: boolean;
}

export type Message =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls: ToolCall[] }
  | { role: 'tool'; results: ToolResultEntry[] }
  /** 运行中注入的系统级提示（重复调用告警等）。Provider 各自映射到最合适的角色。 */
  | { role: 'system'; content: string };

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

export interface LLMResponse {
  text: string;
  toolCalls: ToolCall[];
  usage: Usage;
  stopReason?: string;
}

export interface LLMProvider {
  readonly name: string;
  /** onDelta 可选：支持流式输出时逐段回传文字增量 */
  chat(system: string, messages: readonly Message[], tools: ToolSchema[], onDelta?: (text: string) => void, signal?: AbortSignal): Promise<LLMResponse>;
}

// ===== Agent 事件（CLI / Trace / SSE 三方共用） =====
/** 每个事件都带来源 Agent；子 Agent 事件额外带父 Agent 与派生它的 delegate 调用 id，便于按树分组 */
type Base = { agent: string; depth: number; parent?: string; parentCallId?: string };
export type AgentEventBody =
  | { type: 'user'; task: string; ts: number }
  | { type: 'delta'; step: number; text: string; ts: number }
  | { type: 'plan'; step: number; plan: PlanStep[]; ts: number }
  | { type: 'tools_activated'; step: number; names: string[]; ts: number }
  | { type: 'compressed'; step: number; savedChars: number; sizeChars: number; ts: number }
  | { type: 'decision'; step: number; text: string; toolCalls: ToolCall[]; usage: Usage; durationMs: number; ts: number }
  | { type: 'tool_call'; step: number; call: ToolCall; ts: number }
  | { type: 'tool_result'; step: number; callId: string; name: string; result: ToolResult; durationMs: number; ts: number }
  | { type: 'notice'; step: number; message: string; ts: number }
  | { type: 'final'; answer: string; reason: FinishReason; steps: number; usage: Usage; ts: number };

export type AgentEvent = Base & AgentEventBody;

export type FinishReason = 'completed' | 'max_steps' | 'too_many_failures' | 'stuck_loop' | 'llm_error' | 'aborted';

/** Agent 对外可查询的运行状态快照 */
export interface AgentState {
  id: string;
  depth: number;
  status: 'idle' | 'running' | 'finished';
  step: number;
  plan: PlanStep[];
  activatedTools: string[];
  usage: Usage;
  consecutiveFailedRounds: number;
  failedCallStreak: number;
  finishReason?: FinishReason;
}

export interface AgentOptions {
  maxSteps?: number;
  maxConsecutiveFailures?: number;
  toolTimeoutMs?: number;
  allowWrite?: boolean;
  /** 上下文字符数超过该阈值后压缩旧的 tool result */
  compressThresholdChars?: number;
  /** 子 Agent 最大轮数 */
  subAgentMaxSteps?: number;
  /** 最大嵌套深度（0 = 主 Agent） */
  maxDepth?: number;
  /** 子 Agent 默认是否允许写；父 Agent 可在 delegate 时按需放开，但不能超过自身权限 */
  subAgentAllowWrite?: boolean;
  /** 外部中止信号：在步与步之间检查，并传给 LLM / 工具 */
  signal?: AbortSignal;
  onEvent?: (e: AgentEvent) => void;
}
