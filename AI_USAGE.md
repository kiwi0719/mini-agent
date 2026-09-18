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
13. **扩展方向**：候选人另开线程，要求评估把"应用日志智能分析"和"Kubernetes 故障诊断 SRE Agent"两道题作为工具接入 mini-agent，并要求保存该线程的聊天记录。AI 给出方案后候选人裁决：两题都做；加分项不只做低成本的，全做；**不要工具包 / `--pack` 开关**，直接注册那几个工具；没有 K8s 环境，要 AI 给替代方案（AI 采用 JSON fixture 的 Mock 集群 + `ClusterSource` 接口）。
14. **Tool Search 语义化选方案 2 并写明理由**：AI 建议 tags+BM25 与目录回退组合，候选人判断"正常应做 1/3，但这是 demo，接 reranker/embedding 太麻烦"，选只做目录回退，并要求在文档里说明取舍。
15. **两个会话互踩时的处理**：AI 发现自己 `git add -A` 带上了另一个会话的半成品并询问是否回退，候选人决定不回退，"你就 commit 你的就行"。
16. **本地模型兼容的范围**：要求前端加 provider 选项与 API base URL 输入，兼容 Ollama 与 vLLM，字段由 AI 设计（可检索资料）；明确不做别的，也不在本机跑验证（性能不够），只要保证 schema 不传错。
17. **Anthropic Provider 也要兼容非官方接口**：候选人要求 Anthropic 通道不只连官方 API，也要支持第三方兼容网关。AI 据此去掉官方 SDK 改为直接 fetch，并加 Kimi / GLM / DeepSeek / MiniMax 预设。
18. **交付前复核**：候选人重新贴出题目全部交付物要求，要求 AI 逐项复核哪些没完成，包括新增的设计。AI 据此发现远端缺失另一线程的全部文件并收口提交。

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
| 17 | examples/01 用 4 个子 Agent 逐文件读 TODO，实际 search_text 结果已足够，分 sub 只是为了演示机制 | 候选人追问"怎么确定分的"，AI 自查后承认 | 写入限制说明；框架侧判断方案由候选人决定暂不应用 |
| 18 | 扩展方案里设计了 `--pack` / `AGENT_PACKS` 工具包开关，过度设计 | 候选人否决："不用工具包和开放注册 就那几个工具而已" | 直接注册进现有 Registry |
| 19 | 提交时用 `git add -A`，把另一个会话正在写的 `log-tools.ts`、`k8s-tools.ts` 等半成品一起推上了远端 | 探针测试的工具列表出现自己没写的工具，追查发现有另一个 Claude 会话 | 改为只暂存自己改的文件，主动向候选人报告并询问处理方式 |
| 20 | `gen-workspace.ts` 整目录删除 workspace 再重建，`pnpm test` 每跑一次就清掉另一个会话的 `workspace/logs`、`workspace/k8s` | 发现 `workspace/logs` 为空 | 改为只清理自己生成的子树 |
| 21 | K8s GPU 场景中重启类 Pod 没取 previous 容器日志，证据链缺失 | 跑示例时发现 | get_logs 对重启 Pod 取 previous 日志 |
| 22 | 只提交自己改的文件，导致远端长期缺少另一线程的全部工作，README 承诺的 21 个任务在远端并不存在 | 候选人要求复核交付物时逐项对照发现 | 收口提交全部文件，并从 GitHub 全新 clone 独立验证 |
| 23 | `check-request-schema.ts` 会读取宿主机的 `ANTHROPIC_AUTH_TOKEN`，断言结果依赖运行环境 | 扩展 Anthropic 预设校验时发现 | 改为显式传值，并补只给 Bearer 的反向用例 |
| 24 | AI_USAGE 把 schema 离线校验写成"端到端验证" | 复核时自查发现 | 改为三档表格，区分端到端 / 仅协议层 / Mock 数据下的端到端 |

## 测试用例从 5 个到 11 个

候选人指出“用例太简单是致命问题”后，AI 的处理方式：不是简单加任务，而是先造一个有陷阱的 workspace（假阳性、格式不一、超限大文件、诱导死循环、信息缺失），再让每个任务对准一个机制边界，并给每个任务写自动校验（与生成器写出的“标准答案”对比）。校验在第一轮就抓出 4 个问题（见错误 12–15），说明“跑通”和“对”是两回事。

需要诚实说明：这 11 个用例验证的是**框架在这些场景下的机制正确性**（并行、压缩、终止、权限、沙箱、截断处理），Mock 的“判断”是脚本写死的，不能证明模型的自主判断力。

## 扩展：日志分析 + K8s 故障诊断两题作为工具接入

- **候选人决定**：两题不另起项目，作为工具接进 Mini Agent；否决 AI 初稿里的"工具包 + 注册开关"（"就那几个工具而已"）；加分项不只做低成本的；没有 K8s 集群 → 要一个替代方案。
- **AI 给出的替代方案**：`ClusterSource` 接口 + Mock 实现，集群状态用 JSON 描述；修复动作以"叠加状态"方式让 verify_fix 真正重新查询；接真实集群只换实现。
- **AI 的错误与修正**：① 日志生成器把故障窗口放在 10:20，而 1 万行日志只覆盖 15 分钟 → 趋势分析看不到突增，改到 10:08；② 错误归一化把 HTTP 状态码也抹成 `#`，500/502/504 被合并成一类 → 保留 `status=NNN`；③ GPU 场景的 Pod 只重启 2 次没触发"看 previous 日志"的规则，靠当前日志里一行 NCCL INFO 误中 → 规则改为 CrashLoopBackOff/终止原因也读 previous，GPU 判定要求 `NVRM: Xid` 或 `NCCL WARN/error`；④ 证据不足场景里把弱相关的 runbook / case 当成了证据 → 该场景下只标注"仅弱相关匹配"；⑤ 修复流程最后一步重新推导诊断时丢了 verify_fix 结果 → 每步都补回。
- **并发编辑**：本线程与另一个会话同时修改同一仓库（对方重写了 mock.ts / run-examples.ts / gen-workspace.ts 并重建 workspace，把日志与 Mock 集群目录清掉一次）。处理：新剧本放独立文件 `mock-scenarios.ts`，只在 mock.ts 插入 3 行分派；示例脚本在 gen-workspace 之后追加生成日志与集群；提交前应只保留一个会话写仓库。

## Anthropic Provider 去 SDK 化、兼容第三方端点

- **候选人决定**："anthropic 也别只兼容官方接口了，要兼容别的"。
- **AI 做法**：去掉 `@anthropic-ai/sdk`，用 fetch 直连 Messages API；把厂商差异收敛为 preset 表 + 一组容错规则（双鉴权头、路径归一化、按 content-type 选解析器、SSE 偏差容忍、max_tokens 可配）；CLI 加 `--preset/--auth-token/--max-tokens`，Web 面板加端点预设。
- **验证方式**：没有第三方 key，用一个假的 Anthropic 兼容 HTTP 服务（scratch 脚本）覆盖：路径归一化 4 种写法、流式（含无 event 行、input 分片、start 直接给全 input、缺 id、ping）、非流式（含 thinking 块）、双鉴权头、max_tokens 透传、529 重试、消息转换（tool_result 配对、空 assistant content）。对官方接口真实请求一次，401 错误正确透出到 CLI 与 Web。
- **未验证**：各厂商预设里的默认地址与模型名按公开文档填写，没有真实 key 实测；厂商如改路径或模型名需要改 `ANTHROPIC_PRESETS`。

## 未验证 / 遗留

按"验证到什么程度"分三档，避免把协议校验说成端到端验证：

| 项 | 验证到的程度 | 未验证的部分 |
|---|---|---|
| Agent Loop、工具、失败处理、各增强项 | **端到端**：21 个用例带断言，`pnpm test` 全绿；断言比对的是生成脚本写出的标准答案，不是"跑通即通过" | Mock 的决策是脚本写死的，模型自主判断力未被证明 |
| 四条模型通路（Anthropic 格式 + 5 厂商预设、OpenAI 兼容、Ollama、vLLM） | **仅协议层**：`pnpm check-schema` 离线校验 9 种端点配置的请求体 / 请求头 / baseUrl 归一化 / 26 个工具 Schema | 从未连过任何真实模型。开发机 key 无效、性能不足以跑本地模型 |
| 扩展工具包（日志分析、K8s 诊断） | **端到端但数据是 Mock 的**：10 个用例覆盖 7 类故障场景与证据不足场景 | 没有真实集群与真实生产日志；`ClusterSource` 换成真实实现后是否好用未知 |

复验方式：拿到任一可用 key 后 `pnpm test anthropic` 或 `pnpm test openai`，即可用真实模型重跑全部用例并覆盖 examples/。

**一个诚实的说明**：`pnpm check-schema` 是在"不能连真实模型"的约束下能做到的最强保证，它确实抓出过真问题（编写它的过程中就发现校验器自己会读取宿主机 `ANTHROPIC_AUTH_TOKEN` 导致断言不可复现，已改为显式传值）。但它证明的是"字段不会传错"，不是"Agent 能用"。
