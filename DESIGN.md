# Mini Agent 设计说明

> 一个能够自主调用工具完成任务的最小化 AI Agent（TypeScript / Node.js，CLI）。

## 1. 总体架构

```
┌──────────────┐   task    ┌─────────────────────────────────────────┐
│    CLI       │──────────▶│               Agent Loop                │
│ (src/cli.ts) │           │  while (step < maxSteps):               │
└──────────────┘           │    1. LLM.chat(context, toolSchemas)    │
                           │    2. 无 tool_call → Final Answer, 退出 │
                           │    3. 解析/校验参数 → ToolRegistry.run  │
                           │    4. ToolResult 追加到 Context         │
                           │    5. Trace 记录每一步                  │
                           └────┬───────────┬───────────┬────────────┘
                                │           │           │
                        ┌───────▼──┐  ┌─────▼─────┐ ┌───▼────────┐
                        │ LLM      │  │ Tool      │ │ Context    │
                        │ Provider │  │ Registry  │ │ (messages, │
                        │ anthropic│  │ read_file │ │ 压缩策略)  │
                        │ openai-  │  │ write_file│ └────────────┘
                        │ compat   │  │search_text│
                        │ mock     │  │calculator │
                        └──────────┘  │ list_files│
                                      └───────────┘
```

### 职责划分

| 模块 | 职责 | 不负责 |
|---|---|---|
| **Agent** (`src/agent.ts`) | 主循环、轮数控制、决定何时结束、失败重试/恢复策略、Trace | 不理解业务、不直接读写文件 |
| **LLM Provider** (`src/llm/*`) | 把 Context + Tool Schema 发给模型，返回统一格式的 `{text, toolCalls, usage}` | 不执行工具、不管理历史 |
| **Tool** (`src/tools/*`) | 单一功能、纯函数式；声明 JSON Schema；对输入做校验；沙箱路径检查 | 不知道 Agent 的存在 |
| **Context** (`src/context.ts`) | 保存消息历史、统计 token、超长时压缩旧的 tool result | 不做决策 |
| **Trace** (`src/trace.ts`) | 记录 User → Decision → ToolCall → ToolResult → … → Final，输出 JSON + Markdown | |

## 2. Agent Loop 设计

```
step = 0
context.push(user task)
loop:
  step++ ; if step > MAX_STEPS → 强制结束，输出“达到最大轮数”的总结
  resp = llm.chat(context.messages, registry.schemas())
  trace.decision(resp.text, resp.toolCalls)
  if resp.toolCalls.length == 0:
      → 最终答案 = resp.text ; break
  for call in resp.toolCalls:              # 支持一轮多个并行 tool call
      result = registry.execute(call)      # 内部：schema 校验 → 权限检查 → timeout → 执行
      context.pushToolResult(call.id, result)   # 失败也回传（is_error=true），让模型自己决定重试/换路
      trace.toolCall(call, result)
  if 连续 N 次工具全部失败 → 提前结束并报告
```

**任务结束判定**：模型返回一条不包含任何 tool call 的消息（`stop_reason == end_turn`），即视为最终答案。
另外两种终止：达到 `maxSteps`；连续失败次数超过阈值。

**避免无限调用**：
1. `maxSteps` 硬上限（默认 15）；
2. 重复调用检测：同一个工具+同样参数连续出现 ≥3 次，注入一条 system 提示要求换策略；
3. 连续失败阈值；
4. 每个工具调用有 `timeout`（默认 10s）。

## 3. Tool 定义

```ts
interface Tool<I> {
  name: string;
  description: string;
  inputSchema: JSONSchema;          // 给 LLM + 用于参数校验（ajv）
  permission?: 'read' | 'write';    // write 类工具可要求 --yes 或交互确认
  execute(input: I, ctx: ToolContext): Promise<ToolResult>;
}
type ToolResult = { ok: true; output: string } | { ok: false; error: string };
```

- `ToolRegistry.register(tool)`；`schemas()` 输出给 LLM；`execute(name, rawInput)` 负责：
  未知工具 → 错误；JSON 解析失败 → 错误；schema 校验失败 → 错误（带具体字段）；超时；捕获异常。
- 所有路径类参数经过 `resolveInWorkspace()`，禁止 `..` 逃出 workspace 根目录。
- 基础工具：`read_file`、`write_file`、`search_text`（正则/关键字，支持 glob）、`calculator`（安全表达式求值，不用 eval）、`list_files`。

## 4. 失败处理

| 失败类型 | 处理 |
|---|---|
| 参数不合法 | 立即返回错误说明给模型，不执行 |
| 文件不存在 / 越权路径 | 返回 `is_error` 结果，模型可改用 list_files/search_text 探索 |
| 工具抛异常 / 超时 | 捕获后返回错误；同一调用最多自动重试 1 次（仅幂等的 read 类工具） |
| LLM API 错误 | 指数退避重试 3 次（429/5xx），否则终止并输出已完成部分 |
| 连续 3 轮全部失败 | 提前结束，输出诊断 |

## 5. LLM Provider

统一接口：
```ts
interface LLMProvider {
  chat(messages: Message[], tools: ToolSchema[]): Promise<{ text: string; toolCalls: ToolCall[]; usage: Usage }>;
}
```
实现：
- `anthropic`：官方 `@anthropic-ai/sdk`，手写 tool-use 循环（作业要求自己实现 loop，因此不用 SDK 的 toolRunner）；
- `openai-compat`：兼容 DeepSeek / Qwen / Ollama 等 `/v1/chat/completions`；
- `mock`：基于规则的脚本化 LLM，用于无 API 条件下完成端到端验证与 CI。

通过环境变量选择：`LLM_PROVIDER=anthropic|openai|mock`。

## 6. 可选增强项（计划实现）

- [x] Tool Schema + 参数校验（ajv）
- [x] Workspace 沙箱（禁止越界读写）
- [x] Timeout / Retry
- [x] Agent Trace（JSON + Markdown）
- [x] Token Usage 统计
- [x] Context 压缩：旧的大 tool result 截断为摘要
- [x] Tool Permission：write_file 需 `--allow-write`（默认在 CLI 中打开）
- [ ] Plan / Sub Agent（视时间）

## 7. 测试 workspace 与任务

```
workspace/
├── README.md            # 含 TODO、文字说明
├── src/user.ts          # TODO + FIXME + 代码
├── src/order.ts         # FIXME + 数字
├── docs/design.md       # TODO + 引用了不存在的文件 docs/api.md
├── data/sales.txt       # 销售数据（含一行脏数据）
└── data/broken.bin      # 二进制文件，read_file 会失败
```

任务：
1. **搜索并汇总**：找出所有 TODO/FIXME，按文件分类生成 `todo-report.md`。
2. **读取 + 计算 + 报告**：读 `data/sales.txt`，求销售额之和，写入 `report.md`。
3. **多步 + 容错**：读取 `docs/design.md` 中提到的文件并核对是否存在，生成 `docs/check.md`（其中 `docs/api.md` 不存在，需处理失败）。

## 8. 当前实现最大限制

- 单线程、单 Agent，没有 planning / sub-agent；
- Context 压缩是粗粒度截断，长任务可能丢失细节；
- Mock LLM 仅覆盖固定任务，不能泛化；
- 依赖模型的 tool-call 质量，弱模型可能反复调用同一工具。
