# Mini Agent

一个能够自主调用工具完成任务的最小化 AI Agent。TypeScript + Node.js 24（原生运行 `.ts`，零构建），提供 CLI 与 Vue 3 Web 前端。

```
User → Agent Decision → Tool Call → Tool Result → Agent Decision → … → Final Answer
```

- 📄 [设计说明 DESIGN.md](./DESIGN.md)（Agent Loop、Tool 定义、结束判定、防无限循环、失败处理、职责划分、限制）
- 🤝 [AI_USAGE.md](./AI_USAGE.md)（AI 参与环节、关键设计决策、AI 的错误判断与修正）
- 💬 [ai-conversation.md](./ai-conversation.md)（与 AI Coding 工具的完整对话过程）
- 🧩 [DESIGN-EXTENSIONS.md](./DESIGN-EXTENSIONS.md)（扩展方案：日志分析工具包 + K8s 故障诊断工具包，设计稿）
- ✅ [examples/](./examples/README.md)（11 个任务的实际执行结果 + 完整 Trace，每个带自动校验）

## 功能一览

| 基础要求 | 状态 | 可选增强 | 状态 |
|---|---|---|---|
| Agent 主循环 | ✅ `src/agent.ts` | Tool Schema / 参数校验 (ajv) | ✅ |
| Tool 定义与注册 | ✅ `src/tools/registry.ts` | Tool Permission (read/write) | ✅ |
| Tool 参数解析 / 调用 / 结果回传 | ✅ | 失败自动恢复 / Retry / Timeout | ✅ |
| 根据 Tool Result 决定下一步 | ✅ | Agent Trace (JSON + Markdown) | ✅ |
| 一次任务连续多次调用 | ✅ | Token Usage | ✅ |
| 最终答案输出 | ✅ | Context Compression | ✅ |
| 轮数控制防无限循环 | ✅ maxSteps + sha1 重复检测（提醒→终止）+ 双线失败阈值 | Plan + 动态调整计划 | ✅ `update_plan` |
| Tool 失败合理处理 | ✅ | Sub Agent（并行、权限收窄、树状 Trace） | ✅ `delegate` |
| | | Streaming | ✅ CLI `--stream` / Web |
| | | 防止读取 workspace 之外 | ✅ `sandbox.ts` |
| | | Tool Search | ✅ `search_tools` + deferred tools |
| | | 一轮内并行工具调用 | ✅ 只读并行、写串行 |
| | | 中止（AbortSignal / Ctrl+C / Web 中止 / 断连） | ✅ |
| | | Web 任务队列 + Worker 线程池 | ✅ `AGENT_WORKERS` |

工具：`read_file` `write_file` `search_text` `calculator` `list_files` `update_plan` `search_tools` `delegate`，以及需 Tool Search 激活的 `csv_parse` `file_info` `current_time`。

## 快速开始

要求 Node.js ≥ 22.6（推荐 24，直接运行 TypeScript）。

```bash
pnpm install        # 或 npm install
```

### 1. 用 Mock LLM 跑通（无需任何 API key）

```bash
pnpm test           # 重新生成 workspace，运行 11 个任务并自动校验，结果写入 examples/
```

```bash
pnpm agent -- -p mock "找出 workspace 目录中所有 TODO，按照文件进行分类并生成 todo-report.md。"
```

### 2. 接真实模型

```bash
# Anthropic（默认模型 claude-opus-5，可用 ANTHROPIC_MODEL 覆盖）
export ANTHROPIC_API_KEY=sk-ant-...
pnpm agent -- -p anthropic "读取 data/sales.txt 中的数据，计算所有产品销售额之和，并把计算结果写入 report.md。"
```

```bash
# 任意 OpenAI 兼容接口（DeepSeek / Qwen / Ollama / vLLM …）
export OPENAI_BASE_URL=https://api.deepseek.com/v1
export OPENAI_API_KEY=sk-...
export OPENAI_MODEL=deepseek-chat
pnpm agent -- -p openai -s "核对 docs/design.md 中引用的所有文件是否存在且可读，把核对结果写入 docs/check.md。"
```

也可以设置 `LLM_PROVIDER=anthropic|openai|mock` 作为默认值。

### 3. Web 前端

```bash
pnpm web            # http://localhost:3000
```

左侧输入任务 / 选择 provider / 是否允许写文件；中间实时时间线展示决策、工具调用、结果、Plan、Context 压缩、子 Agent（缩进紫色）；右侧统计、当前计划、workspace 文件浏览、Trace 保存位置。前端为 Vue 3（CDN 引入，单文件 `web/index.html`），通过 SSE 接收事件。

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

由 `scripts/gen-workspace.ts` 确定性生成（`pnpm test` 自动执行；也可 `node scripts/gen-workspace.ts` 手动重置）。约 20 个文件，刻意包含：多种写法的 TODO/FIXME 与 `todoList`/`TODOS` 假阳性、`node_modules` 干扰、三种格式不一的地区销售数据（¥、千分位、负数退款、脏行）、151KB 的 changelog（读入触发 Context 压缩）、252KB 的日志（超过 read_file 上限）、引用不存在文件与二进制文件的文档、永远不就绪的锁文件、以及“任务需要但 workspace 里没有”的信息（汇率）。详见 [DESIGN.md §7](./DESIGN.md#7-测试-workspace-与任务)。

## 测试任务与结果（11/11 自动校验通过）

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
│   ├── anthropic.ts    Anthropic Messages API（流式）
│   ├── openai.ts       OpenAI 兼容接口（流式 SSE 解析）
│   ├── mock.ts         规则驱动 Mock LLM
│   └── index.ts        Provider 工厂
└── tools/
    ├── registry.ts     注册、schema 输出、参数解析/校验、权限、超时、重试边界、Tool Search
    ├── sandbox.ts      workspace 路径沙箱
    ├── fs-tools.ts     read_file / write_file / list_files / search_text
    ├── calculator.ts   安全表达式求值（递归下降，不用 eval）
    ├── extra-tools.ts  deferred 工具：csv_parse / file_info / current_time
    └── agent-tools.ts  update_plan / search_tools / delegate
web/index.html          Vue 3 前端
workspace/              测试材料
scripts/                gen-workspace.ts（生成测试材料）/ run-examples.ts（跑 11 个任务并校验）/ reset-workspace.ts
examples/               任务执行结果与 Trace
```
