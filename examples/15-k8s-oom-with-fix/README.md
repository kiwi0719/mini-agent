# 15-k8s-oom-with-fix

**类型**: K8s：OOMKilled → previous 日志 → runbook/case → propose_fix → apply_fix（写）→ verify_fix → 复盘报告

**任务**:

> 帮我分析 job-123 为什么失败，并修复它。

**校验**: ✅ 通过

**结果**: completed · 9 steps · 15 tool calls · 0 failures · 0 sub agents · tokens 28718/720 · 2020ms

**最终答案**:

## 故障现象
Pod job-123 反复重启（restartCount=5），容器被内核 OOM Killer 杀死，处于 CrashLoopBackOff。

## 关键证据
- [Pod] 容器 report-builder lastState.terminated.reason=OOMKilled exitCode=137，restartCount=5（get_pod）
- [Event] BackOff: Back-off restarting failed container report-builder in pod job-123（count=12，get_pod_events）
- [Metric] memory 峰值 511MiB / limit 512MiB（100%），cpu 峰值 0.5cores（get_metrics）
- [Log] 2026-09-18T08:43:55Z WARN  heap usage 498 MiB of 512 MiB limit（get_logs previous=true）
- [Runbook] OOMKilled：症状：容器 lastState.terminated.reason=OOMKilled，exitCode=137，restartCount 持续增长，Event 出现 BackOff；内存指标峰值逼近 limit。…（search_runbook → k8s/runbooks/oom.md）
- [Case] CASE-2026-041（2026-07-03）根因：月末数据量翻倍，整表加载进内存超过 limit；处理：memory limit 512Mi → 2Gi，并改为分批读取（search_cases）
- [Pod] 修复后 phase=Running，containersReady=report-builder:true，recovered=true（verify_fix）

## 已确认事实
- Pod default/job-123 phase=Running，节点 node-1
- 容器上次终止原因 OOMKilled，exitCode 137，已重启 5 次
- Event BackOff 出现 12 次
- 节点 node-1 Ready=True，无资源压力

## 可能原因（推测）
- 应用工作集超过 memory limit 512Mi · 置信度 高 · 依据：terminated.reason=OOMKilled、内存峰值达 limit 的 100%、崩溃前日志显示在加载大数据集
- 数据量增长或内存泄漏导致占用持续上升 · 置信度 中 · 依据：内存曲线单调上升而非平台期；需对比历史批次数据量

## 处理建议
- 已执行 increase_memory_limit 并复查恢复（recovered=true）。
- 临时：把 memory limit 从 512Mi 提高（如 2Gi）并重建 Pod
- 根本：分批加载数据 / 排查泄漏；配置 VPA 推荐值
- 注意 exitCode 137 也可能来自驱逐，此处 reason 明确为 OOMKilled
- 历史 Case CASE-2026-041 的处理方式可参考：memory limit 512Mi → 2Gi，并改为分批读取
- 复盘报告已写入 k8s/postmortem-job-123.md

## 证据不足说明
无

**生成文件**: [k8s/postmortem-job-123.md](./postmortem-job-123.md)

**完整 Trace**: [trace.md](./trace.md) · [trace.json](./trace.json)
