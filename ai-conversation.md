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

**提交**：commit `ae2f057` 推送。除第 13 条外全部处理完。

**第 13 条 Tool Search 语义化，AI 给出 4 个方向等候选人定**：(1) 工具加 `tags`，按 tags + 名称 + 描述做中文 bigram BM25，零依赖；(2) 无命中时把全部 deferred 工具名称与一句描述回给模型让它挑；(3) embedding 检索（需接 Voyage / OpenAI，外部依赖偏重）；(4) 分层目录，适合上百工具。AI 建议 1+2 组合，未动代码。

**候选人**：
> 正常来说是要1/3的但是 是demo 还是2吧 在md里说明 因为接reranker和embedding太麻烦了

**AI**：实现方案 2（commit `c231847`）：关键词未命中时返回全部未激活扩展工具目录（名称 + 一句描述），提示模型用准确名称再调一次即激活；探针测试 "表格数据处理" 未命中得到目录、再查 "csv_parse" 激活成功。DESIGN.md §6.3 写明取舍：生产应做 tags + BM25 或 embedding + reranker，demo 里工具个位数且 Anthropic 无 embedding 接口，外部依赖成本高于收益。

同时 AI 主动报告一个情况：探针测试的工具列表里出现了它没写的 `log_stats`、`get_pod`、`apply_fix` 等，查明是另一个 Claude 会话在同一仓库工作。两个后果：上一次提交用了 `git add -A`，把对方尚在编写的 `log-tools.ts`、`k8s-tools.ts` 等一并推上去了；`gen-workspace.ts` 原来整目录删除 workspace 再重建，`pnpm test` 每跑一次就清掉对方的 `workspace/logs` 与 `workspace/k8s`。AI 已把生成脚本改为只清理自己生成的子树，本次只暂存自己改的文件，并建议两边用 git worktree 或约定提交责任人，询问已推上去的对方文件是回退还是保留。

**候选人**：
> 不用你就commit你的就行

**AI**：只提交自己重新生成的 examples 轨迹（`4a4829c`），对方在工作区的修改不动。至此该线程原任务全部完成。

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

## 10. 实现：直接注册工具，全部加分项，Mock 集群替代真实 K8s

**候选人**：
> 做 不止是低成本的 不用工具包和开放注册 就那几个工具而已 然后我没有k8s先做 给我一个替代方案

**AI**：
- 理解为：全部实现；不做 pack/开关，15 个新工具直接进 `createDefaultRegistry`；加分项全做（Prometheus/Loki/OTel 除外，需要真实环境）；没有集群 → Mock 集群作为替代方案。
- 日志：`log-tools.ts`（流式容错解析，ok/partial/malformed 三级；5 个工具）、`gen-logs.ts`（1 万行，8 模块，6 种剧本按权重，10:08–10:11 集中投放 DB 故障）。冒烟测试后修了故障窗口越界、状态码被归一化两处。
- K8s：`k8s/cluster.ts`（`ClusterSource` 接口 + Mock，修复动作叠加到后续查询）、`k8s-tools.ts`（5 必选 + 5 加分）、`gen-k8s.ts`（4 节点 8 Pod：OOM / NotReady / 调度失败 / DiskPressure / 连接超时 / 证据不足 / GPU Xid+NCCL，每个场景带干扰项；5 份 runbook；6 个历史 Case）。系统提示加第 9/10 条与固定输出结构。
- Mock LLM 剧本放独立文件 `mock-scenarios.ts`，插到其他剧本之前（另一会话新增的任务 H 用 `/日志/` 匹配会截胡）。修了 3 个问题：GPU 场景没读 previous 日志、证据不足场景把弱相关 runbook 当证据、最后一步丢失 verify_fix 结果。
- Web：最终答案按 `## ` 分区渲染成诊断卡片，证据带来源标签；浏览器里跑 job-123 验证无报错。
- 示例 12–21 带自动校验，`pnpm test` 21/21 通过。
- 期间另一会话重建 workspace 清掉了 logs/ 与 k8s/，示例脚本改为 gen-workspace 后自动补生成。
- 文档：README（工具表、示例表、结构）、DESIGN-EXTENSIONS（改为"已实现"并记录与初稿差异）、AI_USAGE、本文件。

**候选人**：
> anthropic也别只兼容官方接口了 改吧  要兼容别的

**AI**：把 `anthropic.ts` 从依赖官方 SDK 改为直接 `fetch` `POST {base}/v1/messages`，并移除 `@anthropic-ai/sdk` 依赖，使其可指向官方、企业网关 / 中转，以及 Kimi、智谱 GLM、DeepSeek、MiniMax 等厂商的 Anthropic 兼容端点：
- 预设 `preset`（anthropic / kimi / glm / deepseek / minimax / custom），各带默认 baseUrl / model / maxTokens；custom 必须自填地址。
- 鉴权同时发 `x-api-key` 与 `Authorization: Bearer`（部分网关只认后者）；baseUrl 写到域名、`/anthropic` 或 `/v1` 都归一化到 `/v1/messages`。
- 流式解析容忍第三方常见偏差（tool_use.input 在 start 里已给全、partial_json 为空、缺 usage、多出 thinking 块、事件名缺失）；也支持 `stream:false` 直接解 JSON。
- Web 端加 Anthropic 面板：预设切换带出地址 / 模型 / max_tokens。dev server 是改动前启动的进程，预设下拉一度为空，重启后正常；进程里没有 key 时配置错误正确显示在时间线。类型检查通过，真实打一次官方接口验证错误透出。（收尾中：更新文档并重跑测试）

## 11. 本地模型兼容（Ollama / vLLM）

**候选人**：
> 本地模型 也要兼容所以前端加个选项 然后下面要有输入api baseurl 然后 要兼容ollama和vllm吧 字段你设计下 可以检索资料  别的不做了 然后也不用跑本地验证 我性能不够 确保schema不传错就行

**AI**：查阅 Ollama 与 vLLM 的 OpenAI 兼容接口后实现（commit `ea8ef0e`）：
- `OpenAICompatProvider` 加 `flavor`（openai | vllm | ollama）并按 flavor 设默认值；Ollama 不发 `tool_choice` / `stream_options`，默认非流式。
- 新 provider 类型 `local`；CLI 加 `--flavor / --base-url / --model / --api-key / --llm-stream`。
- Web 端加本地模型面板：flavor、base URL、model（可从 `/models` 拉取）、key、stream；server 加 `GET /api/models` 代理，LLM 配置透传给 worker。
- 按候选人要求不跑本地模型，改写 `scripts/check-request-schema.ts` 离线校验三种 flavor 的请求体与全部 26 个工具 schema，全部通过；浏览器里验证面板切换 flavor 自动填默认值、模型拉取失败时报错清晰、vLLM 提示显示。
- 只提交自己的文件，并把另一会话在 web/index.html 上的未提交修改恢复回工作区。

## 12. Anthropic Provider 兼容第三方

**候选人**：
> anthropic也别只兼容官方接口了 改吧  要兼容别的

**AI**：
- 读现有 `anthropic.ts`（官方 SDK `messages.stream()`）与 OpenAI 兼容层的 flavor 设计，决定对齐做法：去 SDK、fetch 直连、preset 表。
- 重写 `src/llm/anthropic.ts`：预设 anthropic / kimi / glm / deepseek / minimax / custom；双鉴权头；baseUrl 归一化；流式与非流式两条解析路径，按响应 content-type 选择；容忍第三方偏差；429/529/5xx 重试；`buildRequestBody` 纯函数便于离线校验。
- 接线：`createProvider` 透传 preset / authToken / maxTokens；CLI 新增 `--preset --auth-token --max-tokens` 并把配置错误改为友好退出；服务端 `/api/info` 返回预设表、`/api/models` 支持 Anthropic 格式（`/v1/models` + 双头）；Web 面板新增端点预设、地址、模型、Key、流式开关、max_tokens。
- 验证：假的 Anthropic 兼容服务覆盖 6 组用例全部通过；真实请求官方接口 401 正确透出；浏览器里预设切换带出默认值、缺 key 的错误显示在时间线。`pnpm remove @anthropic-ai/sdk`。
- 文档：README 用法、DESIGN §5 兼容性规则、AI_USAGE、本文件。
- 未验证：各厂商预设的默认地址与模型名按公开文档填写，没有对应 key 实测；拿到任一家的 key 跑 `pnpm agent -- -p anthropic --preset kimi --api-key sk-... "…"` 即可确认。

## 13. 交付物复核

**候选人**（重新粘贴完整题目与 9 项交付物要求）：
> 复核下哪没完成 包括新增的设计

**AI**：逐项对照题目复核后，收口并推送 `1a87094`，把另一线程的全部工作（日志工具包、K8s 工具包、无 SDK 的 Anthropic Provider、Mock 剧本、两个生成脚本）一并入库，消除远端与本地不一致——README 承诺的 21 个任务此前在远端并不存在。修掉四个问题：

1. 远端缺文件：另一线程的工作全部提交，无丢失。
2. Schema 校验从 3 种 OpenAI 口味扩到 9 种端点配置，新增 Anthropic 格式 6 个厂商预设的断言：顶层 `max_tokens` 必填、`system` 是独立字段而非 messages 角色、`tool_use.input` 必须是对象（与 OpenAI 的字符串相反）、`tool_result` 必须在 user 消息里且 id 配对、两种鉴权头互相兜底、baseUrl 六种写法归一化。写这段时抓到一个真问题：校验器会读取宿主机的 `ANTHROPIC_AUTH_TOKEN`，断言结果依赖环境 → 改为显式传值并补只给 Bearer 的反向用例。
3. DESIGN.md 与扩展脱节：架构图补四类工具，工具清单列明 26 个工具的来源与接口一致性，说明扩展工具包为何不需要改 Agent 任何一行（K8s 的人工确认直接用现成的 `permission: 'write'` 表达）；限制补两条（扩展包数据是 Mock、工具数量增长后 Tool Search 取舍会失效）。
4. AI_USAGE 把 schema 校验说成端到端验证 → 改为三档表格，区分端到端验证、仅协议层验证、Mock 数据下的端到端。

**独立验证**：从 GitHub 全新 clone，`pnpm install` → `pnpm typecheck` → `pnpm check-schema` → `pnpm test` 全部通过，21/21 用例校验通过；题目原句任务的 CLI 冒烟 6 步完成、16 处 TODO、排除假阳性。

**仍存在的最大限制**（DESIGN §8 第一条）：四条模型通路从未连过任何真实模型，开发机 key 无效、性能不足以跑本地模型，所有端到端结果来自 Mock；`check-schema` 只能保证字段不传错，不能保证 Agent 可用。

## 14. 写冲突预约、delegate 门槛、Context 取舍

**候选人**：
> 写同名文件会互相覆盖（队列只限并发数，不做文件级隔离）。 这个 让并行之前检查要操作目标文件吧 当然你要在plan的时候最好就预算好 尽量不影响性能  及安全就算了  context的要优化要上emedding或者加token预算 影响性能  把这个加到取舍里吧 然后delegate 加 expected_steps 门槛

三件事：写冲突改为事前预约（并在 plan 阶段就预算好写目标，尽量不影响性能；安全隔离不做）、Context 优化（embedding 或 token 预算）因影响性能只写进取舍不实现、`delegate` 加 `expected_steps` 门槛。

**AI**：
- 写守卫支持通用资源键而不只是文件路径，因为写工具有两个：`write_file`（文件路径）与 `apply_fix`（集群资源）。接到工具接口、Registry、Agent：owner 传递、`reserveWrites`、结束时释放，并在 `executeRound` 里补同一轮内两个写调用指向同一目标的检测（同 owner 不会被锁拦住）。
- Plan 侧让写类任务在计划里声明 `writes`，Mock 的 `delegate` 调用点补 `expected_steps`。
- 新增两个用例：并发写冲突、`expected_steps` 门槛拒绝。全套用例无回归。

**调试中抓到两个问题**：
1. 并发写冲突探针里"A 没有冲突"——两个根 Agent 在同一进程同一线程，默认 id 都是 `main`，`makeOwner` 生成了相同 owner，于是互相认作自己人。owner 必须按运行实例唯一。
2. 孪生任务跑同一个 Mock 剧本，两者赛跑抢占同一路径，门控没真正生效 → 改为由测试直接以另一个 owner 持有锁，确定性地模拟"另一个任务占用中"。

四种行为修正后全部正确，固化为正式用例并补进文档。（进行中）

## 12. 收口复核：对照题目逐项检查

**候选人**：
> 复核下哪没完成 包括新增的设计

**AI** 逐条对照题目，指出 6 处问题，其中最严重的是"推到远端的 HEAD 与本地不一致"：README 承诺 21 个任务，但生成它们的 Mock 剧本没提交，评审人 clone 下来会发现文档与实际不符。

**候选人**：
> 处理吧 都在你这个线程里处理 不要丢掉另一个线程的工作

**AI**：先做 20 秒哈希快照确认另一线程已停止写入，再读完它重写的 `anthropic.ts`（去掉官方 SDK 依赖、支持 5 家厂商的 Anthropic 兼容端点）确认完整，然后：
- 把它的全部工作（日志/K8s 工具包、Mock 剧本、两个生成脚本、Provider 重写）一并提交；
- 扩展 `check-request-schema.ts` 覆盖 6 个 Anthropic 预设，过程中发现校验器会读宿主机的 `ANTHROPIC_AUTH_TOKEN` 导致断言不可复现，改为显式传值；
- DESIGN 的架构图与工具表接上扩展包，限制一节改为直说"真实模型完全未验证"；
- AI_USAGE 的验证说明拆成"端到端 / 仅协议层 / Mock 数据"三档；
- 从 GitHub 全新 clone 独立验证：install → typecheck → check-schema → 21/21 全通过。

## 13. 写冲突、Context 取舍、delegate 门槛

**候选人**：
> 写同名文件会互相覆盖（队列只限并发数，不做文件级隔离）。这个 让并行之前检查要操作目标文件吧 当然你要在plan的时候最好就预算好 尽量不影响性能 及安全就算了 context的要优化要上emedding或者加token预算 影响性能 把这个加到取舍里吧 然后delegate 加 expected_steps 门槛

三件事，候选人把解法的形状也一并指定了：写冲突要**事前预算**（plan 阶段声明写目标）而不是运行时兜底，**不做安全隔离**，**不影响只读路径的性能**。

**AI** 实现：
- `write-guard.ts`：进程内 Map 快路径 + `os.tmpdir()` 下的锁文件（跨 worker 线程有效），资源键是任意字符串所以 `apply_fix` 改集群状态也能纳入同一套检查；
- `update_plan` 加 `writes` 声明，冲突在制定计划时就暴露；写工具执行前 acquire；同一轮内重复写同一目标直接报错；根 Agent 结束时释放；
- `delegate` 加必填 `expected_steps`，低于 2 直接拒绝并告诉模型"自己调工具更快"；
- Context 压缩保持不变，但把"为什么不上 embedding / 精确 token 预算"写进 DESIGN §8 第 3 条。

**调试**：先写探针脚本验证四种场景，抓到一个正式用例发现不了的 bug——owner 用 `pid+threadId+agentId`，但同一线程并发的两个根 Agent id 都是 `main`，两个无关任务互相认作自己人，冲突检查完全失效；加自增序号修复。新增的 22 号用例最初用第二个 Agent 跑同一剧本制造冲突，两者赛跑导致随机失败，改为测试直接以另一个 owner 持有锁。最终 23/23。

---

## 候选人对 AI 的指导方式小结

- 用短指令设定方向（设计先行、建仓、前端、Vue），不干预具体实现。
- 在 AI 产出设计后做针对性 review，指出的都是"机制是否合理"层面的问题（重试边界、压缩缺失、哈希比较、结构化输出、Trace 字段），而不是代码风格。
- 明确范围不许缩水（"这些都要"）。
- 要求过程可追溯（ai-conversation.md、AI_USAGE.md、examples）。
- 让 AI 自己先讲架构、自己列问题，再逐条裁决处理方式（修 / 换方案 / 跳过 / 只讨论），而不是逐行看代码。
- 对“测试是否有说服力”单独把关，而不只看功能是否实现。
- 在方案有多个可选实现时给出取舍判断而非让 AI 自选（Tool Search"正常要 1/3，但这是 demo，选 2 并在文档里说明"）。
- 主动限定不值得花的成本（不跑本地模型验证、Context 按字符数估算不重要），把精力留在机制正确性上。
- 交付前要求 AI 逐项对照题目复核，而不是相信 AI 的"做完了"。
- 并行开多个会话推进不同方向，并要求其中一个会话专门负责把全过程留档。
