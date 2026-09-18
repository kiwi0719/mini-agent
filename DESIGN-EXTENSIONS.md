# 扩展方案：日志分析工具包 + Kubernetes 故障诊断工具包

> 状态：**已实现**（2026-09-19）。两道新题目作为普通工具直接注册进现有 Mini Agent，不另起项目。
> 与初稿的差异：候选人否决了"工具包 + 注册开关"，改为直接注册；所有加分项都做了（除需要真实环境的 Prometheus / Loki / OTel）；没有 K8s 集群，用 Mock 集群替代（§3.1）。

## 实现速览

| 文件 | 内容 |
|---|---|
| `src/tools/log-tools.ts` | 容错解析器 + `log_stats` `log_latency` `log_trace` `log_errors` `log_timeline` |
| `scripts/gen-logs.ts` | 测试日志生成（1 万行，剧本占比见 §2.4） |
| `src/tools/k8s/cluster.ts` | `ClusterSource` 接口 + `MockClusterSource`（fixture + 修复动作叠加） |
| `src/tools/k8s-tools.ts` | `get_pod` `get_pod_events` `get_node` `get_metrics` `get_logs` + `search_runbook` `search_cases` `propose_fix` `apply_fix` `verify_fix` |
| `scripts/gen-k8s.ts` | Mock 集群：4 节点、8 Pod（7 个故障场景）、5 份 runbook、6 个历史 Case |
| `src/agent.ts` | 系统提示新增第 9/10 条：日志分析流程、K8s 诊断固定输出结构 |
| `src/llm/mock-scenarios.ts` | Mock LLM 的两个剧本（启发式诊断，仅用于演示 Loop 与工具） |
| `web/index.html` | 最终答案按 `## ` 区块渲染为诊断结果卡片，证据带 [Pod/Event/Node/Metric/Log/Runbook/Case] 标签 |
| `scripts/run-examples.ts` | 新增示例 12–21（全部带自动校验） |

## 0. 可行性结论

| 题目 | 能否作为工具接入 | 契合度 | 主要缺口 |
|---|---|---|---|
| 应用日志智能分析 | 能 | 高：输入是 workspace 内的文件，天然走 `read` 权限 + 沙箱；输出报告走已有 `write_file` | 需要一组“分析型”工具（解析 / 统计 / 耗时 / 链路 / 归纳）+ 日志生成脚本 |
| K8s 故障诊断 SRE Agent | 能 | 高：题目要的“Agent 自己决定查什么”“保存诊断过程”“展示工具调用与结果”正是现有 Loop + Trace + Web 时间线已经做的 | 需要 Mock 集群数据源 + 5 个查询工具 + 诊断结论的结构化输出规范 + 前端诊断结果页 |

框架里现成可以复用、不用改的机制：

- **Tool 接口 / registry**：schema 校验、权限、超时、幂等重试 → 新工具只需实现 `execute`。
- **deferred + search_tools**：两个工具包默认不进 prompt，按任务发现并激活，控制每轮 schema 体积。
- **update_plan**：多步诊断先出计划、证据不足时修订。
- **delegate**：日志题里“按模块并行分析”、K8s 题里“并行查 Pod / Node / Metrics”可以派子 Agent。
- **Trace（JSON + Markdown）**：就是题目要求的“保存一次完整诊断过程 / 展示调用了哪些工具 / 查看每次工具调用结果”。
- **Web SSE 时间线**：工具调用与结果已可视化；只需新增一个“诊断结果卡片”。
- **permission: 'write'**：K8s 加分项“修复动作执行前需要人工确认”直接映射为 write 类工具 + `allowWrite` 门控。

需要新增的横切能力：

1. **结构化最终答案**：K8s 诊断任务的最终答案以 Markdown 固定章节输出，前端按章节渲染（详见 §3.4）。
2. ~~工具包注册开关~~：候选人决定直接注册（15 个新工具始终对模型可见，`createDefaultRegistry` 一处注册）。
3. **Mock LLM 新场景**：当前无有效 key，端到端验证靠 Mock 脚本（`mock-scenarios.ts`）。

## 1. 目录规划

```
src/tools/
├── log-tools.ts             # 解析器 + 5 个日志工具
├── k8s-tools.ts             # 10 个 K8s 工具
└── k8s/cluster.ts           # ClusterSource 接口 + MockClusterSource
scripts/
├── gen-logs.ts              # 测试日志生成脚本（题目要求提交）
└── gen-k8s.ts               # 生成 Mock 集群（7 个场景）+ runbooks + cases
workspace/
├── logs/app.log             # 生成的日志（1 万行）
└── k8s/
    ├── cluster.json         # 一个集群：nodes / pods / events / metrics / logs / remediations
    ├── applied.json         # apply_fix 记录（运行时生成）
    ├── runbooks/*.md        # 知识库（oom / node / scheduling / network / gpu）
    └── cases.json           # 历史 Case
```

实际实现把所有场景放进**同一个 Mock 集群**（不同 Pod 名），比"每场景一个目录"更接近真实：Agent 面对的是一个有 8 个 Pod、4 个节点的集群，要靠 Pod 名和证据自己找。

## 2. 日志分析工具包

### 2.1 解析器（parser.ts）

```
2026-08-10 10:00:01.123 INFO  [UserService] [traceId=abc001] load user success cost=108ms
└──── ts ─────────────┘ └lvl┘ └─ module ─┘ └── traceId ──┘ └────── message ──────┘ kv: cost=108
```

- 主正则匹配 `ts level [module] [traceId=…] message`；每个字段独立可选。
- **容错分级**：`ok`（全字段）/ `partial`（缺 module 或 traceId 或 ts 无法解析）/ `malformed`（连级别都识别不出）。三类都计数，`malformed` 行保留原文前 200 字符样本，不丢弃、不中断。
- 从 message 里抽 `key=value` 对（`cost=108ms`、`totalCost=1410ms`、`status=500`、`error=database_timeout`），耗时统一转成毫秒数。
- 流式逐行读取（`readline` over `createReadStream`），单遍扫描，内存只保留聚合结果与有限样本 → 满足“超大文件性能优化”的基本要求。

### 2.2 工具清单

所有工具 `permission: 'read'`、`idempotent: true`、`deferred: true`。输入统一带 `paths: string[]`（相对 workspace，支持 glob，多文件），输出 JSON。

| 工具 | 输入 | 输出（要点） | 覆盖题目要求 |
|---|---|---|---|
| `log_stats` | paths | 总行数、按级别计数、按模块 `{total, error, errorRate}`、解析质量 `{ok, partial, malformed, samples}`、时间范围 | 1、2、3、格式容错 |
| `log_latency` | paths, `field?`(默认 totalCost/cost), `group_by?`(module) | avg / p50 / p95 / p99 / max、样本数、Top N 慢请求 `[{traceId, module, cost, ts}]` | 4、Top N 慢请求 |
| `log_trace` | paths, traceId | 该 traceId 全部日志按时间排序，附 span 摘要（起止、总耗时、涉及模块、是否含 ERROR） | 5 |
| `log_errors` | paths, `top?` | 错误归一化聚类：把 message 中的数字 / id / traceId 替换为占位符后分组，输出 `{pattern, count, modules, sampleTraceIds, firstSeen, lastSeen}` | 6、7、相似错误聚类、自动发现异常模式 |
| `log_timeline` | paths, `bucket_seconds?`(60) | 按时间桶统计各级别数量与 p95，并用 mean+2σ 标出 ERROR 突增桶 | 时间趋势分析、自动发现异常模式 |

分位数计算：全量收集耗时数组后排序取分位（1–2 万行没有压力）；`log_latency` 预留 `reservoir` 参数以便超大文件改用蓄水池采样。

### 2.3 Agent 端流程（由模型决定，不硬编码）

任务示例：`分析 logs/app-2026-08-10.log，生成 logs/report.md，重点说明错误和慢请求`。

期望路径：`update_plan` → `search_tools("日志 分析")` 激活工具包 → 一轮并行调 `log_stats` + `log_latency` + `log_errors` → 对 Top 错误簇的 sampleTraceIds 调 `log_trace` 还原链路 → 汇总归纳 → `write_file` 写 Markdown 报告。

报告章节（写进系统提示的“报告模板”）：概览 / 级别与模块统计（表格）/ 耗时分位与 Top 慢请求 / 异常聚类与代表链路 / 问题归纳与可能根因 / 数据质量（malformed、字段缺失比例）。

“问题归纳”分两层：工具层做 **规则归纳**（错误簇 + 同 traceId 内的 WARN slow query → 标记 `likelyCause: database`），模型层做 **语言总结**（即题目的可选项“使用 LLM 总结异常原因 / Root Cause 候选”），报告里明确标注哪些是统计事实、哪些是推断。

### 2.4 测试日志生成（scripts/gen-logs.ts）

参数：行数（默认 10 000）、模块列表（8 个：Gateway/UserService/OrderService/PaymentService/InventoryService/Database/Cache/Notification）、traceId 数（≥ 300）、随机种子。

每条请求按权重抽一种剧本：

| 剧本 | 占比 | 生成内容 |
|---|---|---|
| 正常 | 70% | start → 2–4 个模块调用（cost 5–150ms）→ end totalCost |
| 慢请求 | 10% | 其中一段 cost 500–3000ms，Database 打 WARN slow query |
| timeout | 6% | ERROR error=timeout + Gateway status=504 |
| database error | 6% | WARN slow query → ERROR database_timeout / connection_refused → Gateway 500 |
| network error | 5% | ERROR error=connection_reset / dns_failure |
| 异常格式 | 3% | 缺 traceId、缺 module、时间戳格式错、纯文本堆栈行、空行、被截断的半行 |

时间分布上刻意在某 10 分钟内集中投放 database error，让趋势分析有东西可看。

## 3. Kubernetes 故障诊断工具包

### 3.1 没有 K8s 集群的替代方案：Mock 数据源（k8s/cluster.ts）

数据全部来自 `workspace/k8s/cluster.json`（由 `scripts/gen-k8s.ts` 确定性生成），工具按 namespace + 资源名定位。这样：

- 不需要真实集群；
- 数据经过沙箱路径检查；
- 想换成真实 `kubectl` / Prometheus / Loki 时，只替换 `ClusterSource` 接口的实现（`MockClusterSource` → `KubectlSource`），工具代码不变。

```ts
interface ClusterSource {
  getPod(ns, name): Promise<PodStatus | null>;
  getPodEvents(ns, name): Promise<K8sEvent[]>;
  getNode(name): Promise<NodeStatus | null>;
  getMetrics(ns, name, window?): Promise<MetricSeries>;
  getLogs(ns, name, opts: { container?, tail?, previous? }): Promise<string>;
}
```

### 3.2 工具清单（必选 5 个）

| 工具 | 输入 | 输出要点 |
|---|---|---|
| `get_pod` | namespace, name | phase、containerStatuses（state / lastState.terminated.reason 如 OOMKilled、exitCode、restartCount）、resources requests/limits、nodeName、conditions（PodScheduled=False 及 message）|
| `get_pod_events` | namespace, name | 按时间排序的 Event：type、reason（FailedScheduling / Evicted / BackOff / Unhealthy …）、message、count |
| `get_node` | name | Ready / DiskPressure / MemoryPressure conditions、allocatable、taints、kubelet 心跳时间 |
| `get_metrics` | namespace, name, window | CPU / Memory 时间序列 + 峰值、limit 占比（OOM 场景中 memory 逼近 limit） |
| `get_logs` | namespace, name, tail, previous | 容器日志文本；网络超时场景里出现 `dial tcp … i/o timeout`，OOM 场景 previous=true 才能看到崩溃前日志 |

全部 `permission: 'read'`、`idempotent: true`，同一工具包 deferred 激活。`get_pod` 找不到资源时返回 `is_error` 并附同 namespace 下的相似名字，让模型自己纠正。

### 3.3 五类故障场景的数据设计（证据链）

| 故障 | Pod | Events | Node | Metrics | Logs |
|---|---|---|---|---|---|
| OOMKilled | lastState.terminated.reason=OOMKilled, restartCount=5, limit 512Mi | BackOff | 正常 | memory 曲线爬到 510Mi | previous 日志：加载大文件 |
| Node NotReady | phase=Running 但 status Unknown | NodeNotReady, TaintManagerEviction | Ready=False, 心跳停止 10 min | 采集中断（空序列，工具明确返回 `no data`） | 无（工具返回连接节点失败） |
| Scheduling Failed | phase=Pending, PodScheduled=False | FailedScheduling: 0/3 nodes available: insufficient cpu / node(s) had taint | 3 个节点 allocatable 不足或带 taint | 无（未运行） | 无 |
| DiskPressure | phase=Failed, reason=Evicted | Evicted: The node had condition: [DiskPressure] | DiskPressure=True, ephemeral-storage 使用 97% | 正常 | 日志末尾 `no space left on device` |
| 网络/服务连接超时 | Running，就绪探针失败 | Unhealthy: readiness probe failed | 正常 | CPU 低 | `dial tcp 10.0.5.12:5432: i/o timeout` 连续出现 |

每个场景再各放一个**干扰项**（例如 OOM 场景里有一条无关的 SandboxChanged Event，DiskPressure 场景里有 DNSConfigForming），并额外准备 **证据不足场景**（job-128：Failed exitCode=1，Event 已清理，日志为空，无指标）用来测试"不强行下结论"，以及 **GPU 场景**（train-job-7：previous 日志里 NVRM Xid 79 → NCCL AllReduce timeout，GPU 利用率骤降）。

**修复闭环的模拟**：`cluster.json` 里每个 Pod 带 `remediations[]`（动作、说明、风险、等价 kubectl 命令、执行后的 Pod/Node/Event 状态）。`apply_fix` 把动作记入 `applied.json`，之后 `get_pod` / `get_node` / `verify_fix` 读取时叠加该状态，于是"修复后自动检查是否恢复"是真的重新查询而不是假装。

**接真实集群**：实现 `ClusterSource` 的 `KubectlSource`（`kubectl get -o json` / metrics-server / `kubectl logs`）或 Prometheus/Loki 版本，`createClusterSource()` 按环境变量切换；工具与 Agent 代码不变。这是本次没做的部分。

### 3.4 诊断结论的结构化输出

系统提示（K8s 包激活后由 `registerK8sPack` 追加到 system prompt）规定最终答案必须是以下 Markdown 结构，前端把它渲染为“诊断结果页”：

```
## 故障现象
## 关键证据
- [Event] …   - [Metric] …   - [Log] …   - [Pod] …   （每条标明来源工具）
## 已确认事实
## 可能原因（推测）
- 原因 / 置信度 高|中|低 / 依据
## 处理建议
## 证据不足说明（无则写“无”）
```

“已确认事实”只能引用工具返回的原文；“可能原因”必须写置信度和依据；证据不足时“可能原因”允许为空，但必须在最后一节说明还需要哪些信息（例如“需要节点 kubelet 日志”）。这是题目里“明确区分已确认事实与推测”“无法确定时明确说明”的落点。

### 3.5 过程留存与前端

- **保存完整诊断过程**：现有 Trace 已满足；给 `trace.ts` 增加 `tags: ['k8s']` 便于在 Trace 列表里筛选。
- **展示调用了哪些工具 / 每次结果**：现有 Web 时间线已满足；工具结果卡片对 JSON 做折叠展示。
- **诊断结果页**：`web/index.html` 新增一个 `DiagnosisPanel` 组件，`final` 事件到达后解析上述章节渲染成卡片；证据条目按来源打 tag 颜色。对日志包同样复用，渲染“分析报告”。

### 3.6 加分项映射

| 加分项 | 方案 | 成本 |
|---|---|---|
| 故障知识库 / RAG | `search_runbook(query)`：`workspace/k8s/runbooks/*.md`，关键词打分（复用 registry.search 的思路），返回匹配段落；有 embedding 接口时可换实现 | 低 |
| 历史相似 Case | `search_cases(symptoms)`：读取 `traces/` 中带 k8s tag 的历史诊断结果，按“证据关键词”相似度返回 | 中 |
| 自动修复 + 人工确认 | `propose_fix`（read，只生成方案：如调大 memory limit、驱逐/重建、cordon 节点）→ `apply_fix`（**write**，受 `allowWrite` 门控；Web 端未勾选时返回“需要人工确认”，模型把方案写进处理建议） | 低（机制现成） |
| 修复后自动检查 | `verify_fix`：对 Mock 数据源切换到 `<scenario>-fixed` 目录再查一次 pod，输出前后对比 | 低 |
| 故障复盘报告 | 诊断完成后调 `write_file` 写 `k8s/postmortem-<pod>.md`（时间线 + 证据 + 根因 + 改进项） | 低 |
| Prometheus / Loki / OTel | `ClusterSource` 的另一实现，只在有真实环境时做 | 高，本次不做 |
| GPU Xid / NCCL | 追加第 6 类场景：`get_logs` 出现 `NVRM: Xid (PCI:…): 79` + `NCCL WARN … timeout`，runbook 里放对应条目 | 中 |

## 4. 实施结果

按 §1–§3 实现，示例 12–21（见 `examples/`）全部自动校验通过；Web 端新增诊断结果卡片。加分项：知识库检索、历史 Case、propose/apply/verify 修复闭环（apply 走写权限 = 人工确认）、复盘报告、GPU Xid/NCCL 场景均已实现；Prometheus / Loki / OTel 未做（需要真实环境，接口已预留）。

## 5. 风险与限制

- **仍然没有可用的模型 key**：Agent"自主决定查什么"的效果只能靠 Mock 脚本演示；`mock-scenarios.ts` 里的 `diagnose()` 是启发式规则，不代表真实模型的推理。系统提示里的第 9/10 条是给真实模型的流程与输出约束，未经真实模型验证。
- **Mock 集群与真实集群差距**：数据是静态快照，没有时间推进；`verify_fix` 是切换目录模拟。
- **日志解析器只面向题目给的格式族**：字段顺序变化可容错，但完全不同的格式（JSON 日志）需要另加解析器分支。
- **Web 端仍是单任务无鉴权**，沿用现有限制。
