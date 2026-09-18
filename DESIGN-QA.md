# 设计说明：七个必答问题

> 题目要求设计说明"至少回答"下面七个问题。本文按原题顺序逐条作答，每条给出**结论 → 代码位置 → 可验证的证据**。
> 需要展开的细节链接到 [DESIGN.md](./DESIGN.md)；扩展工具包的设计见 [DESIGN-EXTENSIONS.md](./DESIGN-EXTENSIONS.md)。

| 问题 | 一句话回答 | 详见 |
|---|---|---|
| 1. Agent Loop 如何设计 | 一个 `while (step < maxSteps)`：问模型 → 没有 tool call 就是答案 → 有就执行并把结果回灌 → 下一轮 | [§1](#1-agent-loop-如何设计) |
| 2. Tool 如何定义 | 一个接口五个必填字段，JSON Schema 既发给模型也用于校验；工具不知道 Agent 存在 | [§2](#2-tool-如何定义) |
| 3. 如何判断任务结束 | 模型返回不含 tool call 的消息即完成；另有五种非正常终止 | [§3](#3-如何判断任务结束) |
| 4. 如何避免无限调用 | 六层，从硬上限到死循环判定，每层管一种失控方式 | [§4](#4-如何避免无限调用) |
| 5. Tool 执行失败如何处理 | 失败是数据不是异常，一律回灌给模型；只有幂等工具遇到瞬时错误才自动重试 | [§5](#5-tool-执行失败如何处理) |
| 6. 四者职责如何划分 | Agent 管控制流、LLM 管决策、Tool 管能力、Context 管历史，互不越界 | [§6](#6-agentllmtoolcontext-如何划分职责) |
| 7. 最大的限制 | 框架能表达正确决策，但保证不了模型做出正确决策 | [§7](#7-当前实现最大的限制是什么) |

---

## 1. Agent Loop 如何设计

**结论**：主循环是一个有硬上限的 `while`，每轮做一次"问模型 → 执行工具 → 回灌结果"。循环本身不理解任务，只搬运。

代码：[`src/agent.ts`](./src/agent.ts) 的 `Agent.run()`。

```
step = 0
context.push(用户任务)
while step < maxSteps:
    step++
    ① 检查中止信号（AbortSignal）
    ② resp = llm.chat(系统提示, context.messages, 当前可见的工具 schema, onDelta)
    ③ 没有 tool call → 这就是最终答案，completed 退出
    ④ 有 tool call → assistant 消息入 Context
    ⑤ 执行这一轮全部调用：只读并行、写串行，结果按原顺序回填
    ⑥ 整组结果作为一条 tool 消息入 Context（可能触发压缩）
    ⑦ 更新失败计数、计算调用指纹、必要时注入提醒或终止
到顶 → max_steps 退出
```

几个不显然的设计选择：

- **一步 = 一次模型调用**，不是一次工具调用。一轮里模型可以发多个 tool call，它们共享同一个 step。这样 `maxSteps` 约束的是"模型思考了几次"，与成本直接对应。
- **只读并行、写串行**（[§4.7](./DESIGN.md)）。同一轮的只读调用用 `Promise.all` 并发，写工具等只读组完成后按顺序执行，避免同一轮内对同一文件的写入竞争。结果按原调用顺序回填，保证 `tool_use ↔ tool_result` 一一对应。
- **每轮的工具列表是动态的**。deferred 工具要被 `search_tools` 激活后才进入 schema；深度到顶的子 Agent 看不到 `delegate`。所以"有哪些工具可用"是循环的状态，不是常量。
- **事件是唯一的对外出口**。循环通过 `onEvent(AgentEvent)` 广播，CLI、Trace、Web SSE 三方订阅同一份事件流。循环不知道谁在听。

**证据**：任意一份 Trace 都能看到完整链路，例如 [examples/03](./examples/03-multi-step-with-failures/trace.md) 有 41 个链路节点，覆盖 `User → Decision → ToolCall → ToolResult → … → Final Answer`。

---

## 2. Tool 如何定义

**结论**：一个接口，五个必填字段加三个可选字段。同一份 JSON Schema 既发给模型当说明书，也用于运行时校验参数——两者不可能不一致。

```ts
interface Tool {
  name: string;
  description: string;                     // 模型看的说明书，写得好坏直接决定调用质量
  inputSchema: JSONSchema;                 // 既发给 LLM，也用于 ajv 校验
  permission: 'read' | 'write';            // write 类受 allowWrite 控制
  execute(input, ctx): Promise<ToolResult>;

  idempotent?: boolean;                    // 只有它为真，瞬时错误才会自动重试
  deferred?: boolean;                      // 默认不发给模型，需 search_tools 激活
  writeTargets?(input, ctx): string[];      // 写类工具声明会改哪些资源，用于并发冲突检查
}

type ToolResult = { ok: true; output: string } | { ok: false; error: string };
```

**注册与调用**：`ToolRegistry.register(tool)` 注册时用 ajv 预编译 validator；`schemas(activated)` 输出当前可见的工具；`execute(call, ctx, timeout)` 是一条固定流水线——查工具 → 字符串参数尝试 `JSON.parse` → schema 校验 → 权限 → 写冲突检查 → 带超时执行 → 瞬时错误且幂等则重试一次。**任何环节失败都返回 `{ok:false}`，从不抛异常**，所以工具不可能让循环崩溃。

**边界**：工具不知道 Agent 存在，也不知道别的工具存在。它只拿到 `ToolContext`（workspace 路径、是否允许写、中止信号）。三个 agent 级工具（`update_plan`、`search_tools`、`delegate`）是例外，它们通过 `ctx.runtime` 访问 Agent 能力，但这个接口只暴露五个方法，工具依然碰不到 Agent 内部。

**当前 26 个工具**：核心 5 个（`read_file` `write_file` `search_text` `calculator` `list_files`）、agent 级 3 个、deferred 3 个、扩展工具包 15 个（日志分析 5 + K8s 诊断 10）。22 个声明为幂等，2 个是写权限。

**这层抽象成立的检验**：两道扩展题（日志分析、K8s SRE）作为 15 个普通工具接进来，**没有改 Agent Loop 的任何一行**。K8s 要求的"修复前人工确认"直接用现成的 `permission: 'write'` 表达——`apply_fix` 是写工具，`--no-write` 就是只诊断不修复，不需要新机制。

---

## 3. 如何判断任务结束

**结论**：**模型返回一条不包含任何 tool call 的消息，就是任务结束**。这是唯一的正常终止条件，其余五种都是异常终止。

```ts
if (resp.toolCalls.length === 0) return finish(resp.text, 'completed');
```

为什么用这个信号：它和 tool-use 协议天然一致（`stop_reason` 从 `tool_use` 变成 `end_turn`），不需要模型输出什么特殊标记，也就不存在"模型忘了说结束"或"把结束标记写进正文"的问题。系统提示里配套写了"任务完成后给出简洁的最终答案，不要再调用工具"。

**六种终止原因**（`FinishReason`），全部会写进 Trace 与最终答案：

| reason | 触发条件 | 语义 |
|---|---|---|
| `completed` | 模型返回无 tool call 的消息 | 正常结束。**注意它不等于"做对了"**——模型判断"无法完成"并说明原因，也是 completed |
| `max_steps` | 轮数达到上限 | 没做完 |
| `too_many_failures` | 连续失败超阈值（见 §4） | 工具持续失败，放弃 |
| `stuck_loop` | 提醒后仍重复相同调用 | 判定死循环 |
| `llm_error` | 模型调用抛异常且非中止 | 外部故障 |
| `aborted` | 外部 `AbortSignal` | 用户中止（Ctrl+C / Web 中止 / 断连） |

CLI 用退出码区分：`completed` 返回 0，其余返回 2。

**一个诚实的说明**：`completed` 只表示"Agent 认为自己讲完了"。任务是否真正完成由校验决定——`scripts/run-examples.ts` 里每个用例都带断言，比对的是生成脚本写出的标准答案，不是"跑通即通过"。[examples/11](./examples/11-cannot-complete-missing-info/README.md) 就是一个 `completed` 但断言要求"必须没有生成文件"的用例。

---

## 4. 如何避免无限调用

**结论**：六层防护，每层管一种失控方式，互相独立、彼此兜底。没有任何一层是"万能"的，但最后一层一定生效。

| # | 机制 | 默认值 | 管什么 |
|---|---|---|---|
| 1 | **轮数硬上限** `maxSteps` | 15（子 Agent 8） | 最终兜底。其他检测全失效时它一定生效 |
| 2 | **重复调用检测** | 连续 3 轮指纹相同 → 提醒一次；提醒后再重复 2 轮 → `stuck_loop` | 原地打转。用 sha1 指纹而非原始字符串比较，避免在内存里留大段参数文本 |
| 3 | **持续失败阈值** | ①连续 3 轮"失败数 ≥ 成功数"；②连续 **2 轮以上**一个都没成功且累计失败调用 ≥ 6 | 工具一直失败却不换策略 |
| 4 | **单次工具超时** | 10 秒（`delegate` 按子 Agent 轮数放大） | 单个工具卡死 |
| 5 | **重试上限** | 最多 1 次，且仅限幂等工具 + 瞬时错误 | 重试本身变成循环 |
| 6 | **嵌套深度** `maxDepth` | 1 | 子 Agent 递归。双保险：runtime 判断深度拒绝，同时到顶的 Agent 工具列表里根本没有 `delegate` |

**两个细节值得说明，都是被真实运行逼出来的**：

- **重复检测为什么是"先提醒后终止"而不是直接终止**：模型有时确实需要重读同一个文件。所以第一次判定只注入一条 system 提醒要求换策略；只有提醒后仍然重复，才判死。记录了"已经针对哪个指纹提醒过"，所以不会反复注入同样的提示。[examples/09](./examples/09-stuck-loop-detection/README.md) 演示一个固执模型轮询永不就绪的锁文件，5 步被终止而不是耗满 15 步。
- **调用级失败阈值为什么必须跨轮**：真实模型（gpt-4o-mini）曾在一轮里并发发出 8 个 `list_files` 去查文件路径（用错工具），全部失败。原规则只看累计失败调用数，一轮就把任务判死，**模型连看一眼错误再改正的机会都没有**。一轮发错一批的代价应该是一轮，不是整个任务。改成必须连续 2 轮以上一个都没成功之后，同一个模型 10 步跑完了那个任务。这个 bug Mock 测不出来——Mock 不会犯"用错工具"这种错。

**没做的**：没有总 token 预算或总耗时预算（当前只统计不截断）；一轮内的 tool call 数量没有上限；重复检测只匹配完全相同，参数微调的伪重复识别不出来。

---

## 5. Tool 执行失败如何处理

**结论**：**失败是数据，不是异常**。所有失败都包装成 `{ok:false, error}` 回灌给模型，由模型决定下一步；框架只在"确实没救了"的时候才终止。

`ToolRegistry.execute()` 从不抛异常，六类失败各有明确处理：

| 失败类型 | 处理 | 是否重试 |
|---|---|---|
| 未知工具 | 返回错误并附上可用工具列表 | 否 |
| 参数不是合法 JSON | 返回错误并附上原文前 200 字符 | 否 |
| schema 校验失败 | 返回错误并**指明是哪个字段哪里不对**（ajv 的 errors） | 否 |
| 权限不足 | 明确说"需要写权限，当前未授权" | 否 |
| 写目标冲突 | 说明被哪个任务占用，建议改路径 | 否 |
| 执行异常 / 超时 | 捕获后返回错误 | **仅当工具幂等且错误为瞬时错误** |

**重试边界是刻意收窄的**：只有 `idempotent: true` 的工具、且错误匹配瞬时错误特征（timeout、EBUSY、EAGAIN、EMFILE、ETIMEDOUT、ECONNRESET）时才自动重试一次。文件不存在、路径越界、二进制文件、参数错误这类**确定性错误一律不重试**——重试必然得到同样的结果，只会浪费一轮。

**为什么把失败回灌给模型而不是框架自己处理**：框架不知道这次失败意味着什么。`read_file` 失败可能是路径写错（该换路径）、可能是文件不存在（该换策略）、也可能是二进制文件（该跳过）。只有模型知道当前任务的语义。框架能做的是把错误信息写清楚，让模型有足够信息判断。

**实际效果**（都有对应用例）：

- [examples/03](./examples/03-multi-step-with-failures/README.md)：核对文档引用的文件，遇到"不存在"和"二进制"两次失败后**修订计划**继续，最终产出完整核对表。
- [examples/08](./examples/08-huge-log-search-fallback/README.md)：`read_file` 超过 200KB 上限失败 → 改用 `search_text`；搜索结果又被截断 → 改为分类型并行搜索。两级降级都由模型自己完成。
- [examples/14](./examples/14-log-file-missing/README.md)：文件不存在 → `list_files` 确认 → 明确终止而不是硬编一份报告。
- 真实模型：gpt-4o-mini 在任务 03 里用 `list_files` 查文件路径连错 8 次，拿到"不是目录"的错误后下一轮改用 `read_file` 并跑完。

**LLM 侧的失败**单独处理：429 / 529 / 5xx 指数退避重试 3 次，其余直接以 `llm_error` 终止并保留已完成的部分。

---

## 6. Agent、LLM、Tool、Context 如何划分职责

**结论**：按"谁知道什么"划分。每一层只知道自己该知道的，跨层信息靠明确的接口传递，不靠共享状态。

| 模块 | 知道什么 / 负责什么 | **不负责** |
|---|---|---|
| **Agent**<br>`src/agent.ts` | 控制流：轮数、终止判定、失败阈值、重复检测、并发编排、中止、事件广播、子 Agent 派生 | 不理解业务语义；不直接读写文件；不知道具体是哪个模型 |
| **LLM Provider**<br>`src/llm/*` | 协议转换：把统一的 `Message[]` + `ToolSchema[]` 转成某家 API 的请求，把响应转回统一的 `{text, toolCalls, usage}` | 不执行工具；不管理历史；不做重试之外的任何决策 |
| **Tool**<br>`src/tools/*` | 单一能力：声明 schema、校验输入、沙箱检查、执行并返回结构化结果 | 不知道 Agent 存在；不知道别的工具存在；不决定何时被调用 |
| **Context**<br>`src/context.ts` | 消息历史：追加、估算大小、超阈值时压缩旧的 tool result | 不做任何决策；不知道 Provider 存在 |

**边界是怎么保证的**，三个具体例子：

1. **Agent 不知道模型是谁**。它只调 `llm.chat(system, messages, tools, onDelta, signal)`。所以同一套循环能跑 Anthropic 协议（含 5 家厂商预设）、OpenAI 兼容云端、Ollama、vLLM、以及规则驱动的 Mock，切换只改一个命令行参数。
2. **Context 不知道 Provider 是谁**。它维护的是内部消息格式（`user` / `assistant` / `tool` / `system` 四种角色），各 Provider 自己转换。这就是为什么"运行中注入系统提示"能同时工作——OpenAI 兼容接口直接映射为对话中的 `system` 消息，Anthropic 没有这个角色，映射成带 `<system_notice>` 标记的 user 消息。Context 对此一无所知。
3. **压缩不会破坏协议**。Context 压缩时**只截断 tool result 的正文**，绝不删除消息、不动 tool_call 结构，所以 `tool_use ↔ tool_result` 的配对始终完整。而且用的是不可变更新（生成新对象替换旧的），Provider 即使缓存了转换结果也不会失同步。

**唯一一处刻意打破的边界**：三个 agent 级工具需要 Agent 的能力（改计划、激活工具、派生子 Agent）。做法是 Agent 在每次 `run()` 时构造一个 `AgentRuntime` 对象放进 `ToolContext`，只暴露五个方法。工具调 `ctx.runtime.delegate(...)`，依然不知道 Agent 内部长什么样。

**职责划分带来的实际好处**：日志分析和 K8s 诊断两个工具包（15 个工具）接进来时，Loop、Trace、权限、沙箱、失败处理、Plan、子 Agent 全部复用，一行都没改。

---

## 7. 当前实现最大的限制是什么

**结论：框架能表达正确的决策，但保证不了模型做出正确的决策。** 这是接上真实模型之后才看清的，也是这个项目最有价值的一条发现。

具体案例：任务"把 `data/sales.txt` 的销售额换算成美元"，而 workspace 里**没有任何汇率**。

- Mock 的剧本是：搜索确认 → 找不到 → 明确拒绝、不生成报告（[examples/11](./examples/11-cannot-complete-missing-info/README.md)）。
- 真实模型第一次跑：`gpt-4o-mini` 和 `claude-haiku-4.5` **都编了一个汇率**并把报告写了出来，**都没搜过**。
- 于是往系统提示加了一条领域无关的规则（数值必须有来源，找不到就停下说明缺什么），做 A/B：
  - `claude-haiku-4.5` **被修好了**——它改为先 `search_text` 找汇率、找不到才拒绝。
  - `gpt-4o-mini` **完全没变**——前后都是 `read_file → calculator → write_file`，从不搜索。

**关键在工具调用序列**：haiku 改提示后多了一次搜索。gpt-4o-mini 不是"读了规则却违反"，是**压根没意识到"缺一个前提"这件事发生了**。给一条"发现缺前提时该怎么办"的规则，对一个从不进行这项检测的模型没有附着点。

由此得到一条对写系统提示有直接用处的一般结论：**"当你发现 X 时，做 Y"这类条件规则，只在模型具备"发现 X"的能力时才有效**。无条件规则（"算数一律用 calculator"）弱模型也照做；依赖自我评估的条件规则（"不确定就停下"）在弱模型上等于没写。规则 3 和规则 7 的效果差异就是这条的实证。

**这条缺口被归类为模型能力边界，本项目刻意不再往下补**。框架侧该给的都给了：搜索工具在、拒绝路径通、规则写明、有能力的模型照做。继续补的三条路都不适合这个 demo——写入时数值溯源检查的代价不在 CPU 而在误报换来的模型往返；RAG 去真查汇率超出"受限 workspace 内的 Agent"这个设定；把领域规程写成 Skills 等于把判断硬编码进流程，能解决汇率，解决不了下一个没预料到的缺失前提。

**折中方案**：把同样的检查做成**离线 Trace 审计**（`pnpm audit`）。它跑在任务之后，对运行性能零影响、不会误伤，只报告不拦截，回答的是"这次运行的结论可不可信"。33 份 Trace 报出 9 个无来源数值，其中 2 个是真实编造、5 个是模型未经 calculator 的口算、2 个是已知误报。

### 其余限制（按影响排序）

1. **Ollama / vLLM 通路从未真实验证**——本机性能不足，只有 `pnpm check-schema` 的协议层保证。
2. **Mock LLM 不泛化**——按任务关键词分派的规则脚本，能证明机制正确，不能证明模型判断力。
3. **Context 压缩粗粒度**，且这是刻意取舍：字符数近似 token、简单截断、无语义判断。要做好得上 embedding 或精确 token 预算，两者都在"上下文已经很大、请求已经很慢"的时刻再加一次远程调用。
4. **子 Agent 深度固定为 1**，无结果合并策略；"该不该分"只做了 `expected_steps` 事前门槛。
5. **Tool Search 是关键词打分 + 目录回退**，不是语义检索；工具上百个时回退成本会变高。
6. **无持久化、无鉴权**——任务中断不能恢复；写冲突由预约机制拦截，但这是协作式的不是隔离；Web 端没有鉴权，`/api/models` 是个按用户输入地址发请求的代理，只适合本地演示。
7. **计划由模型自觉维护**——框架不校验计划与实际行为是否一致。实测 8 次运行只有 3 次照做"多步任务先制定计划"。
8. **扩展工具包的数据是 Mock 的**——K8s 没有真实集群（数据源已抽象为 `ClusterSource`，接真实集群换实现即可，但换完好不好用未验证）。
9. **工具数量增长后 Tool Search 的取舍会失效**——现在 26 个工具除 3 个 deferred 外全部常驻 schema，每轮 prompt 里工具定义已占可观篇幅。
