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

---

## 候选人对 AI 的指导方式小结

- 用短指令设定方向（设计先行、建仓、前端、Vue），不干预具体实现。
- 在 AI 产出设计后做针对性 review，指出的都是"机制是否合理"层面的问题（重试边界、压缩缺失、哈希比较、结构化输出、Trace 字段），而不是代码风格。
- 明确范围不许缩水（"这些都要"）。
- 要求过程可追溯（ai-conversation.md、AI_USAGE.md、examples）。
