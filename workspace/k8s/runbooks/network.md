# 网络 / 依赖类故障

## 服务连接超时 / 就绪探针失败
症状：Pod Running 但 Ready=False；Event Unhealthy "Readiness probe failed"，count 持续增长；容器日志出现 dial tcp <ip>:<port>: i/o timeout 或 connection refused；CPU / 内存指标正常。
确认方法：get_logs 找连接失败的目标地址；确认该地址对应的 Service/Pod 是否健康；检查 NetworkPolicy、DNS、安全组。
处理：1) 修复或重启目标依赖；2) 检查 NetworkPolicy 是否放行；3) 调整探针超时与依赖降级策略。
注意：重启本 Pod 通常无效，问题在依赖侧。
