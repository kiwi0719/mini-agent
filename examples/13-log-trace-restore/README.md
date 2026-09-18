# 13-log-trace-restore

**类型**: 日志分析：按 traceId 还原完整链路

**任务**:

> 还原 traceId=t00002 的完整链路（logs/app.log）。

**校验**: ✅ 通过

**结果**: completed · 2 steps · 1 tool calls · 0 failures · 0 sub agents · tokens 652/160 · 1087ms

**最终答案**:

traceId=t00002 的链路（6 条日志，状态 FAILED）：

- 模块顺序：InventoryService → Database → Notification → Gateway
- 起止：2026-08-10 10:00:00.683 → 2026-08-10 10:00:03.942（总耗时 3256 ms）
- 各步耗时：Database 127ms，Database 116ms
- 错误：[Notification] call timeout after 3000ms target=notification-svc；[InventoryService] request failed error=timeout upstream=Notification；[Gateway] request failed status=504 totalCost=3256ms
- 告警：无

完整日志：
  logs/app.log:7 2026-08-10 10:00:00.683 INFO  [InventoryService] [traceId=t00002] request start userId=10849
  logs/app.log:8 2026-08-10 10:00:00.810 INFO  [Database] [traceId=t00002] query ok cost=127ms
  logs/app.log:9 2026-08-10 10:00:00.926 INFO  [Database] [traceId=t00002] query ok cost=116ms
  logs/app.log:10 2026-08-10 10:00:03.926 ERROR [Notification] [traceId=t00002] call timeout after 3000ms target=notification-svc
  logs/app.log:11 2026-08-10 10:00:03.929 ERROR [InventoryService] [traceId=t00002] request failed error=timeout upstream=Notification
  logs/app.log:12 2026-08-10 10:00:03.942 ERROR [Gateway] [traceId=t00002] request failed status=504 totalCost=3256ms

**生成文件**: （无）

**完整 Trace**: [trace.md](./trace.md) · [trace.json](./trace.json)
