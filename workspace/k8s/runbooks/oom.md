# 内存类故障

## OOMKilled
症状：容器 lastState.terminated.reason=OOMKilled，exitCode=137，restartCount 持续增长，Event 出现 BackOff；内存指标峰值逼近 limit。
确认方法：get_pod 看终止原因；get_metrics 看 memory peak 与 limit 占比；get_logs previous=true 看崩溃前的行为（大数据集加载、缓存膨胀）。
处理：1) 临时提高 memory limit（保持 request≈limit 的 Guaranteed QoS）；2) 排查内存泄漏或分批处理数据；3) 配置 VPA 推荐值。
注意：exitCode=137 也可能是节点驱逐或手动 kill，需结合 reason 字段判断。

## MemoryPressure（节点级）
症状：Node condition MemoryPressure=True，多个 Pod 被 Evicted，reason 含 "low on resource: memory"。
处理：驱逐低优先级 Pod、增加节点内存、设置合理的 request 避免超卖。
