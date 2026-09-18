# 调度类故障

## Scheduling Failed / Pending
症状：Pod phase=Pending，PodScheduled=False reason=Unschedulable；Event FailedScheduling 的 message 给出每个节点被排除的原因（Insufficient cpu/memory、untolerated taint、node affinity 不匹配、PVC 未绑定）。
确认方法：get_pod_events 读 FailedScheduling message；get_node 逐个核对 allocatable-allocated 与 taints。
处理：按 message 对症：降低 request、扩容节点、为 Pod 加 toleration / 修改 nodeSelector、解除节点污点或压力。
注意：request 大于任何单节点 allocatable 时无论如何扩容同规格节点都不会成功。
