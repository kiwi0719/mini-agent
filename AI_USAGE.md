# AI_USAGE.md

本项目在 Claude Code（模型 Claude Fable 5.1）辅助下完成。完整对话见 [ai-conversation.md](./ai-conversation.md)。

## AI 参与了哪些环节

| 环节 | AI 做了什么 | 候选人做了什么 |
|---|---|---|
| 需求分析 | 阅读题目，梳理基础要求与增强项，提出分层架构 | 确认范围：要求**所有**可选增强项都实现，并加前端 |
| 架构设计 | 起草 DESIGN.md（Loop、Tool、失败处理、职责划分） | 逐条审阅，指出缺口（Context 压缩没设计、重试边界不清、重复检测方式、Trace 字段） |
| 实现 | 编写全部 TS 源码、Mock LLM、Web 前端、脚本 | 决定技术选型（Vue）、纠正方向 |
| 调试 | 运行示例、发现 Mock 子任务解析 bug 并修复；处理 TS `erasableSyntaxOnly` 报错 | 复核输出 |
| 测试 | 设计 workspace 材料与 5 个任务、编写 run-examples 脚本、在浏览器中实测 Web UI | 要求把对话与结果留档 |
| 文档 | README / DESIGN / AI_USAGE / examples | 审阅 |
| 仓库 | git init、创建公开 GitHub 仓库并推送 | 授权 |

## 哪些关键设计由候选人决定

1. **先设计再动手，设计文档先入库**：要求先出方案、连上 GitHub 建公开仓库，再实现。
2. **必须有前端，且用 Vue**：AI 最初计划纯 CLI；候选人先要求"简易前端"，AI 用原生 HTML 起草后，候选人改为 Vue。
3. **Tool 重试边界**：AI 最初写的是"幂等工具超时后重试一次"，候选人指出对于文件不存在这类确定性错误重试只浪费一轮，要求边界明确 → 实现 `isTransientError()` 分类，只有瞬时错误 + 幂等工具才重试。
4. **Context 压缩必须有独立设计**：AI 的初稿只在表格里一句话带过，候选人要求补设计 → DESIGN §4.5，明确触发条件、只压 tool result、保留最近 2 条、不破坏 tool_use/tool_result 配对。
5. **重复调用检测用哈希比较**：AI 初稿用原始字符串拼接比较；候选人要求比较哈希 → sha1 指纹，避免在内存中保留大段 write_file 内容。
6. **search_text 返回结构化文本**：AI 初稿返回 `file:line: text` 纯文本行；候选人要求结构化 → JSON `{total, truncated, files_scanned, matches}`，便于模型按文件分组。
7. **Trace 补 durationMs 与每步 usage**：候选人要求 → decision 事件加 LLM 耗时，tool_result 带执行耗时。
8. **全部可选增强项都要做**：Plan、Sub Agent、Streaming、Tool Search、动态调整计划最初被 AI 列为"视时间"，候选人要求全部实现。
9. **对话过程留档**：要求在 repo 内建 ai-conversation.md。

## AI 出现过哪些错误判断，如何发现与修正

| # | 错误 | 发现方式 | 修正 |
|---|---|---|---|
| 1 | 假设环境有 `npm`，直接调用失败 | 命令报 `command not found` | 检查 PATH 发现只有 pnpm，改用 pnpm |
| 2 | 用 TS 构造函数参数属性（`constructor(private x)`），与 Node 原生运行 TS 所需的 `erasableSyntaxOnly` 冲突 | `tsc --noEmit` 报 TS1294 | 改为显式字段赋值 |
| 3 | `AgentEvent` 类型用 `Base & (A \| B)` 后再 `Omit<...>`，导致联合类型被塌缩、字段不可见 | tsc 报 "step does not exist" ×9 | 拆成 `AgentEventBody` 联合 + `Base &`，emit 接收 Body |
| 4 | Mock 子任务用 `\S+` 抓文件名，把全角冒号吞进路径，子 Agent 全部 read_file 失败 | 运行示例看到 4 个子 Agent 都报 "文件不存在: README.md：读取它…" | 正则改为 `[\w\/.-]+`；父 Agent 增加子 Agent 输出为空时回退到搜索结果 |
| 5 | server.ts 用相对于 cwd 的路径找 `web/index.html` 与 workspace，在其他目录启动会 404 | 预览工具从上级目录启动 | 改为基于 `import.meta.dirname` 解析项目根 |
| 6 | 重试边界过宽（见上文候选人决策 3） | 候选人 review | 明确瞬时/确定性错误分类 |
| 7 | 初稿把 Plan / Sub Agent 标为"视时间"，低估了题目对增强项的期待 | 候选人要求全部实现 | 补齐 5 项 |
| 8 | 试图用环境里已有的 `ANTHROPIC_AUTH_TOKEN` 验证真实模型，返回 "API key is invalid" | curl 直接测试 | 如实告知用户，实现 Provider 但用 Mock 完成端到端验证，并把"真实模型未充分验证"写进限制 |

## 未验证 / 遗留

- Anthropic 与 OpenAI 兼容 Provider 按官方协议实现并通过类型检查，但因缺少可用 key 未在真实模型上跑通；拿到 key 后执行 `pnpm test anthropic` 或 `pnpm test openai` 即可复验并覆盖 examples/。
