# Mini Agent

一个能够自主调用工具完成任务的最小化 AI Agent。TypeScript + Node.js 24（原生运行 `.ts`，零构建），提供 CLI 与 Vue 3 Web 前端。

```
User → Agent Decision → Tool Call → Tool Result → Agent Decision → … → Final Answer
```

- 📄 [设计说明 DESIGN.md](./DESIGN.md)（Agent Loop、Tool 定义、结束判定、防无限循环、失败处理、职责划分、限制）
- 🤝 [AI_USAGE.md](./AI_USAGE.md)（AI 参与环节、关键设计决策、AI 的错误判断与修正）
- 💬 [ai-conversation.md](./ai-conversation.md)（与 AI Coding 工具的完整对话过程）
- 🧩 [DESIGN-EXTENSIONS.md](./DESIGN-EXTENSIONS.md)（扩展：应用日志智能分析 + Kubernetes 故障诊断 SRE Agent，两道题作为工具接入的设计与实现说明）
- ✅ [examples/](./examples/README.md)（23 个任务的实际执行结果 + 完整 Trace，每个带自动校验）
- 🔬 [examples/real-model/](./examples/real-model/README.md)（**真实模型实跑**：两条协议各一个模型 × 4 个任务，含发现的问题）

## 功能一览

| 基础要求 | 状态 | 可选增强 | 状态 |
|---|---|---|---|
| Agent 主循环 | ✅ `src/agent.ts` | Tool Schema / 参数校验 (ajv) | ✅ |
| Tool 定义与注册 | ✅ `src/tools/registry.ts` | Tool Permission (read/write) | ✅ |
| Tool 参数解析 / 调用 / 结果回传 | ✅ | 失败自动恢复 / Retry / Timeout | ✅ |
| 根据 Tool Result 决定下一步 | ✅ | Agent Trace (JSON + Markdown) | ✅ |
| 一次任务连续多次调用 | ✅ | Token Usage | ✅ |
| 最终答案输出 | ✅ | Context Compression | ✅ |
| 轮数控制防无限循环 | ✅ maxSteps + sha1 重复检测（提醒→终止）+ 双线失败阈值 | Plan + 动态调整计划 + 写目标预算 | ✅ `update_plan`（含 `writes`） |
| Tool 失败合理处理 | ✅ | Sub Agent（并行、权限收窄、树状 Trace） | ✅ `delegate` |
| | | Streaming | ✅ CLI `--stream` / Web |
| | | 防止读取 workspace 之外 | ✅ `sandbox.ts` |
| | | Tool Search | ✅ `search_tools` + deferred tools |
| | | 一轮内并行工具调用 | ✅ 只读并行、写串行 |
| | | 中止（AbortSignal / Ctrl+C / Web 中止 / 断连） | ✅ |
| | | Web 任务队列 + Worker 线程池 | ✅ `AGENT_WORKERS` |
| | | 并发写冲突守卫（事前预约） | ✅ `write-guard.ts` |
| | | 子 Agent 派生门槛 | ✅ `expected_steps` |

工具：`read_file` `write_file` `search_text` `calculator` `list_files` `update_plan` `search_tools` `delegate`，以及需 Tool Search 激活的 `csv_parse` `file_info` `current_time`。

两道扩展题直接注册为工具（详见 [DESIGN-EXTENSIONS.md](./DESIGN-EXTENSIONS.md)）：

| 题目 | 工具 | 测试数据 |
|---|---|---|
| 应用日志智能分析 | `log_stats` 级别/模块/ERROR 比例/解析质量 · `log_latency` 平均/P50/P95/P99 + Top N 慢请求 · `log_trace` 按 traceId 还原链路 · `log_errors` 相似错误聚类 + 伴随 WARN + 候选原因 · `log_timeline` 时间趋势 + 错误突增 | `node scripts/gen-logs.ts` → `workspace/logs/app.log`（1 万行、8 模块、约 1900 traceId，含慢请求 / timeout / database / network 错误、缺字段与畸形行） |
| K8s 故障诊断 SRE Agent | 必选 `get_pod` `get_pod_events` `get_node` `get_metrics` `get_logs`；加分 `search_runbook`（知识库）`search_cases`（历史 Case）`propose_fix` → `apply_fix`（写权限 = 人工确认）→ `verify_fix`（修复后复查） | 没有真实集群：`node scripts/gen-k8s.ts` 生成 Mock 集群 `workspace/k8s/`（OOMKilled / Node NotReady / Scheduling Failed / DiskPressure / 连接超时 / GPU Xid+NCCL / 证据不足 7 个场景 + runbook + cases）。数据源抽象为 `ClusterSource`，接真实集群时换实现即可 |

## 快速开始

要求 Node.js ≥ 22.6（推荐 24，直接运行 TypeScript）。

```bash
pnpm install        # 或 npm install
```

### 1. 用 Mock LLM 跑通（无需任何 API key）

```bash
pnpm test           # 重新生成 workspace + 日志 + Mock 集群，运行 21 个任务并自动校验，结果写入 examples/
```

```bash
pnpm agent -- -p mock "找出 workspace 目录中所有 TODO，按照文件进行分类并生成 todo-report.md。"
```

### 2. 接真实模型

```bash
# Anthropic 格式（不依赖官方 SDK，直接调 /v1/messages）——官方、网关中转、各厂商的 Anthropic 兼容端点都走这一个 provider
export ANTHROPIC_API_KEY=sk-ant-...                 # 官方；默认模型 claude-opus-5，可用 ANTHROPIC_MODEL 覆盖
pnpm agent -- -p anthropic "读取 data/sales.txt 中的数据，计算所有产品销售额之和，并把计算结果写入 report.md。"

# 厂商兼容端点：--preset 带出默认地址 / 模型 / max_tokens（kimi | glm | deepseek | minimax）
pnpm agent -- -p anthropic --preset kimi --api-key sk-... "…"
pnpm agent -- -p anthropic --preset glm --api-key ... --model glm-4.5 "…"

# 企业网关 / 中转：任意地址（可写到域名、…/anthropic 或 …/v1）；只认 Bearer 的网关用 --auth-token；SSE 不稳就关流式
pnpm agent -- -p anthropic --preset custom --base-url https://gw.example.com/anthropic --auth-token xxx --model claude-sonnet-5 --max-tokens 8192 "…"
export ANTHROPIC_BASE_URL=... ANTHROPIC_AUTH_TOKEN=... ANTHROPIC_PRESET=custom ANTHROPIC_STREAM=false   # 等价的环境变量
```

兼容性处理见 [DESIGN.md §5](./DESIGN.md#5-llm-provider)：两种鉴权头同时发送、路径归一化、按响应 content-type 决定流式/JSON 解析、容忍第三方实现的偏差（tool_use.input 直接给全 / 缺 usage / 多出 thinking 块 / 只有 data 行的 SSE）、429/529/5xx 退避重试。

```bash
# 任意 OpenAI 兼容接口（DeepSeek / Qwen / Ollama / vLLM …）
export OPENAI_BASE_URL=https://api.deepseek.com/v1
export OPENAI_API_KEY=sk-...
export OPENAI_MODEL=deepseek-chat
pnpm agent -- -p openai -s "核对 docs/design.md 中引用的所有文件是否存在且可读，把核对结果写入 docs/check.md。"
```

```bash
# 本地模型：Ollama（默认 http://localhost:11434/v1，非流式）
pnpm agent -- -p local --flavor ollama --model qwen2.5:7b "找出所有 TODO 并生成 todo-report.md"
```

```bash
# 本地模型：vLLM（默认 http://localhost:8000/v1，流式）
# 服务端需 --enable-auto-tool-choice --tool-call-parser hermes（按模型选 parser），否则不会产生 tool call
pnpm agent -- -p local --flavor vllm --base-url http://localhost:8000/v1 --model Qwen/Qwen2.5-7B-Instruct "…"
```

也可以设置 `LLM_PROVIDER=anthropic|openai|local|mock`、`LLM_FLAVOR=ollama|vllm|openai`、`OPENAI_BASE_URL`、`OPENAI_MODEL`、`OPENAI_API_KEY`、`ANTHROPIC_BASE_URL`、`ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN`、`ANTHROPIC_MODEL`、`ANTHROPIC_PRESET`、`ANTHROPIC_MAX_TOKENS`、`ANTHROPIC_STREAM` 作为默认值。

三种 OpenAI 兼容口味的请求差异（详见 DESIGN.md §5）：

| | openai / 云端 | vLLM | Ollama `/v1` |
|---|---|---|---|
| 默认地址 | api.openai.com/v1 | localhost:8000/v1 | localhost:11434/v1 |
| `tools` | ✅ | ✅（需启动参数） | ✅ |
| `tool_choice: auto` | ✅ | ✅ | ❌ 不发送（文档列为不支持） |
| `stream` 默认 | 开 | 开 | 关（流式 tool call 支持不稳定，可手动开） |
| `stream_options` | ✅ | ✅ | ❌ 不发送 |
| API Key | 必填 | 视启动参数 | 任意值，被忽略 |

`pnpm check-schema` 不连任何模型，离线校验三种口味组装出的请求体（tools 形状、tool_choice / stream_options 的有无、arguments 为字符串、tool 消息紧跟 assistant 且 id 对应等）以及全部工具 JSON Schema 的合法性。本地模型未在开发机上实际跑过（性能不足），以此保证 schema 不传错。

### 3. Web 前端

```bash
pnpm web            # http://localhost:3000
```

左侧输入任务 / 选择 provider / 是否允许写文件；中间实时时间线展示决策、工具调用、结果、Plan、Context 压缩、子 Agent（缩进紫色）；右侧统计、当前计划、workspace 文件浏览、Trace 保存位置。前端为 Vue 3（CDN 引入，单文件 `web/index.html`），通过 SSE 接收事件。

选择"本地模型 (Ollama / vLLM)"后会出现连接面板：服务类型、API Base URL、模型（可点"获取模型列表"从 `{baseUrl}/models` 拉取）、可选 API Key、流式开关。切换服务类型会填入该类型的默认地址与默认值。

任务进入队列，最多 `AGENT_WORKERS`（默认 2）个并发，每个 Agent 跑在独立 Worker 线程；排队时显示位置。运行中可点“中止”，关闭页面也会中止对应任务。`MOCK_DELAY_MS=400 pnpm web` 可让 mock 变慢以观察排队与中止。

### CLI 选项

```
node src/cli.ts [选项] "<任务描述>"
  -w, --workspace <dir>   workspace 目录 (默认 workspace)
  -p, --provider <name>   anthropic | openai | mock
      --max-steps <n>     最大轮数 (默认 15)
      --no-write          禁止 write_file
      --trace-dir <dir>   trace 输出目录 (默认 traces)
  -s, --stream            流式打印模型输出
  -q, --quiet             只输出最终答案
```

退出码：0 完成，2 未完成（达上限 / 连续失败 / LLM 错误）。

## 测试 workspace

由三个脚本确定性生成，`pnpm test` 会自动依次执行（也可单独运行）：

```bash
node scripts/gen-workspace.ts   # 基础材料：TODO/FIXME、销售数据、大文件、陷阱
node scripts/gen-logs.ts 10000  # workspace/logs/app.log（日志分析题）
node scripts/gen-k8s.ts         # workspace/k8s/（Mock K8s 集群，故障诊断题）
```

生成物已提交进仓库，clone 下来即可直接阅读测试材料，不必先跑脚本。基础材料部分：约 20 个文件，刻意包含：多种写法的 TODO/FIXME 与 `todoList`/`TODOS` 假阳性、`node_modules` 干扰、三种格式不一的地区销售数据（¥、千分位、负数退款、脏行）、151KB 的 changelog（读入触发 Context 压缩）、252KB 的日志（超过 read_file 上限）、引用不存在文件与二进制文件的文档、永远不就绪的锁文件、以及“任务需要但 workspace 里没有”的信息（汇率）。详见 [DESIGN.md §7](./DESIGN.md#7-测试-workspace-与任务)。

## 测试任务与结果（23/23 自动校验通过）

| # | 任务 | 验证的机制 | 结果 |
|---|---|---|---|
| [01](./examples/01-search-and-summarize/README.md) | 找出所有 TODO 按文件分类生成报告 | 搜索含假阳性 → 精化正则重搜；源码文件并行派 4 个子 Agent | ✅ 16 条，无假阳性 |
| [02](./examples/02-read-calc-report/README.md) | 读 sales.txt 求和写报告 | Tool Search 激活 csv_parse；脏数据；calculator | ✅ 9414.75 |
| [03](./examples/03-multi-step-with-failures/README.md) | 核对 design.md 引用的 8 个文件 | 2 次失败后修订计划 | ✅ 6 存在 2 异常 |
| [04](./examples/04-failure-no-write-permission/README.md) | 无写权限生成报告 | 权限拒绝 | ✅ 明确报告 |
| [05](./examples/05-failure-escape-workspace/README.md) | 读 `../../etc/passwd` | 沙箱 | ✅ 拒绝 |
| [06](./examples/06-multi-region-aggregate/README.md) | 汇总三地区销售额 | 一轮并行读 3 文件 + 一轮并行 4 个 calculator；格式归一 | ✅ 14495.25 |
| [07](./examples/07-large-changelog-compression/README.md) | 整理 changelog 的 BREAKING 并核对文件 | 151KB 文件 → Context 压缩；并行核对 | ✅ 49 条，压缩节省 65k 字符 |
| [08](./examples/08-huge-log-search-fallback/README.md) | 统计 huge.log 每类 ERROR | read_file 超限 → search_text；截断 → 分类型并行搜索 | ✅ 与生成器答案一致 |
| [09](./examples/09-stuck-loop-detection/README.md) | 等待永不就绪的锁 | 3 轮重复 → 提醒 → 2 轮 → 终止 | ✅ stuck_loop，5 步 |
| [10](./examples/10-subagent-write-permission/README.md) | 子 Agent 为 5 个源码文件生成摘要 | 子 Agent 默认只读 → 写失败 → 授予 allow_write 并行重派 | ✅ 5 个摘要 |
| [11](./examples/11-cannot-complete-missing-info/README.md) | 销售额换算美元 | 信息缺失 → 明确拒绝猜测 | ✅ 未生成报告 |
| [12](./examples/12-log-analysis-report/README.md) | 分析 logs/app.log 生成报告 | 一轮并行 4 个统计工具 → 并行 log_trace → Markdown 报告（统计事实 / 推断原因 / 数据质量分开） | ✅ 含 P95/P99、模块 ERROR 比例、错误聚类、突增时段 |
| [13](./examples/13-log-trace-restore/README.md) | 还原 traceId=t00002 链路 | log_trace | ✅ 模块顺序 + 各步耗时 + 错误 |
| [14](./examples/14-log-file-missing/README.md) | 分析不存在的日志 | 4 个并行调用全部失败 → list_files 确认 → 明确终止 | ✅ 未捏造 |
| [15](./examples/15-k8s-oom-with-fix/README.md) | 分析 job-123 并修复 | get_pod 信号 → 并行 events/node/metrics/previous 日志 → runbook + case → propose_fix → apply_fix（写）→ verify_fix → 复盘报告 | ✅ OOMKilled，recovered=true |
| [16](./examples/16-k8s-insufficient-evidence/README.md) | 分析 job-128 | Event 已清理、日志空、无指标 | ✅ 明确“证据不足”，不给结论 |
| [17](./examples/17-k8s-net-timeout-no-write/README.md) | 分析 api-worker-7 并修复（无写权限） | apply_fix 被拒 → 转为“待人工确认执行”的建议 | ✅ dial tcp i/o timeout 证据 |
| [18](./examples/18-k8s-node-notready/README.md) | 分析 job-124 | 日志取不到 + 指标中断本身作为证据 | ✅ Node NotReady |
| [19](./examples/19-k8s-scheduling-failed/README.md) | 分析 job-125 | FailedScheduling message 逐节点原因 + 节点容量 | ✅ cpu=6 超过单节点 |
| [20](./examples/20-k8s-disk-pressure/README.md) | 分析 job-126 | Evicted message + Node DiskPressure + no space left | ✅ |
| [21](./examples/21-k8s-gpu-xid-nccl/README.md) | 分析 train-job-7 | Xid 79 硬件根因（高）vs NCCL 次生（低） | ✅ |
| [22](./examples/22-write-conflict-guard/README.md) | 并发写冲突演练 | 另一任务占用输出文件 → plan 阶段即被拒 → 换路径重规划 | ✅ 冲突在计划阶段暴露 |
| [23](./examples/23-delegate-expected-steps/README.md) | delegate 门槛演练 | `expected_steps=1` 低于门槛被拒 → 改为自己调 read_file | ✅ 省下一次子 Agent 调用 |

每个目录含 `README.md`（任务、校验结论、最终答案、统计）、生成的文件、`trace.md` / `trace.json`（完整 Agent Trace，子 Agent 嵌套折叠）。

> 以上结果由 Mock LLM 生成（开发环境中没有可用的模型 key）。Mock 是规则脚本，只根据消息历史与最近的 tool result 决定下一步，用于验证 Loop、工具、失败路径和各增强项的机制；换成真实模型只需 `-p anthropic|openai`。

## 项目结构

```
src/
├── agent.ts            Agent 主循环（轮数控制、结束判定、失败阈值、重复检测、Plan/子 Agent/Tool Search 运行时）
├── context.ts          消息历史 + 压缩
├── trace.ts            Trace 记录与导出
├── types.ts            统一类型（Message / Tool / AgentEvent …）
├── cli.ts              命令行入口
├── server.ts           HTTP + SSE 服务（Web 前端后端）
├── job-queue.ts        任务队列 + Worker 线程池 + 中止
├── worker.ts           Worker 线程入口
├── llm/
│   ├── anthropic.ts    Anthropic Messages API 兼容层（官方 / 网关 / Kimi / GLM / DeepSeek / MiniMax；fetch 直连，流式 + 非流式）
│   ├── openai.ts       OpenAI 兼容接口：openai / vllm / ollama 三种 flavor，流式或非流式
│   ├── mock.ts         规则驱动 Mock LLM
│   └── index.ts        Provider 工厂
└── tools/
    ├── registry.ts     注册、schema 输出、参数解析/校验、权限、超时、重试边界、Tool Search
    ├── sandbox.ts      workspace 路径沙箱
    ├── log-tools.ts    日志分析 5 个工具（流式容错解析）
    ├── k8s-tools.ts    K8s 诊断 10 个工具
    ├── k8s/cluster.ts  ClusterSource 接口 + Mock 实现（读 workspace/k8s/cluster.json，修复动作叠加）
    ├── fs-tools.ts     read_file / write_file / list_files / search_text
    ├── calculator.ts   安全表达式求值（递归下降，不用 eval）
    ├── write-guard.ts  并发写冲突守卫（事前预约 + 锁文件）
    ├── extra-tools.ts  deferred 工具：csv_parse / file_info / current_time
    └── agent-tools.ts  update_plan / search_tools / delegate
web/index.html          Vue 3 前端
workspace/              测试材料
scripts/                gen-workspace.ts · gen-logs.ts · gen-k8s.ts（生成测试材料）/ run-examples.ts（Mock 用例并校验）
                        run-real-model.ts（真实模型实跑）/ check-request-schema.ts（离线校验请求体）/ audit-trace.ts（Trace 数值溯源审计）
examples/               任务执行结果与 Trace
```
