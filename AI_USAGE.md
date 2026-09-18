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
10. **对 AI 列出的 14 个架构问题逐条裁决**：1–9 修复、10 改为队列+多线程、11 要及时中止、12 不重要跳过、14 降复杂度、13（Tool Search 语义化）先讨论不动代码。
11. **“子 Agent 该不该分”由模型判断**：AI 提出三种让框架参与判断的方案，候选人评估后决定都不应用（第二种最弱），保持范围。
12. **用例太简单是致命问题**：要求扩充测试材料与任务，覆盖机制边界而不只是 happy path。
10. **Sub Agent 切分策略不加框架侧判断**：AI 提出三种让框架参与"该不该 delegate"判断的方案，候选人评估后认为"按子 Agent 实际步数事后提醒"最弱，并决定三个都先不应用，保持"分不分"由模型判断。
11. **架构 Review 的取舍**：候选人要求 AI 自查架构并列出问题，AI 列出 14 条；候选人逐条裁决：1–9 修复，10 加任务排队与 Worker 多线程，11 客户端断开要及时中止 Agent，12（Context 按字符数估算）不重要跳过，14 降低 Mock 的时间空间复杂度，13（Tool Search 子串打分）先讨论方案不动代码。
12. **测试用例必须加难**：候选人指出现有 5 个示例任务"太简单"是致命问题，要求补更有挑战的用例。
13. **扩展方向**：候选人另开线程，要求评估把"应用日志智能分析"和"Kubernetes 故障诊断 SRE Agent"两道题作为工具接入 mini-agent，并要求保存该线程的聊天记录。AI 给出方案后候选人裁决：两题都做；加分项不只做低成本的，全做；**不要工具包 / `--pack` 开关**，直接注册那几个工具；没有 K8s 环境，要 AI 给替代方案（AI 采用 JSON fixture 的 Mock 集群 + `ClusterSource` 接口）。

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
| 9 | Worker 线程跑完任务后不退出（`parentPort.on('message')` 让事件循环常驻），并发槽位永不释放，排队任务饿死 | 并发测试：3 个任务、并发 2，第 3 个永远 queued | `parentPort.unref()` + 主线程收到 done 后延迟 terminate 兜底 |
| 10 | 用 `req.on('close')` 检测客户端断连；现代 Node 里它表示请求体接收完毕，不是 socket 断开，断连中止从未触发 | 断连测试后 `/api/jobs` 里任务仍在 | 改为 `res.on('close')` |
| 11 | 断连中止测试“通过”其实是因为 mock 太快在超时前跑完了，结论不成立 | 复核输出时发现 job 有完整 done 事件 | 给 mock 加 `MOCK_DELAY_MS`，在慢速下重测，确认 3 步就被中止 |
| 12 | 新用例的 mock 用宽松正则过滤 TODO，报告里混入 `todoList`、“不是 TODO 注释”；父级修了子 Agent 没修 | 自动校验断言“报告含假阳性”失败两次 | 父子两处都改为要求冒号或括号的严格正则 |
| 13 | mock 用“任务里第一个 .md”当输出文件名，任务 07 把报告写成 `changelog.md` 覆盖了输入 | 校验发现输出文件不存在 | 统一 `outName()`：优先匹配“写入/生成 X.md” |
| 14 | `search_text` 的 path 只接受目录，模型传文件路径就失败；mock 又对失败结果直接 JSON.parse 抛异常导致 `llm_error` | 任务 08 五个并行搜索全部 ❌ | 工具支持单文件 path；mock 对失败结果做防御 |
| 15 | 以为 151KB 的中文文件肯定超过 60k 字符阈值，压缩没触发（中文 3 字节/字符，71KB 只有 ~30k 字符） | 校验“未触发 Context 压缩” | 把 changelog 加大到 ~64k 字符；并把“字符数 ≠ 字节数 ≠ token 数”写进限制 |
| 16 | 首版 `Base & (A \| B)` 再 `Omit` 的事件类型让联合塌缩（见 #3）；重写 Agent 时又一次用了 TS 参数属性（见 #2） | tsc | 同样修法，说明这两个坑在 Node 原生 TS 环境下容易反复踩 |
| 9 | examples/01 用 4 个子 Agent 逐文件读 TODO，实际 search_text 结果已足够，分 sub 只是为了演示机制 | 候选人追问"怎么确定分的"，AI 自查后承认 | 写入限制说明；框架侧判断方案由候选人决定暂不应用 |
| 10 | 连续失败阈值按"整轮全失败"判定，夹一个必成功调用即可绕过；重复检测提示会重复注入 | AI 在候选人要求的架构自查中发现 | 候选人裁决后修复 |
| 11 | Web 端无并发控制、SSE 断开后 Agent 继续跑完 | 同上 | 加任务队列 + Worker 线程，断开即 abort |
| 12 | Mock 的 collect() 每轮全量扫描历史，O(n²) | 同上 | 降复杂度（进行中） |
| 13 | 示例任务偏简单，未覆盖复杂场景 | 候选人指出 | 补更难的用例（进行中） |
| 14 | 断开中止测试第一次跑"不可判定"：Mock 半秒内完成，测不出 abort | AI 自己看测试输出发现 | 加 `MOCK_DELAY_MS` 让 Mock 变慢后再测 |
| 15 | 扩展方案里设计了 `--pack` / `AGENT_PACKS` 工具包开关，过度设计 | 候选人否决："不用工具包和开放注册 就那几个工具而已" | 直接注册进现有 Registry |

## 测试用例从 5 个到 11 个

候选人指出“用例太简单是致命问题”后，AI 的处理方式：不是简单加任务，而是先造一个有陷阱的 workspace（假阳性、格式不一、超限大文件、诱导死循环、信息缺失），再让每个任务对准一个机制边界，并给每个任务写自动校验（与生成器写出的“标准答案”对比）。校验在第一轮就抓出 4 个问题（见错误 12–15），说明“跑通”和“对”是两回事。

需要诚实说明：这 11 个用例验证的是**框架在这些场景下的机制正确性**（并行、压缩、终止、权限、沙箱、截断处理），Mock 的“判断”是脚本写死的，不能证明模型的自主判断力。

## 未验证 / 遗留

- Anthropic 与 OpenAI 兼容 Provider 按官方协议实现并通过类型检查，但因缺少可用 key 未在真实模型上跑通；拿到 key 后执行 `pnpm test anthropic` 或 `pnpm test openai` 即可复验并覆盖 examples/。
