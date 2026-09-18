# Mini Agent 设计说明

> 一个能够自主调用工具完成任务的最小化 AI Agent（TypeScript / Node.js，CLI）。

## 1. 总体架构

```
┌──────────────┐   task    ┌─────────────────────────────────────────┐
│ CLI / Web UI │──────────▶│               Agent Loop                │
│ cli.ts       │◀──events──│  while (step < maxSteps):               │
│ server.ts+SSE│           │    1. LLM.chat(context, toolSchemas)    │
└──────────────┘           │    2. 无 tool_call → Final Answer, 退出 │
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
| **Trace** (`src/trace.ts`) | 记录 User → Decision → ToolCall → ToolResult → … → Final；每步含 LLM 耗时、token usage，每个工具调用含 durationMs；输出 JSON + Markdown | |

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
2. 重复调用检测：对每轮 tool call 集合取 sha1 指纹，连续 3 轮相同则注入提示要求换策略（见 §4.6）；
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
- 基础工具：`read_file`、`write_file`、`search_text`（正则/关键字，支持 glob，返回结构化 JSON `{total, truncated, files_scanned, matches:[{file,line,text}]}`）、`calculator`（安全表达式求值，不用 eval）、`list_files`。

## 4. 失败处理

| 失败类型 | 处理 |
|---|---|
| 参数不合法 | 立即返回错误说明给模型，不执行 |
| 文件不存在 / 越权路径 | 返回 `is_error` 结果，模型可改用 list_files/search_text 探索 |
| 工具抛异常 / 超时 | 捕获后返回错误。**重试边界**：仅当工具幂等（read 类）且错误为瞬时错误（timeout、EBUSY/EAGAIN/EMFILE 等）时自动重试 1 次；文件不存在、越界、二进制、参数错误等确定性错误一律不重试，直接回传模型 |
| LLM API 错误 | 指数退避重试 3 次（429/5xx），否则终止并输出已完成部分 |
| 持续失败 | 两条线：一轮内失败数 ≥ 成功数记为“失败轮”，连续 3 轮 → 终止；或单个调用连续失败 6 次 → 终止（防止模型每轮夹一个必成功的调用绕过轮级判定） |
| 重复调用 | 连续 3 轮指纹相同 → 注入一次提示；提醒后再重复 2 轮 → 以 `stuck_loop` 终止（见 §4.6） |
| 外部中止 | `AbortSignal`：步与步之间检查，并传给 LLM 请求与工具；以 `aborted` 结束并保存 Trace |

## 4.5 Context 压缩

**目标**：长任务中防止历史无限膨胀，同时保证模型仍能基于最新信息决策，且不破坏 tool-use 协议结构。

| 项 | 设计 |
|---|---|
| 触发条件 | 每次追加 tool result 后估算上下文大小（`JSON.stringify(messages).length` 字符数，粗略近似 token），超过 `compressThresholdChars`（默认 60k 字符 ≈ 15-20k token）时触发 |
| 压缩对象 | **只压缩 tool result 的内容**。user 任务、assistant 的文字与 tool_call 结构一律不动，保证 `tool_use ↔ tool_result` 配对完整，API 不会报错 |
| 保留窗口 | 最近 2 条 tool 消息保持原文；更早的 tool result 若超过 400 字符则截断为前 400 字符 + `[已压缩，原始 N 字符]` 标记 |
| 不可变更新 | 压缩生成**新的** tool 消息对象替换旧的，绝不原地修改已交给 Provider 的对象；被压缩的条目带 `compressed: true` 标记。Provider 即使缓存了转换结果也不会失同步 |
| 可观测 | 触发时发 `compressed` 事件（节省字符数、当前大小），CLI / Trace / Web 均展示。examples/07 读入 151KB changelog 后触发，节省约 65k 字符 |
| 不做的事 | 不调用 LLM 做摘要（成本与不确定性）；不删除消息（避免破坏配对） |
| 局限 | 截断可能丢失后半段关键信息；模型如需可重新调用 read_file（这也是让 read 类工具幂等的原因） |

## 4.6 重复调用检测

对每一轮的全部 tool call 计算指纹：`(name, 规范化后的 input JSON)` 排序拼接后取 **sha1**。用哈希而非原始字符串比较，避免在内存中保留和比较大段参数文本（例如 write_file 的整篇内容）。

状态机：连续 3 轮指纹相同 → 注入**一次** `system` 消息提醒（记录已提醒的指纹，不重复注入）→ 若模型换了策略（指纹变化）则重置 → 若提醒后又连续 2 轮相同 → `stuck_loop` 终止。examples/09 演示了一个“固执”模型轮询锁文件被终止的完整过程（5 步结束，而不是耗满 15 步）。

## 4.7 一轮内多个调用的执行顺序

模型一轮可发出多个 tool call。执行分两组：**read 权限工具并行**（`Promise.all`，包含 delegate，因此多个子 Agent 天然并行）；**write 工具在只读组完成后串行**，避免同一轮内对同一文件的写入竞争。结果按原调用顺序回填，保证 `tool_use ↔ tool_result` 一一对应。examples/06 中一轮并行读取 3 个地区文件、一轮并行执行 4 个 calculator。

## 4.8 运行中系统提示

内部消息格式新增 `system` 角色，用于重复调用告警等运行中注入。OpenAI 兼容接口直接映射为对话中的 `system` 消息；Anthropic Messages API 没有对话中 system 角色，映射为带 `<system_notice>` 标记的 user 消息。Provider 各自选择最合适的表达，Agent 不关心。

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

## 6. 可选增强项（全部实现）

| 增强项 | 实现位置 | 说明 |
|---|---|---|
| Tool Schema | `Tool.inputSchema`（JSON Schema） | 同一份 schema 既发给 LLM，也用于校验 |
| Tool 参数校验 | `registry.ts` (ajv) | 字符串参数自动 JSON.parse；校验失败返回具体字段错误给模型 |
| Tool Permission | `Tool.permission: 'read' \| 'write'` | write 类工具受 `allowWrite` 控制（CLI `--no-write`，Web 勾选框） |
| 失败自动恢复 | Agent Loop | 失败以 `is_error` 回传，模型据此换路径 / list_files / 跳过脏数据（见 examples/03） |
| Retry | `registry.ts` | 仅幂等工具 + 瞬时错误重试 1 次；LLM 429/5xx 指数退避 3 次 |
| Timeout | `registry.ts withTimeout` | 默认 10s；delegate 按子 Agent 轮数放大 |
| Agent Trace | `trace.ts` | 每步 LLM 耗时 + usage，每个工具调用 durationMs，JSON + Markdown |
| Token Usage | `Usage` 累加 | 含子 Agent 消耗，CLI / Web / Trace 均展示 |
| Context Compression | `context.ts` | §4.5 |
| Plan | `update_plan` 工具 | 模型显式维护步骤列表，状态 pending/in_progress/done/blocked/skipped |
| 对执行计划动态调整 | `update_plan` 的 `reason` | 工具失败后重新提交计划（examples/03 中 docs/api.md 缺失 → 新增"汇总异常文件清单"步骤） |
| Sub Agent | `delegate` 工具 | 派生独立上下文的子 Agent（同一 registry、更小 maxSteps、maxDepth=1 防递归），事件带 `agent/depth` 标签 |
| Streaming | `LLMProvider.chat(..., onDelta)` | Anthropic 用 SDK stream，OpenAI 兼容用 SSE 解析；Agent 发 `delta` 事件，CLI `--stream`、Web 打字机效果 |
| 防止越界读取 | `sandbox.ts` | 所有路径 resolve 后必须在 workspace 前缀内，否则拒绝 |
| Tool Search | `Tool.deferred` + `search_tools` | 扩展工具默认不发给 LLM；搜索命中后激活，下一轮进入 schema 列表（examples/02 激活 `csv_parse`） |

### 6.1 Plan 与动态调整

计划是**模型自己维护的显式状态**而不是框架强加的流程：`update_plan` 每次提交完整列表，Agent 只负责保存与广播 `plan` 事件。系统提示要求"多步任务先制定计划；每完成一步或需要改变策略时修订"。失败时模型看到 `is_error` 结果，重新提交计划并给出 `reason`，这就是动态调整——不需要框架理解任务语义。

### 6.2 Sub Agent

`delegate(task, allow_write?)` 在同一进程内 new 一个 `Agent`，共享 LLM 与 ToolRegistry，但拥有独立 Context、更小的 `maxSteps`，且 `depth+1`。`maxDepth` 默认 1，子 Agent 的工具列表中不再包含 `delegate`，从结构上杜绝无限递归。子 Agent 的 token 计入父 Agent 总量；子 Agent 的最终答案作为 tool result 返回父 Agent。

**权限只能收窄**：子 Agent 默认只读（`subAgentAllowWrite=false`）；父 Agent 可在 delegate 时传 `allow_write: true`，但最终权限是 `父.allowWrite && 请求值`，不能超过父级。examples/10 演示：首个子 Agent 写入被拒 → 报告需要写权限 → 父 Agent 修订计划、授予 `allow_write` 并行重派。

**父子关系可追溯**：子 Agent 的每个事件带 `parent`（父 Agent id）与 `parentCallId`（派生它的 delegate 调用 id）。`Trace.toTree()` 把线性事件流还原为树；Markdown 里子 Agent 的过程嵌套渲染在对应 delegate 调用之下的折叠块中，而不是与父级事件按时间交错。

**可查询状态**：`Agent.getState()` 返回当前 step、plan、已激活工具、usage、失败计数、结束原因的快照，不再只存在于闭包里。

### 6.3 Tool Search

Registry 中标记 `deferred: true` 的工具不进入默认 schema 列表，减少每轮 prompt 体积。`search_tools(query)` 对名称/描述做关键词打分，命中后加入本次运行的 `activated` 集合，下一轮 `schemas(activated)` 即包含它们。

### 6.4 Streaming

Provider 接口增加可选 `onDelta`。Anthropic 用 `client.messages.stream()` 监听 `text` 事件并以 `finalMessage()` 拿完整消息（含 tool_use）；OpenAI 兼容接口开启 `stream: true` 手动拼接 `delta.content` 与 `tool_calls[].function.arguments` 片段。Agent 把增量作为 `delta` 事件广播，`decision` 事件到达时前端用完整消息替换流式卡片。

## 6.5 简易前端

- `pnpm web` 启动 `src/server.ts`（Node 内置 `http`，无框架）；
- `GET /` 返回 `web/index.html`（**Vue 3** via CDN，单文件，免构建）；
- `POST /api/run` 接收任务，以 **SSE** 流式推送 Agent 事件：`decision` / `tool_call` / `tool_result` / `final` / `usage`；
- 前端按时间线渲染事件卡片（子 Agent 事件缩进并标紫色），实时展示 Trace、当前 Plan、统计（步数/工具调用/失败/子 Agent/tokens）、workspace 文件浏览；流式文字有打字机效果；
- **队列与多线程**（`src/job-queue.ts`）：任务进入 FIFO 队列，最多 `AGENT_WORKERS`（默认 2）个同时运行，每个 Agent 跑在独立的 `worker_threads` 线程里，事件经 `parentPort` 回传主线程再转 SSE；排队中的任务实时收到位置变化；
- **及时中止**：前端“中止”按钮调用 `POST /api/jobs/:id/abort`；SSE 连接断开（关页面）由服务端 `res 'close'` 捕获后同样触发中止。排队中的任务直接移出队列；运行中的先发 abort 消息让 Agent 通过 `AbortSignal` 优雅停止并保存 `aborted` Trace，3 秒内未退出则 `worker.terminate()` 硬杀；
- `GET /api/jobs` 查看运行中 / 排队中的任务。
- Agent 核心通过 `onEvent` 回调向 CLI、Trace 文件、SSE 三方广播，前端不含任何业务逻辑。

## 7. 测试 workspace 与任务

workspace 由 `scripts/gen-workspace.ts` 确定性生成（`pnpm test` 会先重新生成），刻意包含以下“陷阱”：

| 材料 | 目的 |
|---|---|
| `src/**` 5 个 ts 文件、`config/app.yaml`、`docs/**` | `// TODO:`、`/* TODO */`、`# TODO:`、`TODO(alice):` 多种写法 |
| `todoList` 变量、“TODOS 统一在 issue 跟踪”、“不是 TODO 注释” | **假阳性**，宽松正则会误报 |
| `node_modules/fake-lib/index.js` 含 TODO | 搜索必须忽略 |
| `data/sales.txt` 含 `N/A` | 脏数据 |
| `data/regions/*.csv|txt` | 三种格式：带引号的 `"¥1,200.00"`、未加引号的千分位 `1,999.00`（破坏 CSV 列数）、点线对齐的手工文本、负数退款、“待确认” |
| `docs/changelog.md` 151KB | 低于 read_file 上限但读入后**触发 Context 压缩**；49 条 BREAKING 涉及已删除的文件 |
| `data/huge.log` 252KB | **超过 read_file 上限**，必须改用 search_text；ERROR 行 > 500 条，一次搜索会**截断** |
| `docs/design.md` 引用 `docs/api.md`（不存在）、`data/archive.bin`（二进制） | 失败处理 |
| `data/lock.txt` 永远 `PENDING` | 诱导死循环 |
| 无任何汇率信息 | 任务所需信息不在 workspace，应判断无法完成 |

11 个任务（`scripts/run-examples.ts`，每个带自动校验）：

| # | 任务 | 验证的机制 |
|---|---|---|
| 01 | 找出所有 TODO 按文件分类生成报告 | Plan；搜索结果含假阳性后**精化正则重搜**；只对源码文件并行派子 Agent |
| 02 | 读 sales.txt 求和写报告 | Tool Search 激活 csv_parse；脏数据；calculator |
| 03 | 核对 design.md 引用文件 | 2 次工具失败后**修订计划**继续 |
| 04 | 无写权限生成报告 | 权限拒绝 → 明确报告 |
| 05 | 读 `../../etc/passwd` | 沙箱拒绝 + 未知任务兜底 |
| 06 | 汇总 data/regions 三地区销售额 | **一轮并行读 3 文件**、格式归一、**一轮并行 4 个 calculator**，合计 14495.25 |
| 07 | 整理 changelog 的 BREAKING 并核对文件 | 大文件 → **Context 压缩触发**；并行核对 8 文件其中 2 缺失 |
| 08 | 统计 huge.log 每类 ERROR | read_file **超限** → search_text；结果**截断** → 改为分类型并行搜索；计数与生成器答案一致 |
| 09 | 等待 lock.txt 就绪 | 模拟固执模型：3 轮重复 → 提醒 → 再 2 轮 → **stuck_loop 终止** |
| 10 | 子 Agent 为每个源码文件生成摘要 | 子 Agent **默认只读写失败** → 父 Agent 授予 allow_write 并行重派 |
| 11 | 销售额换算美元 | 信息缺失 → 搜索确认 → **明确拒绝猜测、不生成报告** |

## 8. 当前实现最大限制

1. **真实模型未经充分验证**：开发环境中的 Anthropic key 无效，全部端到端结果来自 Mock LLM。11 个用例验证的是**框架机制**（并行、压缩、终止、权限、沙箱、Tool Search）在这些场景下行为正确，而不是模型的判断力。Anthropic / OpenAI 兼容 Provider 的协议转换按官方文档实现并通过类型检查，但真实模型的行为（是否主动用 update_plan、是否会在失败后换策略）取决于模型能力与 prompt，需要拿到 key 后跑 `pnpm test anthropic` 复验。
2. **Mock LLM 不泛化**：它是针对 3 类任务的规则脚本，只用于验证 Loop、工具、失败路径与各增强项的机制，不能证明"自主判断"能力。
3. **Context 压缩粗粒度**：字符数近似 token、简单截断，可能丢关键信息；没有 LLM 摘要。
4. **子 Agent 深度固定为 1**，没有结果合并策略（同一轮的多个 delegate 已并行）；框架不参与“该不该分”的判断（讨论过三种方案：按上下文大小提示、按子 Agent 实际步数事后提醒、delegate 加 expected_steps 门槛，均未实现）。
5. **Tool Search 是关键词打分**而非语义检索，工具数量大时召回不稳定。
6. **无持久化、无鉴权**：任务中断不能恢复；多个任务共享同一个 workspace，写同名文件会互相覆盖（队列只限并发数，不做文件级隔离）。
7. **计划由模型自觉维护**：框架不校验计划与实际行为是否一致，弱模型可能制定计划后不更新。
