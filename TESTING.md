# 测试指南（给测试人员）

这份文档只讲**怎么把它跑起来、key 填哪里、产物落在哪个路径**。设计思路看 [DESIGN.md](./DESIGN.md)，功能清单看 [README.md](./README.md)。

---

## 0. 一分钟结论

```bash
cd /Users/kiwi/Desktop/10jqka/mini-agent   # 项目根目录，下文所有相对路径都相对于它
node -v                                     # 必须 ≥ 22.6，推荐 24（直接跑 .ts，无需编译）
pnpm install                                # 或 npm install（只有一个依赖 ajv）
pnpm test                                   # 不需要任何 API key，跑完 23 个用例并自动校验
```

跑完没有 key 也能看到全部机制。要验证"接真模型能不能用"再往下看第 3 节。

---

## 1. 目录与路径速查

项目根目录：`/Users/kiwi/Desktop/10jqka/mini-agent`

| 路径 | 是什么 | 测试时看什么 |
|---|---|---|
| `src/` | 全部源码（`cli.ts` 命令行入口、`server.ts` Web 入口、`agent.ts` 主循环） | — |
| `workspace/` | **被 Agent 操作的沙箱目录**，Agent 只能读写这里面 | 任务生成的文件都在这里 |
| `workspace/data/` `workspace/docs/` `workspace/src/` | 基础测试材料（TODO、销售数据、大文件、陷阱文件） | — |
| `workspace/logs/app.log` | 日志分析题的数据（`scripts/gen-logs.ts` 生成，1 万行） | — |
| `workspace/k8s/` | K8s 故障诊断题的 Mock 集群（`scripts/gen-k8s.ts` 生成） | — |
| `traces/` | **每次 CLI/Web 运行自动落一份 Trace**，`trace-<时间戳>.md` + `.json` | 复盘"它到底调了什么" |
| `examples/01…23/` | 23 个 Mock 用例的留档：`README.md` + 生成的文件 + `trace.md`/`trace.json` | 对照你自己跑出来的结果 |
| `examples/real-model/` | 真实模型实跑的留档（含发现的问题） | — |
| `scripts/` | 生成测试材料与批量跑用例的脚本 | 见第 5 节 |
| `web/index.html` | Vue 3 前端（单文件，CDN 引入，不用打包） | — |
| `.env` | 你的凭证（**已被 .gitignore 忽略，不会提交**） | 见第 3 节 |
| `.env.example` | 凭证模板，`cp .env.example .env` 后改 | 见第 3 节 |

命令行每跑完一次，最后一行会打印 trace 路径，例如：

```
📝 trace: traces/trace-2026-09-19T07-40-12-001Z.md
```

`-w/--workspace` 可以换沙箱目录，`--trace-dir` 可以换 trace 输出目录。

---

## 2. 不用 key 的跑法（先跑这个）

```bash
pnpm test                 # 重新生成 workspace + 日志 + Mock 集群，跑 23 个任务并自动校验，结果写入 examples/
```

单跑一个任务：

```bash
pnpm agent -- -p mock "找出 workspace 目录中所有 TODO，按照文件进行分类并生成 todo-report.md。"
```

> 注意 `pnpm agent` 后面那个 `--`：它把后续参数透传给脚本，漏了的话 pnpm 会自己吞掉 `-p`。用 npm 则是 `npm run agent -- -p mock "…"`；直接 `node src/cli.ts -p mock "…"` 也一样。

Web 界面（provider 选 "Mock"）：

```bash
pnpm web                  # 打开 http://localhost:3000
```

跑完想恢复干净的测试材料：

```bash
pnpm reset-workspace
```

---

## 3. API key 填在哪里（三种方式，任选其一）

**本项目不会自动读取 `.env`。** 三种输入方式的优先级是：

> 命令行参数 > 进程环境变量（`export` 或 `--env-file` 注入的）> 代码内置默认值

### 方式 A：命令行直接给（最快，适合临时试一个 key）

```bash
node src/cli.ts -p anthropic --api-key sk-ant-xxxx "读取 data/sales.txt …"
```

缺点：key 会留在 shell history 里。

### 方式 B：`export` 到环境变量（适合一个终端里连跑多条）

```bash
export ANTHROPIC_API_KEY=sk-ant-xxxx
pnpm agent -- -p anthropic "…"
pnpm web                     # Web 也会用到这个 key
```

### 方式 C：写进 `.env` 文件（推荐，key 不进 history）

```bash
cp .env.example .env
# 用编辑器打开 .env，取消注释并填上你要用的那几行
```

`.env` 的位置：`/Users/kiwi/Desktop/10jqka/mini-agent/.env`（项目根目录，和 `package.json` 同级）。格式是纯 `KEY=value`，一行一个，**不要加 `export`，不要加引号**：

```
ANTHROPIC_API_KEY=sk-ant-xxxxxxxx
ANTHROPIC_MODEL=claude-sonnet-5
```

**关键一步：必须用 `node --env-file=.env` 启动，`.env` 才会生效。**

```bash
node --env-file=.env src/cli.ts -p anthropic "读取 data/sales.txt …"   # CLI
node --env-file=.env src/server.ts                                      # Web
node --env-file=.env scripts/run-examples.ts                            # 批量用例
node --env-file=.env scripts/run-real-model.ts                          # 真实模型实跑
```

`pnpm agent` / `pnpm web` / `pnpm test` 这些快捷脚本**不带** `--env-file`，所以它们读不到 `.env`。想用 `.env` 就按上面写成完整的 `node --env-file=.env …`。（`NODE_OPTIONS='--env-file=.env'` 是行不通的，Node 明确禁止在 NODE_OPTIONS 里用这个参数。）

如果这台机器上 `.env` 里已经有东西，先看一眼别覆盖掉：`cat .env`。

### 方式 D：Web 界面里直接填

`pnpm web` → provider 选 "Anthropic 兼容" 或 "本地模型" → 面板里有 **API Key 输入框**（password 类型，不回显）。填了就用你填的；留空则回退到服务端进程的 `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` / `OPENAI_API_KEY`。

---

## 4. 各家模型的具体命令

### 4.1 Anthropic 协议（官方 / 企业网关 / Kimi / GLM / DeepSeek / MiniMax）

一个 provider 通吃，靠 `--preset` 带出地址和默认模型：

| preset | 默认 baseUrl | 默认模型 | 默认 max_tokens |
|---|---|---|---|
| `anthropic`（默认） | `https://api.anthropic.com` | `claude-opus-5` | 16000 |
| `kimi` | `https://api.moonshot.cn/anthropic` | `kimi-k2-0905-preview` | 8192 |
| `glm` | `https://open.bigmodel.cn/api/anthropic` | `glm-4.5` | 8192 |
| `deepseek` | `https://api.deepseek.com/anthropic` | `deepseek-chat` | 8192 |
| `minimax` | `https://api.minimax.io/anthropic` | `MiniMax-M2` | 8192 |
| `custom` | 必须自己填 `--base-url` | 必须自己填 `--model` | 8192 |

```bash
# 官方
export ANTHROPIC_API_KEY=sk-ant-xxxx
pnpm agent -- -p anthropic "读取 data/sales.txt 中的数据，计算所有产品销售额之和，并把计算结果写入 report.md。"

# 厂商兼容端点
pnpm agent -- -p anthropic --preset kimi --api-key sk-xxxx "…"
pnpm agent -- -p anthropic --preset glm  --api-key xxxx --model glm-4.5 "…"

# 企业网关 / 中转（地址写到域名、…/anthropic 或 …/v1 都行，会自动归一化）
pnpm agent -- -p anthropic --preset custom \
  --base-url https://gw.example.com/anthropic \
  --auth-token xxxx --model claude-sonnet-5 --max-tokens 8192 "…"
```

`--api-key` 会同时作为 `x-api-key` 和 `Authorization: Bearer` 发出；只认 Bearer 的网关也可以显式用 `--auth-token`。SSE 不稳的网关加 `ANTHROPIC_STREAM=false`（或 `.env` 里写这一行）。

对应环境变量：`ANTHROPIC_API_KEY` `ANTHROPIC_AUTH_TOKEN` `ANTHROPIC_BASE_URL` `ANTHROPIC_MODEL` `ANTHROPIC_PRESET` `ANTHROPIC_MAX_TOKENS` `ANTHROPIC_STREAM`。

### 4.2 OpenAI 协议（OpenAI / DeepSeek / Qwen / OpenRouter …）

```bash
export OPENAI_BASE_URL=https://api.deepseek.com/v1
export OPENAI_API_KEY=sk-xxxx
export OPENAI_MODEL=deepseek-chat
pnpm agent -- -p openai -s "核对 docs/design.md 中引用的所有文件是否存在且可读，把核对结果写入 docs/check.md。"
```

或全部走参数：`-p openai --base-url … --api-key … --model …`。

对应环境变量：`OPENAI_BASE_URL` `OPENAI_API_KEY` `OPENAI_MODEL`。

### 4.3 本地模型（不需要 key）

```bash
# Ollama：默认 http://localhost:11434/v1，默认非流式
pnpm agent -- -p local --flavor ollama --model qwen2.5:7b "找出所有 TODO 并生成 todo-report.md"

# vLLM：默认 http://localhost:8000/v1，默认流式
# 服务端必须带 --enable-auto-tool-choice --tool-call-parser hermes（parser 按模型选），否则模型不会产生 tool call
pnpm agent -- -p local --flavor vllm --base-url http://localhost:8000/v1 --model Qwen/Qwen2.5-7B-Instruct "…"
```

Ollama 的 API Key 填任意值都会被忽略。本地模型在开发机上没有实跑过（机器性能不够），所以离线用 `pnpm check-schema` 保证请求体形状正确。

---

## 5. 脚本一览

| 命令 | 作用 | 需要 key？ |
|---|---|---|
| `pnpm test` | 生成测试材料 → 跑 23 个任务 → 自动校验 → 写入 `examples/` | 否（Mock） |
| `pnpm agent -- …` | 跑单个任务（= `node src/cli.ts`） | 看 provider |
| `pnpm web` | 起 Web（默认 `http://localhost:3000`，`PORT` 可改） | 看 provider |
| `pnpm reset-workspace` | 把 `workspace/` 恢复成初始测试材料 | 否 |
| `pnpm check-schema` | 离线校验三种口味组装出的请求体 + 全部工具 JSON Schema | 否 |
| `pnpm typecheck` | `tsc --noEmit` | 否 |
| `pnpm audit` | Trace 数值溯源审计（报告里的数字能不能对回工具输出） | 否 |
| `node scripts/gen-workspace.ts` | 单独生成基础材料 | 否 |
| `node scripts/gen-logs.ts 10000` | 单独生成 `workspace/logs/app.log` | 否 |
| `node scripts/gen-k8s.ts` | 单独生成 `workspace/k8s/` Mock 集群 | 否 |
| `node --env-file=.env scripts/run-real-model.ts [任务号] [端点关键字]` | 真实模型实跑，留档到 `examples/real-model/` | 是，`OR_KEY`（OpenRouter） |

`run-real-model.ts` 比较特殊：它用**一个 OpenRouter key**（`.env` 里的 `OR_KEY`，或 `OPENROUTER_API_KEY`）同时跑 OpenAI 协议和 Anthropic 协议两条链路。只跑某一个任务：`node --env-file=.env scripts/run-real-model.ts 02`。

---

## 6. CLI 选项全集

```
node src/cli.ts [选项] "<任务描述>"

  -w, --workspace <dir>   沙箱目录（默认 workspace）
  -p, --provider <name>   anthropic | openai | local | mock（默认取 $LLM_PROVIDER，否则 mock）
      --flavor <name>     local/openai 的口味：ollama | vllm | openai（local 默认 ollama）
      --base-url <url>    接口地址
      --model <name>      模型名
      --api-key <key>     API key（Ollama 忽略）
      --preset <name>     anthropic 端点预设：anthropic | kimi | glm | deepseek | minimax | custom
      --auth-token <tok>  只认 Authorization: Bearer 的网关
      --max-tokens <n>    anthropic 的 max_tokens
      --llm-stream        强制流式（Ollama 默认非流式）
      --max-steps <n>     最大轮数（默认 15）
      --no-write          禁止 write_file（用来测权限拒绝路径）
      --trace-dir <dir>   trace 输出目录（默认 traces）
  -s, --stream            流式打印模型输出
  -q, --quiet             只输出最终答案
  -h, --help              帮助
```

退出码：`0` 任务完成；`2` 未完成（达轮数上限 / 连续失败 / LLM 配置或调用出错）。运行中按一次 `Ctrl+C` 优雅中止（Trace 照样落盘），连按两次强制退出。

---

## 7. 建议的测试路线

1. **跑通框架**：`pnpm test`，看 23/23 是否全绿，再翻几个 `examples/*/trace.md` 看决策链。
2. **失败路径**（不需要 key，最能看出健壮性）：
   - 权限：`pnpm agent -- -p mock --no-write "把统计结果写入 report.md"` → 应明确报告"无写权限"，不假装写了。
   - 沙箱：任务里让它读 `../../etc/passwd` → 应被拒绝。
   - 死循环：`examples/09` 那个等锁的任务 → 应触发重复检测后终止，而不是耗满轮数。
   - 信息缺失：让它把销售额换算成美元（workspace 里没有汇率）→ 应拒绝猜测，不生成报告。
3. **接真模型**：按第 3 节配好 key，先跑 `-p anthropic "读取 data/sales.txt …"` 这条最短的，确认鉴权和 tool call 通了，再跑复杂任务。
4. **Web**：`pnpm web`，同时提交 2~3 个任务观察排队（`AGENT_WORKERS` 默认 2），运行中点"中止"，以及关闭页面是否也会中止。`MOCK_DELAY_MS=400 pnpm web` 能让 mock 变慢，方便观察。
5. **看 Trace**：任何一次运行的 `traces/trace-*.md` 都包含完整的决策 / 工具调用 / 结果 / 子 Agent 嵌套，用它核对最终答案里的数字是不是真从工具输出来的（或直接 `pnpm audit`）。

---

## 8. 常见问题

| 现象 | 原因 / 处理 |
|---|---|
| `node: bad option: --experimental-strip-types` 之类 | Node 版本太低，需要 ≥ 22.6，推荐 24：`node -v` |
| `pnpm agent -p mock "…"` 参数没生效 | 漏了 `--`，要写 `pnpm agent -- -p mock "…"` |
| 配了 `.env` 但读不到 | 没用 `node --env-file=.env` 启动；`pnpm agent`/`pnpm web` 不会自动加载 |
| `✖ LLM 配置错误: 未知 Anthropic 预设 …` | `--preset` 拼错，可选 anthropic / kimi / glm / deepseek / minimax / custom |
| 401 / 403 | key 没传到。确认优先级：命令行 > 环境变量；网关只认 Bearer 时用 `--auth-token` |
| 流式中途断开、解析报错 | 网关 SSE 不稳，加 `--llm-stream` 的反面：设 `ANTHROPIC_STREAM=false` 走非流式 |
| 本地模型一个工具都不调 | vLLM 启动缺 `--enable-auto-tool-choice --tool-call-parser <parser>`；Ollama 需换成支持 tool call 的模型 |
| workspace 被任务改乱了 | `pnpm reset-workspace`，或重跑 `node scripts/gen-workspace.ts` |
| Web 端口被占 | `PORT=3001 pnpm web` |

---

## 9. 安全提醒

- `.env` 已在 `.gitignore` 里，不会被提交；但**别把 key 写进 `.env.example`、README 或任何会提交的文件**。
- Agent 的文件读写被 `src/tools/sandbox.ts` 限制在 `-w` 指定的 workspace 内，越界会被拒绝（`examples/05` 就是这条路径的用例）。
- `--no-write` 可以整体关掉写文件能力；K8s 的 `apply_fix` 属于写权限动作，无写权限时会退化成"待人工确认"的建议。
