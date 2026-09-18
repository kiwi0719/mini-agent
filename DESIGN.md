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
                        ┌───────▼──┐  ┌─────▼──────────────┐ ┌───▼────────┐
                        │ LLM      │  │ Tool Registry      │ │ Context    │
                        │ Provider │  │ ┌────────────────┐ │ │ (messages, │
                        │ anthropic│  │ │核心 5 个        │ │ │ 压缩策略)  │
                        │ (+预设)  │  │ │read/write_file │ │ └────────────┘
                        │ openai / │  │ │search_text     │ │
                        │ local    │  │ │calculator      │ │
                        │ (flavor) │  │ │list_files      │ │
                        │ mock     │  │ ├────────────────┤ │
                        └──────────┘  │ │Agent 级 3 个    │ │
                                      │ │update_plan     │ │
                                      │ │search_tools    │ │
                                      │ │delegate        │ │
                                      │ ├────────────────┤ │
                                      │ │deferred 3 个    │ │
                                      │ │(Tool Search)   │ │
                                      │ ├────────────────┤ │
                                      │ │扩展工具包       │ │
                                      │ │log_* 5 个       │ │
                                      │ │K8s 10 个        │ │
                                      │ └────────────────┘ │
                                      └────────────────────┘
```

> 扩展工具包（应用日志智能分析、Kubernetes 故障诊断 SRE Agent）是两道扩展题，**作为普通工具注册进同一个 Registry**，不改 Agent Loop 的任何一行。设计与实现见 [DESIGN-EXTENSIONS.md](./DESIGN-EXTENSIONS.md)。

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
工具按来源分四类，**接口完全一致**，Agent 不区分：

| 类别 | 工具 | 说明 |
|---|---|---|
| 核心 5 个 | `read_file` `write_file` `search_text` `calculator` `list_files` | `search_text` 返回结构化 JSON `{total, truncated, files_scanned, matches:[{file,line,text}]}`；`calculator` 为递归下降求值，不用 eval |
| Agent 级 3 个 | `update_plan` `search_tools` `delegate` | 通过 `ToolContext.runtime` 访问 Agent 能力（见 §6.1–6.3） |
| deferred 3 个 | `csv_parse` `file_info` `current_time` | 默认不进 schema 列表，需 `search_tools` 激活 |
| 扩展工具包 15 个 | `log_*` 5 个、K8s 10 个 | 两道扩展题，见 [DESIGN-EXTENSIONS.md](./DESIGN-EXTENSIONS.md) |

**扩展工具包为什么不改 Agent**：它们只是多注册了一批 `Tool`，Loop、Trace、权限、沙箱、失败处理、Plan、子 Agent 全部复用。K8s 的"人工确认"用现成的 `permission: 'write'` 表达（`apply_fix` 是写工具，`--no-write` 即只诊断不修复），不需要新机制。这是"Tool 定义"这层抽象是否成立的实际检验。

## 4. 失败处理

| 失败类型 | 处理 |
|---|---|
| 参数不合法 | 立即返回错误说明给模型，不执行 |
| 文件不存在 / 越权路径 | 返回 `is_error` 结果，模型可改用 list_files/search_text 探索 |
| 工具抛异常 / 超时 | 捕获后返回错误。**重试边界**：仅当工具幂等（read 类）且错误为瞬时错误（timeout、EBUSY/EAGAIN/EMFILE 等）时自动重试 1 次；文件不存在、越界、二进制、参数错误等确定性错误一律不重试，直接回传模型 |
| LLM API 错误 | 指数退避重试 3 次（429/5xx），否则终止并输出已完成部分 |
| 持续失败 | 两条线：① 一轮内失败数 ≥ 成功数记为"失败轮"，连续 3 轮 → 终止；② 连续 **2 轮以上**一个都没成功、且累计失败调用 ≥ 6 → 提前终止。<br>②必须跨轮是真实模型逼出来的修正：gpt-4o-mini 曾在一轮里并发发出 8 个 `list_files` 去查文件（用错工具），原规则只看累计失败数，一轮就把任务判死，模型连看错误改正的机会都没有。**一轮发错一批的代价应该是一轮，不是整个任务**——改完它下一轮就改用 `read_file` 并跑完了（examples/real-model/openai-gpt-4o-mini--task-03） |
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

## 4.9 并发写冲突守卫

**问题**：队列允许多个任务并发（各自在独立 worker 线程），但它们共享同一个 workspace。两个任务写同名文件会互相覆盖，队列本身只限并发数、不做文件级隔离。

**做法**：事前预约，不做事后检测。

| 环节 | 行为 |
|---|---|
| 制定计划时 | `update_plan` 可带 `writes: string[]` 声明本次任务的全部输出路径，一次性预约。冲突在这里暴露——此时还没干活，改个文件名的代价最低，也不会跑到最后一步才失败 |
| 执行写工具前 | 声明了 `writeTargets` 的写工具在执行前 acquire 一次。已被自己预约过则直接通过 |
| 同一轮内 | 两个写调用指向同一目标时直接报错（锁按 owner 判定，自己不会拦自己）。后写静默覆盖先写几乎总是模型自相矛盾，让它合并成一次写入 |
| 任务结束 | 根 Agent 释放本 owner 的全部预约 |

**owner 的粒度**：`pid.threadId.序号.agentId`。子 Agent 继承父级 owner，所以同一任务树内不会自锁；不同任务之间才互斥。序号不能省——同一线程里并发跑两个根 Agent 时它们的 id 都是 `main`，只用 pid+threadId+id 会让两个无关任务互相认作自己人，冲突检查直接失效（这个 bug 是写完探针测试才发现的）。

**资源键是任意字符串**，不限于文件路径：`write_file` 用绝对路径，K8s 的 `apply_fix` 用 `k8s://<ns>/<name>`。因此非文件类的写操作也纳入同一套检查。

**取舍**：

- **为什么用锁文件而不是进程内 Map**：Web 端的并发任务跑在独立 worker 线程里，内存不共享。锁文件（`os.tmpdir()` 下，`wx` 标志原子创建）跨线程、跨进程都有效，实现二十行。进程内 Map 作为快路径，只有跨线程才落到文件系统。
- **性能**：只有写工具走这条路径，只读工具的并行完全不受影响。每次写 1-2 次 syscall，O(1)，没有轮询、没有定时器、没有后台线程。计划阶段的预约是一次性批量操作。
- **不做安全隔离**：这是协作式机制，不是权限边界。绕过它很容易（直接写文件就行）。它要防的是同一套工具的并发任务互踩，不是防恶意调用；权限边界由 `permission` + 沙箱负责。
- **残留锁**：进程崩溃会留下锁文件，靠 10 分钟的 stale 超时回收，不做心跳续约。代价是崩溃后最多十分钟内该文件不可写，换来实现上没有任何后台任务。

## 5. LLM Provider

统一接口：
```ts
interface LLMProvider {
  chat(messages: Message[], tools: ToolSchema[]): Promise<{ text: string; toolCalls: ToolCall[]; usage: Usage }>;
}
```
实现：
- `anthropic`：**不用官方 SDK**，直接 fetch `POST {base}/v1/messages`，因此同一个 Provider 覆盖官方、企业网关 / 中转、以及各厂商提供的 Anthropic 兼容端点（预设 `kimi` / `glm` / `deepseek` / `minimax` / `custom`，决定默认地址、模型、max_tokens 上限）。兼容性处理：① 鉴权 `x-api-key` 与 `Authorization: Bearer` 同时发（官方只看前者，部分网关只看后者；可分别来自 `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN`）；② baseUrl 归一化（域名 / `…/anthropic` / `…/v1` / `…/v1/messages` 都接受）；③ 按响应 `content-type` 决定 SSE 还是 JSON 解析，而不是相信自己发的 `stream` 字段（有的中转会改）；④ SSE 只看 `data:` 行，不依赖 `event:` 行；tool_use 的 input 既支持 `input_json_delta` 拼接也支持 start 里直接给全；缺 id 自动补；忽略 thinking 等未知块；usage 缺失容忍；⑤ 429 / 529 / 5xx 指数退避 3 次；⑥ 手写 tool-use 循环（作业要求自己实现 loop）。
- `openai` / `local`：同一个 `OpenAICompatProvider`，按 **flavor** 区分 `openai`（云端兼容接口）、`vllm`、`ollama`；
- `mock`：基于规则的脚本化 LLM，用于无 API 条件下完成端到端验证与 CI。

选择方式：`LLM_PROVIDER=anthropic|openai|local|mock`，CLI `-p/--flavor/--base-url/--model/--api-key`，或 Web 面板。

### 5.1 本地模型（Ollama / vLLM）的兼容设计

两者都提供 OpenAI 兼容的 `/v1/chat/completions`，因此不另写原生 Provider（Ollama 原生 `/api/chat` 的 `arguments` 是对象而非字符串、tool 结果回传格式也不同，多一套协议只会多一处出错）。差异收敛在 `buildRequestBody()`：

| 字段 | openai | vllm | ollama | 依据 |
|---|---|---|---|---|
| `tools[].type=function, function.{name,description,parameters}` | ✅ | ✅ | ✅ | 三方一致 |
| `tool_choice: "auto"` | ✅ | ✅ | **不发** | Ollama OpenAI 兼容文档把 `tool_choice`、`parallel_tool_calls` 列为不支持 |
| `stream` 默认 | true | true | **false** | Ollama 文档未确认 `/v1` 层流式 tool call；非流式最稳，可手动开 |
| `stream_options.include_usage` | ✅ | ✅ | **不发** | 非 OpenAI 标准扩展，Ollama 未列入支持 |
| `Authorization` | 必填 | 视 `--api-key` | 任意值 | Ollama "要求有 key 但忽略其值"，默认填 `ollama` |
| 默认地址 | api.openai.com/v1 | localhost:8000/v1 | localhost:11434/v1 | |
| 请求超时 | 300s | 300s | 300s | 本地小机器可能很慢 |

响应解析对两种形态都兼容：`arguments` 为 JSON 字符串（标准）或已是对象（个别实现）；流式按 `tool_calls[].index` 拼接片段；非流式直接取 `choices[0].message`。

**前端字段**：`provider=local` 时提交 `llm: { flavor, baseUrl, model, apiKey?, stream }`，服务端原样传给 worker → `createProvider('local', llm)`；空字符串视为未填，回落到 flavor 默认值。`GET /api/models?baseUrl=` 由服务端代理 `{baseUrl}/models` 拉模型列表，绕开浏览器 CORS（仅限本地演示，它是一个按用户输入地址发请求的代理）。

**vLLM 的前提**：服务端必须以 `--enable-auto-tool-choice --tool-call-parser <parser>` 启动（hermes / llama3_json / qwen3_xml / mistral … 按模型选），否则模型只会输出文本、永远不产生 tool call，Agent 会在第一步就以"最终答案"结束。这一点在 UI 上有提示。

**验证方式**：开发机没有能跑本地模型的性能，因此没有做真实联调。`scripts/check-request-schema.ts` 用真实的工具注册表和一段覆盖全部角色（user / assistant+tool_calls / tool 成功与失败 / system 注入）的历史，离线组装三种 flavor 的请求体并断言：每个工具 schema 在 Ajv strict 模式下可编译、名称满足 `^[a-zA-Z0-9_-]{1,64}$`、`parameters.type=object`、`tool_choice` / `stream_options` 按 flavor 有无、`arguments` 是 JSON 字符串、tool 消息紧跟 assistant 且 `tool_call_id` 一一对应、序列化后无 `undefined`。这能保证"schema 不传错"，但不能保证某个具体本地模型的 tool-call 质量。

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

**派生门槛（`expected_steps`）**：`delegate` 必须给出预计步数，低于 `delegateMinExpectedSteps`（默认 2）直接拒绝，错误信息告诉模型"自己直接调工具更快"。理由是派生一个子 Agent 至少多两次模型调用（子 Agent 自己决策 + 收尾），预计 1 步能做完的事派生纯属亏本。这是**事前拦截**：之前还讨论过"按子 Agent 实际步数事后提醒"的方案，但它只能在浪费发生之后才起作用，而且步数少不等于分得不合理——一个子任务一步完成也可能正是因为它被恰当地隔离了。examples/23 演示了被拒后改为自己调用工具的完整过程。

**权限只能收窄**：子 Agent 默认只读（`subAgentAllowWrite=false`）；父 Agent 可在 delegate 时传 `allow_write: true`，但最终权限是 `父.allowWrite && 请求值`，不能超过父级。examples/10 演示：首个子 Agent 写入被拒 → 报告需要写权限 → 父 Agent 修订计划、授予 `allow_write` 并行重派。

**父子关系可追溯**：子 Agent 的每个事件带 `parent`（父 Agent id）与 `parentCallId`（派生它的 delegate 调用 id）。`Trace.toTree()` 把线性事件流还原为树；Markdown 里子 Agent 的过程嵌套渲染在对应 delegate 调用之下的折叠块中，而不是与父级事件按时间交错。

**可查询状态**：`Agent.getState()` 返回当前 step、plan、已激活工具、usage、失败计数、结束原因的快照，不再只存在于闭包里。

### 6.3 Tool Search

Registry 中标记 `deferred: true` 的工具不进入默认 schema 列表，减少每轮 prompt 体积。`search_tools(query)` 分两级：

1. **关键词打分**：对名称/描述做子串匹配打分（名称命中 2 分、描述命中 1 分），有命中即激活并返回。
2. **目录回退**：没有任何命中时，返回全部未激活扩展工具的名称与一句描述，让模型自己挑，再用准确名称调用一次即激活。

**为什么是这个方案而不是 embedding / reranker**：正常的生产实现应该是给工具加 tags 做 BM25 之类的词法检索，或者用 embedding 做语义召回再 rerank。这里是 demo，扩展工具只有个位数，而 Anthropic 没有 embedding 接口，接 Voyage / OpenAI embedding 和 reranker 会引入额外的外部依赖、key 和延迟，收益远低于成本。目录回退在工具数量在几十个以内时既准（模型比任何打分都懂语义）又零依赖；代价是工具上百个时兜底一次会占较多 token，那时应换成方案 1 或 3。这是有意识的取舍，不是遗漏。

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

1. **真实模型已验证可用，但只覆盖两条通路**：经 OpenRouter 接入，OpenAI 协议（`openai/gpt-4o-mini`）与 Anthropic 协议（`anthropic/claude-haiku-4.5`）各跑了 4 个任务，全部 completed，记录在 [examples/real-model/](./examples/real-model/README.md)。**Ollama 与 vLLM 仍未真实验证**（本机性能不足），只有 `pnpm check-schema` 的协议层保证。另外测的两个都是便宜档模型，更强或更弱的模型表现会不同。
2. **框架能表达正确决策，但不能让模型做出正确决策**——这是真实模型暴露出的最重要一条：
   - **会编造缺失的前提**。任务"把销售额换算成美元"在 workspace 里没有任何汇率。Mock 的剧本是搜索确认后明确拒绝（examples/11），但两个真实模型都直接编了一个汇率（gpt-4o-mini 用 6.4~6.9，haiku 明写"使用汇率 1 USD = 7 CNY"）并把报告写了出来，**都没有用 search_text 找过汇率**。这说明 examples/11 证明的是"拒绝这条路径存在且框架支持"，不是"Agent 会拒绝"。要真正约束，得在工具层面强制（例如换算类任务要求先调用一个 `get_exchange_rate` 工具，拿不到就无法继续），而不是靠系统提示里的一句"无法完成就说明原因"。
   - **不稳定遵守流程约定**。系统提示要求多步任务先 `update_plan`，8 次运行里只有 3 次照做，同一个模型在不同任务上表现还不一致。框架不校验计划与实际行为是否一致（见第 8 条），所以这属于"提示能影响、但不能保证"的部分。
   - 做得好的部分：读文件、跳过脏数据（`N/A` 行两个模型都正确排除）、用 calculator 而不是心算、并行发多个只读调用、工具失败后改用别的工具重试、以及按文件分类汇总。examples/real-model 里每次运行的完整 Trace 都在。
3. **Mock LLM 不泛化**：它是按任务关键词分派的规则脚本。它能证明 Loop、工具、失败路径、各增强项的机制在这些场景下行为正确，但正如上一条所示，它演示的"理想决策"不等于真实模型的决策。
4. **Context 压缩粗粒度，且这是刻意的取舍**：现在是"字符数近似 token + 保留最近 2 条 + 其余截断到 400 字符"。三个已知不准的地方：字符数不等于 token 数（中文一个字符约 1-2 token，阈值会随语言漂移）、截断可能砍掉后半段关键信息、没有语义层面的取舍。
   **为什么不优化**：能真正做好的两条路都要付出性能代价。① **上 embedding 做语义压缩**（把旧 tool result 向量化，按与当前任务的相关性保留）——每次压缩都要额外的 embedding 调用，引入外部依赖与网络往返，而压缩恰恰发生在上下文已经很大、请求已经很慢的时候，等于在最坏的时刻再加一次远程调用；Anthropic 也没有 embedding 接口，还要再接一家。② **精确 token 预算**（用 `count_tokens` 或本地 tokenizer 算准）——每轮都要多一次 API 调用或引入 tokenizer 依赖并在每条消息上跑，而它换来的只是阈值更准，压缩策略本身并不会变聪明。
   当前方案的实际表现：examples/07 读入 151KB changelog 后触发压缩，节省约 65k 字符，任务正常完成。对这个规模的 demo，粗粒度截断够用；真要处理长会话，应该先做的是"让 read 类工具幂等、丢了就重读"（已实现），而不是把压缩做精。
5. **子 Agent 深度固定为 1**，没有结果合并策略（同一轮的多个 delegate 已并行）。框架对"该不该分"只做了最轻的一层干预：`expected_steps` 事前门槛（见 §6.2）。另外两个讨论过的方案没做——"按父级上下文大小提示"需要在每次 delegate 前估算上下文收益，判断依据比门槛弱；"按子 Agent 实际步数事后提醒"只能在浪费发生后才起作用。更进一步的判断（这个子任务是否真的独立、要不要并行）仍然完全交给模型。
6. **Tool Search 是关键词打分 + 目录回退**而非语义检索（见 §6.3 的取舍说明），工具上百个时回退成本会变高。
7. **无持久化、无鉴权**：任务中断不能恢复，重跑要从头开始。多个任务共享同一个 workspace，写冲突由 §4.9 的预约机制拦截（冲突时报错让模型换路径），但这是协作式的，不是隔离——没有 per-task 的工作目录或 copy-on-write。Web 端也没有任何鉴权，`/api/models` 还是个按用户输入地址发请求的代理，只适合本地演示。
8. **计划由模型自觉维护**：框架不校验计划与实际行为是否一致，弱模型可能制定计划后不更新。
9. **扩展工具包的数据是 Mock 的**：K8s 侧没有真实集群，`get_pod` / `get_node` / `get_metrics` 等读的是 `scripts/gen-k8s.ts` 生成的快照（数据源已抽象为 `ClusterSource`，接真实集群换实现即可，但换完是否好用未经验证）；日志侧读的是生成的 `app.log`，真实日志的格式脏乱程度远高于此。
10. **工具数量增长后 Tool Search 的取舍会失效**：现在 26 个工具全部常驻 schema（除 3 个 deferred），每轮 prompt 里工具定义已占可观篇幅；若继续加工具包，应把扩展包整体改为 deferred 并做语义检索，而不是继续常驻。
