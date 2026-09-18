# 18-k8s-node-notready

**类型**: K8s：Node NotReady（日志取不到、指标中断本身就是证据）

**任务**:

> 帮我分析 job-124 为什么失败。

**校验**: ✅ 通过

**结果**: completed · 5 steps · 10 tool calls · 1 failures · 0 sub agents · tokens 5278/400 · 1495ms

**最终答案**:

## 故障现象
Pod job-124 所在节点 node-2 失去心跳，Pod 状态 Running 为过期缓存，实际不可用。

## 关键证据
- [Event] NodeNotReady: Node is not ready（count=1，get_pod_events）
- [Node] node-2: Ready=Unknown (NodeStatusUnknown)；taints: node.kubernetes.io/unreachable:NoExecute, node.kubernetes.io/unreachable:NoSchedule（get_node）
- [Metric] 无指标：指标采集在 08:35 之后中断（节点 node-2 停止上报）（get_metrics）
- [Log] 取日志失败：Error from server: Get "https://10.0.2.12:10250/containerLogs/default/job-124/etl": dial tcp 10.0.2.12:10250: i/o timeout（get_logs）
- [Runbook] Node NotReady：症状：Node Ready=Unknown/False，lastHeartbeatTime 停止更新超过 40s；节点被打上 node.kubernetes.io/unreachable taint；其上 Pod 出现 NodeNotRea…（search_runbook → k8s/runbooks/node.md）
- [Case] CASE-2026-052（2026-07-19）根因：云厂商宿主机故障导致节点失联；处理：cordon 节点，强制删除 Pod 让 Job 在其他节点重建，随后替换节点（search_cases）

## 已确认事实
- Pod default/job-124 phase=Running reason=NodeLost，节点 node-2
- Event NodeNotReady 出现 1 次
- 节点 node-2 状态异常：Ready=Unknown (NodeStatusUnknown)；taints: node.kubernetes.io/unreachable:NoExecute, node.kubernetes.io/unreachable:NoSchedule

## 可能原因（推测）
- 节点 node-2 的 kubelet 或宿主机故障 / 网络隔离 · 置信度 高 · 依据：Ready=Unknown、心跳停止、unreachable taint、NodeNotReady Event、日志端口 10250 超时、指标中断

## 处理建议
- 检查节点 node-2 的 kubelet 与云厂商状态
- kubectl cordon node-2，强制删除 Pod 让 Job 在健康节点重建
- 长期不恢复则 drain 并替换节点
- 历史 Case CASE-2026-052 的处理方式可参考：cordon 节点，强制删除 Pod 让 Job 在其他节点重建，随后替换节点

## 证据不足说明
无

**生成文件**: （无）

**完整 Trace**: [trace.md](./trace.md) · [trace.json](./trace.json)
