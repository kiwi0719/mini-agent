# 17-k8s-net-timeout-no-write

**类型**: K8s：连接超时诊断 + 修复需人工确认（无写权限 → apply_fix 被拒 → 转为待确认建议）

**任务**:

> 帮我分析 api-worker-7 为什么不 ready，并修复。

**校验**: ✅ 通过

**结果**: completed · 7 steps · 12 tool calls · 1 failures · 0 sub agents · tokens 19113/560 · 1932ms

**最终答案**:

## 故障现象
Pod api-worker-7 运行中但持续未 Ready，就绪探针返回 503。

## 关键证据
- [Event] Unhealthy: Readiness probe failed: HTTP probe failed with statuscode: 503（count=41，get_pod_events）
- [Metric] memory 峰值 210MiB / limit 1024MiB（21%），cpu 峰值 0.05cores（get_metrics）
- [Log] 2026-09-18T08:21:30Z ERROR db ping failed: dial tcp 10.0.5.12:5432: i/o timeout | 2026-09-18T08:21:40Z ERROR db ping failed: dial tcp 10.0.5.12:5432: i/o timeout | 2026-09-18T08:21:50Z WARN  readiness check: dependency payment-db unavailable, reporting 503（get_logs）
- [Runbook] 服务连接超时 / 就绪探针失败：症状：Pod Running 但 Ready=False；Event Unhealthy "Readiness probe failed"，count 持续增长；容器日志出现 dial tcp <ip>:<port>: i/o timeou…（search_runbook → k8s/runbooks/network.md）
- [Case] CASE-2026-071（2026-08-28）根因：payment-db 所在节点 NetworkPolicy 变更后拒绝了 default 命名空间流量；处理：回滚 NetworkPolicy（search_cases）

## 已确认事实
- Pod default/api-worker-7 phase=Running，节点 node-1
- Event Unhealthy 出现 41 次
- 节点 node-1 Ready=True，无资源压力

## 可能原因（推测）
- 依赖 10.0.5.12:5432 不可达（网络策略 / 依赖宕机） · 置信度 高 · 依据：日志连续 dial tcp 10.0.5.12:5432 i/o timeout；Unhealthy Event 持续累计；本 Pod CPU/内存正常，问题不在自身
- DNS 或 NetworkPolicy 变更 · 置信度 中 · 依据：历史 Case 中同类症状由 NetworkPolicy 变更引起，需核实近期变更

## 处理建议
- 【待人工确认执行】restart_dependency：重启 payment-db（10.0.5.12:5432）所在的 StatefulSet 并检查其 NetworkPolicy（`kubectl rollout restart statefulset/payment-db -n data`）—— 本次未获写权限，未执行：工具 "apply_fix" 需要写权限，当前未授权 (--allow-write)
- 检查 10.0.5.12:5432 对应的 Service / Pod 是否健康，以及 NetworkPolicy、安全组
- 重启本 Pod 无效，先修复依赖
- 为依赖不可用配置降级，避免整个服务不 Ready
- 历史 Case CASE-2026-071 的处理方式可参考：回滚 NetworkPolicy

## 证据不足说明
无

**生成文件**: （无）

**完整 Trace**: [trace.md](./trace.md) · [trace.json](./trace.json)
