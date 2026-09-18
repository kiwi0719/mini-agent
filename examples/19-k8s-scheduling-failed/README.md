# 19-k8s-scheduling-failed

**类型**: K8s：Scheduling Failed（Pending + FailedScheduling message 逐节点原因）

**任务**:

> 帮我分析 job-125 为什么失败。

**校验**: ✅ 通过

**结果**: completed · 5 steps · 10 tool calls · 0 failures · 0 sub agents · tokens 5448/400 · 1408ms

**最终答案**:

## 故障现象
Pod job-125 一直 Pending，调度器找不到满足条件的节点。

## 关键证据
- [Event] FailedScheduling: 0/4 nodes are available: 1 node(s) had untolerated taint {node.kubernetes.io/unreachable: }, 1 node(s) had untolerated taint {node.kubernetes.io/disk-pressure: （count=27，get_pod_events）
- [Metric] 无指标：Pod 处于 Pending，从未运行，没有指标（get_metrics）
- [Log] 日志为空（get_logs）
- [Runbook] Scheduling Failed / Pending：症状：Pod phase=Pending，PodScheduled=False reason=Unschedulable；Event FailedScheduling 的 message 给出每个节点被排除的原因（Insufficient …（search_runbook → k8s/runbooks/scheduling.md）
- [Case] CASE-2026-058（2026-08-02）根因：Job 申请 6 核 CPU，集群单节点最多 4 核；处理：降低 cpu request 到 3 核（search_cases）

## 已确认事实
- Pod default/job-125 phase=Pending，节点 未调度
- Event FailedScheduling 出现 27 次

## 可能原因（推测）
- 请求 cpu=6 超过任何单节点的可用量 · 置信度 高 · 依据：FailedScheduling: 0/4 nodes are available: 1 node(s) had untolerated taint {node.kubernetes.io/unreachable: }, 1 node(s) had untolerated t；节点列表显示健康节点 allocatable 4 核已分配 3.2 核
- 其余节点因 taint（unreachable / disk-pressure / gpu）被排除 · 置信度 高 · 依据：FailedScheduling message 逐个列出了 untolerated taint

## 处理建议
- 降低 cpu request（例如 3 核）或扩容更大规格节点
- 不要给 Pod 加 toleration 绕过 unreachable/disk-pressure 节点，那些节点本身有故障
- 历史 Case CASE-2026-058 的处理方式可参考：降低 cpu request 到 3 核

## 证据不足说明
无

**生成文件**: （无）

**完整 Trace**: [trace.md](./trace.md) · [trace.json](./trace.json)
