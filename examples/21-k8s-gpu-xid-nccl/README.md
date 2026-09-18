# 21-k8s-gpu-xid-nccl

**类型**: K8s（AI Infra）：GPU Xid 79 → NCCL timeout，区分硬件根因与次生现象

**任务**:

> 帮我分析 train-job-7 为什么失败。

**校验**: ✅ 通过

**结果**: completed · 5 steps · 10 tool calls · 0 failures · 0 sub agents · tokens 10472/400 · 1859ms

**最终答案**:

## 故障现象
训练任务 train-job-7 在 step 1244 中止并反复重启，GPU 利用率掉到 0。

## 关键证据
- [Pod] 容器 trainer lastState.terminated.reason=Error exitCode=1，restartCount=2（get_pod）
- [Event] BackOff: Back-off restarting failed container trainer in pod train-job-7（count=4，get_pod_events）
- [Node] gpu-node-1: taints: nvidia.com/gpu:NoSchedule（get_node）
- [Metric] memory 峰值 90GiB / limit 128GiB（70%），cpu 峰值 12cores（get_metrics）
- [Metric] GPU 利用率从 96% 掉到 0%（get_metrics）
- [Log] 2026-09-18T08:51:12Z WARN  NVRM: Xid (PCI:0000:3b:00.0): 79, pid=2113, GPU has fallen off the bus. | 2026-09-18T08:51:14Z ERROR NCCL WARN [Rank 3] Timeout(ms)=600000 in operation AllReduce | 2026-09-18T08:51:14Z ERROR torch.distributed.DistBackendError: NCCL error: unhandled system error, NCCL versi（get_logs previous=true）
- [Runbook] GPU Xid 错误：症状：容器或节点日志出现 "NVRM: Xid (PCI:...): <code>"。Xid 79 = GPU has fallen off the bus（硬件/PCIe 故障）；Xid 13/31/43 多为应用侧非法访存；Xid 48…（search_runbook → k8s/runbooks/gpu.md）
- [Case] CASE-2026-077（2026-09-05）根因：GPU 硬件故障（PCIe 掉卡）；处理：cordon gpu 节点，更换 GPU，从 checkpoint 恢复训练（search_cases）

## 已确认事实
- Pod default/train-job-7 phase=Running，节点 gpu-node-1
- 容器上次终止原因 Error，exitCode 1，已重启 2 次
- Event BackOff 出现 4 次
- 节点 gpu-node-1 状态异常：taints: nvidia.com/gpu:NoSchedule

## 可能原因（推测）
- GPU PCI:0000:3b:00.0 硬件故障（Xid 79：GPU has fallen off the bus） · 置信度 高 · 依据：崩溃前日志先出现 NVRM Xid 79，随后 NCCL AllReduce 超时与 DistBackendError；GPU 利用率骤降
- NCCL 网络链路问题 · 置信度 低 · 依据：NCCL 超时是 Xid 之后的次生现象，无独立网络错误证据

## 处理建议
- cordon gpu-node-1，重置或更换故障 GPU
- 从 checkpoint step 1200 在健康节点恢复训练
- 把该卡加入硬件巡检
- 历史 Case CASE-2026-077 的处理方式可参考：cordon gpu 节点，更换 GPU，从 checkpoint 恢复训练

## 证据不足说明
无

**生成文件**: （无）

**完整 Trace**: [trace.md](./trace.md) · [trace.json](./trace.json)
