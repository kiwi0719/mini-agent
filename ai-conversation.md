# 与 AI Coding 工具的对话过程

工具：Claude Code（Claude Fable 5.1），Claude 桌面应用 Code 标签页。以下按时间顺序整理本次考试期间的主要对话，候选人的消息原文保留，AI 的回复与操作做了摘要（完整代码见 git 历史）。

---

## 1. 需求 + 启动指令

**候选人**：（粘贴完整题目：实现 Mini Agent，至少 read_file / write_file / search_text / calculator 四个工具，基础功能 10 条，可选增强项列表，交付物 9 项）
> 先设计方案 然后连上github库 创建一个public的

**AI**：
- 检查环境：目录为空、`gh` 已登录（kiwi0719）、Node 24、Python 3.14、无 ollama；环境里有 `ANTHROPIC_BASE_URL/ANTHROPIC_AUTH_TOKEN`。
- 用 curl 测试该 token → `authentication_error: API key is invalid`。如实告知。
- 加载 Claude API 技能文档确认 tool-use 协议现状。
- 写出 DESIGN.md 初稿：分层（Agent / LLM Provider / Tool Registry / Context / Trace）、Loop 伪代码、结束判定、防无限循环三层、Tool 接口、失败处理表、三种 Provider（anthropic / openai-compat / mock）、测试 workspace 结构、三个任务、当前限制。
- `git init` → `gh repo create mini-agent --public` → 推送。
- 回复中给出方案要点，并说明 key 无效、计划先用 Mock 跑通。

## 2. 加前端

**候选人**：
> 有个简易前端吧

**AI**：在 DESIGN.md 加 §6.5：Node 内置 http + SSE 推送 Agent 事件，原生 HTML/JS 单文件；Agent 通过 `onEvent` 回调向 CLI / Trace / SSE 三方广播。随后开始写代码（package.json、tsconfig、types、registry、fs-tools、calculator）。
- 中途发现 `npm: command not found`，改用 pnpm。

## 3. 改用 Vue

**候选人**（AI 正在写代码时插话）：
> 不对 用vue吧

**AI**：改为 Vue 3 via CDN，单文件免构建，仍由 Node 服务托管。继续写 LLM Provider、Context、Trace、Agent、CLI。

## 4. 重试边界

**候选人**：
> Tool 失败重试的边界要更明确。方案里自动重试 1 次是对的，但对于文件不存在这类确定性错误重试没有意义，只会浪费一轮。

**AI**：同意。在 `registry.ts` 增加 `isTransientError()`（timeout / EBUSY / EAGAIN / EMFILE / ETIMEDOUT / ECONNRESET），只有幂等工具 + 瞬时错误才重试 1 次，其余直接回传模型；更新 DESIGN §4 失败处理表。
- 同时修掉 `tsc` 报的 TS1294（Node 原生跑 TS 要求 erasableSyntaxOnly，不能用构造函数参数属性）。

## 5. 一组设计批评

**候选人**：
> Context 压缩 没设计 重复调用检测应该比较哈希 search_text 要返回结构化文本 Trace 里补 durationMs 和每步的 usage repo 里建 ai-conversation.md 把我们这次对话 都写进去

**AI** 逐条处理：
1. DESIGN 新增 §4.5 Context 压缩：触发条件（字符数阈值）、只压 tool result、保留最近 2 条、截断 400 字符加标记、不删消息以保持 tool_use/tool_result 配对、局限。
2. 新增 §4.6：每轮 tool call 集合 → 规范化 JSON 排序 → sha1；连续 3 轮相同注入提示。代码从字符串比较改为 `callsHash()`。
3. `search_text` 改为返回 JSON `{total, truncated, files_scanned, matches:[{file,line,text}]}`；Mock 对应改为 JSON.parse。
4. `decision` 事件加 `durationMs`（LLM 耗时），Trace Markdown 渲染 `_LLM Xms · tokens in/out_`；tool_result 已有 durationMs。
5. 建立本文件。

随后写好测试 workspace（README / src/user.ts / src/order.ts / docs/design.md / data/sales.txt 含 N/A 脏行 / data/archive.bin 二进制），跑通任务 A（Mock）。

## 6. 全部增强项

**候选人**（贴出题目中的可选增强项完整列表）：
> 这些都要

**AI**：盘点已有（Schema、校验、Permission、失败回传、Retry、Timeout、Trace、Usage、压缩、沙箱），补齐 5 项：
- **Plan / 动态调整**：`update_plan` 工具，模型提交完整步骤列表 + `reason`；Agent 保存并广播 `plan` 事件；系统提示要求多步任务先制定计划、失败后修订。
- **Sub Agent**：`delegate` 工具，同进程 new 一个 Agent（独立 Context、更小 maxSteps、depth+1、maxDepth=1，子 Agent 工具列表去掉 delegate 防递归），token 计入父级，事件带 `agent/depth`。
- **Tool Search**：`Tool.deferred` + `search_tools`，命中后加入 `activated` 集合，下一轮进入 schema；新增 deferred 工具 `csv_parse / file_info / current_time`。
- **Streaming**：Provider 接口加 `onDelta`；Anthropic 用 `messages.stream()` + `finalMessage()`，OpenAI 兼容用 `stream:true` 手动解析 SSE 并拼接 tool_calls 片段；Agent 发 `delta` 事件；CLI `--stream`；Mock 分块模拟。
- 重写 Agent 核心（runtime 对象暴露给 agent 级工具）、重写 Mock（任务 A 用 delegate 逐文件、任务 B 用 search_tools→csv_parse、任务 C 在 docs/api.md 缺失后修订计划）、Trace 与 CLI 支持新事件与子 Agent 缩进。

**调试**：
- tsc 报 9 个 "step does not exist"：`Base & (A|B)` 再 `Omit` 把联合塌缩了 → 拆为 `AgentEventBody` 联合 + `Base &`。
- 首次运行任务 A：4 个子 Agent 全部 `文件不存在: README.md：读取它并列出其中所有`，Mock 用 `\S+` 抓文件名吞了全角冒号 → 改 `[\w\/.-]+`，并让父 Agent 在子结果为空时回退到搜索命中。
- 重跑三任务全部 completed；生成文件内容正确（销售额合计 9414.75，跳过 1 条脏数据；check.md 标出 docs/api.md 不存在与 archive.bin 二进制）。

**Web 前端**：写 `server.ts`（/、/api/info、/api/workspace、/api/file、/api/traces、POST /api/run SSE）与 `web/index.html`（Vue 3：左任务面板、中时间线含流式卡片与子 Agent 缩进、右统计/计划/文件/Trace）。
- 预览工具从上级目录启动导致相对路径失效 → 改为 `import.meta.dirname` 解析项目根。
- 在内置浏览器中点击示例任务 → 运行，看到实时时间线、Plan 全部 ✔、5 个子 Agent、tokens 统计、Final Answer 卡片，无 console 报错。

**留档**：`scripts/run-examples.ts` 重置 workspace、跑 5 个任务（3 个正向 + 2 个失败路径）、把 README / 生成文件 / trace.md / trace.json 写入 `examples/`；编写 README.md、AI_USAGE.md、更新 DESIGN.md（增强项表、§6.1–6.4、限制重写）；提交并推送。

## 7. 设计答辩：Sub Agent

**候选人**：
> subagent怎么设计的？

**AI**：解释 `delegate` 是普通工具、通过 `runtime.delegate()` new 一个同类 Agent（独立 Context、更小 maxSteps、depth+1、maxDepth=1、到顶的 Agent 工具列表里过滤掉 delegate 防递归）、事件带 agent/depth、token 计入父级、delegate 超时按 `toolTimeoutMs × subAgentMaxSteps × 3` 放大。同时主动列出取舍：串行执行、深度固定 1、无结果合并策略、子 Agent 权限未收窄。

**候选人**：
> 怎么设计上限的

**AI**：列出 8 层上限（maxSteps、连续失败阈值、重复调用哈希、工具超时、重试上限、嵌套深度、子 Agent 独立步数预算、资源类上限），并说明没做的：总 token/耗时预算、单轮 tool call 数量上限、参数微调的伪重复。

**候选人**：
> 怎么确定分的 不是每个任务都适合分sub吧

**AI**：承认"分不分"完全交给模型，框架只提供工具描述、成本结构与硬约束；坦言 examples/01 里 Mock 分出 4 个子 Agent 主要是演示机制，真实模型未必会这么做。给出三个可加的框架侧信号：delegate 前检查父级 Context 大小、按子 Agent 实际步数事后提醒、delegate 加 `expected_steps` 参数。

**候选人**：
> 这三个都是可行的解决方案 第二个可能稍差一点 不要应用

**AI**：不动代码。同意第二个最弱（事后才起作用，且"步数少"不等于"分得不合理"）。并记下偏好：以后先列方案，由候选人决定哪些落地。

## 8. 架构 Review（候选人要求 AI 自查）

**候选人**：
> 再给我讲下现在的详细架构 我看看有没有什么问题

**AI**：按入口层（CLI / Server / Web）→ Agent 核心 → Context → Tool 层 → LLM 层 → Trace 讲完数据流，然后自报 14 个问题：

1. Context 压缩直接改 tool result 字符串，与 Provider 的兼容靠约定
2. runtime 是闭包、状态是局部变量，Agent 没有可查询的当前状态
3. 父子 Agent 事件混在同一回调，Trace 线性交错
4. `addNotice` 用 user 角色注入系统提示，OpenAI 兼容接口本可用 system
5. 一轮内多个 tool call 串行执行
6. 连续失败按"整轮全失败"判定，夹一个必成功调用即可绕过
7. 重复检测只匹配完全相同，且提示会重复注入
8. 子 Agent 继承父级全部权限
9. calculator 运算符结合性未写进描述
10. Web 端无并发控制，多个请求同时写同一 workspace
11. SSE 客户端断开后 Agent 不中止
12. Context 大小按字符数估算，中英文 token 比例漂移
13. Tool Search 只是子串打分
14. Mock 的 collect() 每次全量扫描历史，O(n²)

**候选人**：
> 1-9都修复 然后10加排队和多线程吧 11 要及时中止  12不是很重要  14要把时间空间复杂度降下来 13我门讨论下解决方案

**AI**：1–9、14 改核心；10 做任务队列 + Worker 线程；11 做客户端断开即 abort；12 跳过；13 先讨论不动代码。

**候选人**（AI 修改中插话）：
> 然后有个很致命的问题 现在的用例太简单了

**AI**：修改 agent / context / registry / server / 各 provider / web，新增 `job-queue.ts`（任务排队）与 `worker.ts`（Worker 线程跑 Agent），重启服务并用并发请求测试排队、Worker 线程和中止行为。
- 首轮并发测试后修正若干问题，重启后队列能正确排空。
- 断开中止测试一度"不可判定"：Mock 半秒内跑完，客户端来不及断开。AI 加了 `MOCK_DELAY_MS` 开关让 Mock 变慢，再验证 abort。
- 针对"用例太简单"：新写 `scripts/gen-workspace.ts` 确定性生成更难的 workspace：多层目录与多种注释形式的 TODO/FIXME 及 `todoList`/`TODOS` 假阳性、多份格式不一致的数据文件（表头 / 货币符号 / 千分位 / 负数退款 / 脏行）、超过 read_file 上限的大日志（迫使改用 search_text）、接近上限的大 changelog（触发 Context 压缩）、文档互相引用与引用缺失文件、二进制文件、所需信息不在 workspace 内的任务（汇率，Agent 应判断无法完成）、永远不会就绪的锁文件（诱导死循环）。
- `run-examples.ts` 改为每个任务带自动 `verify` 断言（例如 TODO 报告条数须为 16 且不含 `todoList`/`TODOS` 假阳性、多区域合计 14495.25 且必须有一轮并行读取 3 个文件、大 changelog 必须触发 `compressed` 事件、错误计数须与生成脚本写出的 `.workspace-expected.json` 一致），新增 6 个示例：06 多区域聚合、07 大 changelog 压缩、08 大日志 search 回退、09 卡死循环检测、10 子 Agent 写权限、11 信息缺失无法完成。
- 首轮运行 4 个 verify 失败，AI 逐个对照 report 与 trace 判断问题出在 Mock、验证器还是 Agent。（进行中）

## 9. 第二个线程：把"日志分析"与"K8s SRE Agent"两题作为工具接入

**候选人**（新开线程，粘贴"应用运行日志智能分析"与"Kubernetes 故障诊断 SRE Agent"两道题）：
> 这两个能当工具加进来吗 分析下 记得存聊天记录 如果可以 就直接 帮我设计方案

**AI**：
- 先读现有项目（DESIGN.md、`registry.ts`、`types.ts`、deferred 工具写法、Mock LLM 结构、git 状态），确认扩展点：Tool 接口 + deferred/search_tools + permission + Trace + Web 时间线。
- 结论：两题都能作为 **工具包（tool pack）** 接入，不必另起项目。K8s 题要求的“Agent 自己决定查什么 / 保存诊断过程 / 展示工具调用与结果”正是现有 Loop + Trace + Web 已做的；日志题输入是 workspace 文件，走 read 权限与沙箱即可。
- 写出 `DESIGN-EXTENSIONS.md`：
  - 横切改动：按 pack 注册（`--pack` / `AGENT_PACKS`）、结构化最终答案 + 前端结果卡片、Mock LLM 新场景。
  - 日志包：流式容错解析器（ok / partial / malformed 三级）、5 个 deferred 只读工具（`log_stats` / `log_latency` / `log_trace` / `log_errors` / `log_timeline`）、报告模板、`scripts/gen-logs.ts` 的剧本占比设计。
  - K8s 包：`ClusterSource` 接口 + Mock 实现（fixture 目录按场景组织，可换真实 kubectl/Prometheus）、5 个必选工具、5 类故障 + 1 个"证据不足"场景的证据链表、诊断结论固定章节（故障现象 / 关键证据 / 已确认事实 / 可能原因含置信度 / 处理建议 / 证据不足说明）、加分项映射（runbook 检索、历史 case、propose_fix→apply_fix 走 write 权限人工确认、verify_fix、复盘报告、GPU Xid/NCCL 场景）。
  - 实施顺序与风险（仍无可用 key，端到端只能靠 Mock 演示）。
- 未写任何实现代码，等候选人挑选范围后再动手。
- 并提醒：ai-conversation.md 与 examples/ 正被另一个会话同时修改，提交前最好只保留一个会话在写仓库。

**候选人**：
> 做 不止是低成本的 不用工具包和开放注册 就那几个工具而已 然后我没有k8s先做 给我一个替代方案

**AI**：
- 推翻自己方案里的 `--pack` 开关设计：不做工具包，直接把这几个工具注册进现有 Registry。
- 加分项全做，只排除需要真实环境的 Prometheus / Loki / OpenTelemetry。
- 没有 K8s 的替代方案：`ClusterSource` 接口 + 读取 workspace 下 JSON fixture 的 Mock 实现；将来有 kind/minikube 时换成 kubectl 实现，工具代码不动。
- 实施顺序：日志工具 + 生成脚本 → Mock 集群 + K8s 工具 + 场景生成 → 注册 / 系统提示 → Mock LLM 剧本 → 前端结果卡片 → 示例与文档。
- 已写出 `src/tools/log-tools.ts`、`scripts/gen-logs.ts`、`src/tools/k8s-tools.ts` 与 `src/tools/k8s/`（ClusterSource + Mock），正在写场景生成器（集群 fixture、runbook、历史 case）与工具注册、系统提示模板。（进行中）

## 7. 追问 Sub Agent 设计

**候选人**：
> subagent怎么设计的？

**AI**：说明“复用 Agent 类、通过 delegate 工具暴露、runtime 闭包、独立 Context、深度双保险、事件带 agent/depth、超时放大”，并列出限制（串行、深度 1、无合并策略、权限未收窄）。

**候选人**：
> 怎么设计上限的

**AI**：分层说明 maxSteps / 连续失败 / 重复检测 / 工具超时 / 重试 / 深度 / 子 Agent 预算 / 资源上限，并指出没做的：总 token 预算、一轮内调用数上限、伪重复识别。

**候选人**：
> 怎么确定分的 不是每个任务都适合分sub吧

**AI**：承认“分不分”完全交给模型，框架只给约束；说明工具描述里的判断标准、成本结构、硬约束；坦白 examples/01 的分法主要是演示；提出三种让框架参与判断的方案。

**候选人**：
> 这三个都是可行的解决方案 第二个可能稍差一点 不要应用

**AI**：不动代码，记录该偏好。

## 8. 架构 review 与批量修复

**候选人**：
> 再给我讲下现在的详细架构 我看看有没有什么问题

**AI**：按入口层 / Agent 核心 / Context / Tool / LLM / Trace 讲完，自列 14 个问题：(1) 压缩原地改对象与 Provider 缓存失同步风险 (2) 状态只在闭包里不可查 (3) 子 Agent 事件与父级交错难分析 (4) 系统提示用 user 角色 (5) 一轮多调用串行 (6) 失败判定粒度整轮可绕过 (7) 重复提醒会反复注入 (8) 子 Agent 继承全部权限 (9) calculator 优先级未说明 (10) Web 无并发控制 (11) 断连不中止 (12) 字符数估 token 漂移 (13) Tool Search 子串打分 (14) mock collect O(n²)。

**候选人**：
> 1-9都修复 然后10加排队和多线程吧 11 要及时中止  12不是很重要  14要把时间空间复杂度降下来 13我门讨论下解决方案

**AI** 实施：
- 1：Context 改为不可变更新 + `compressed` 标记 + 增量维护大小 + `compressed` 事件。
- 2：`AgentState` + `getState()`。
- 3：事件带 `parent/parentCallId`，`Trace.toTree()`，Markdown 子 Agent 嵌套折叠。
- 4：内部 `system` 角色，Anthropic 映射为 `<system_notice>` user 消息，OpenAI 用原生 system。
- 5：一轮内只读并行 / 写串行，结果按原序回填。
- 6：轮级“失败 ≥ 成功”+ 单调用连续失败两条线。
- 7：只提醒一次，提醒后再重复 2 轮 → `stuck_loop`。
- 8：子 Agent 默认只读，`allow_write` 只能收窄。
- 9：calculator 描述写明优先级、右结合、% 为取余。
- 10：`job-queue.ts` + `worker.ts`，FIFO 队列、`AGENT_WORKERS` 并发、worker_threads。
- 11：`AbortSignal` 贯穿 Agent / LLM / 工具；CLI Ctrl+C；Web 中止按钮；断连中止；优雅 3 秒后硬杀。
- 14：mock 历史收集改为 WeakMap 增量缓存，每步 O(新增)。
- 13：未动。

调试中发现并修复：worker 不退出导致队列饿死（`parentPort.unref()`）；`req 'close'` 语义错误改 `res 'close'`；首次断连测试因 mock 太快而不可信，加 `MOCK_DELAY_MS` 复测。

**候选人**（修复进行中插话）：
> 然后有个很致命的问题 现在的用例太简单了

**AI**：写 `gen-workspace.ts` 生成带陷阱的 workspace；新增 6 个任务（多地区聚合、大文件压缩、超限日志、死循环、子 Agent 写权限、信息缺失），原任务 01 增加“假阳性后精化正则”；每个任务加自动校验。首轮 7/11 通过，逐个定位（假阳性正则、验证期望过期、输出文件名误取、search_text 不支持文件路径、中文字节数误判压缩阈值）后 11/11。

---

## 候选人对 AI 的指导方式小结

- 用短指令设定方向（设计先行、建仓、前端、Vue），不干预具体实现。
- 在 AI 产出设计后做针对性 review，指出的都是"机制是否合理"层面的问题（重试边界、压缩缺失、哈希比较、结构化输出、Trace 字段），而不是代码风格。
- 明确范围不许缩水（"这些都要"）。
- 要求过程可追溯（ai-conversation.md、AI_USAGE.md、examples）。
- 让 AI 自己先讲架构、自己列问题，再逐条裁决处理方式（修 / 换方案 / 跳过 / 只讨论），而不是逐行看代码。
- 对“测试是否有说服力”单独把关，而不只看功能是否实现。
