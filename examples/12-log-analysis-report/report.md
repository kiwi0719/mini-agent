# 应用日志分析报告

- 文件：logs/app.log（842 KB，9988 行，空行 12）
- 时间范围：2026-08-10 10:00:00.545 ~ 2026-08-10 10:15:27.673
- traceId 数：1919

## 1. 日志级别统计

| 级别 | 数量 |
|---|---|
| INFO | 8502 |
| ERROR | 1039 |
| WARN | 425 |

## 2. 按模块统计

| 模块 | 日志数 | WARN | ERROR | ERROR 比例 |
|---|---|---|---|---|
| Gateway | 1351 | 25 | 436 | 32.27% |
| UserService | 976 | 0 | 127 | 13.01% |
| OrderService | 1017 | 0 | 123 | 12.09% |
| PaymentService | 950 | 0 | 108 | 11.37% |
| InventoryService | 1314 | 15 | 102 | 7.76% |
| Database | 2439 | 307 | 86 | 3.53% |
| Cache | 1524 | 48 | 47 | 3.08% |
| Notification | 379 | 14 | 10 | 2.64% |
| (unknown) | 38 | 16 | 0 | 0% |

## 3. 请求耗时（totalCost）

| 指标 | 值 (ms) |
|---|---|
| 样本数 | 2117 |
| 平均 | 702 |
| P50 | 281 |
| P95 | 3048 |
| P99 | 3206 |
| 最大 | 3345 |

慢请求（≥ 1000ms）：482 个，占 22.77%

### 按模块 P95

| 模块 | 样本 | 平均 | P95 | P99 |
|---|---|---|---|---|
| Gateway | 662 | 1277.2 | 3167 | 3295 |
| InventoryService | 337 | 469.4 | 2482 | 2945 |
| UserService | 363 | 468.8 | 2203 | 2992 |
| OrderService | 386 | 433.8 | 1844 | 2808 |
| PaymentService | 369 | 392.5 | 1388 | 3111 |

### Top 5 慢请求

| traceId | 模块 | 时间 | 耗时 (ms) | 级别 |
|---|---|---|---|---|
| t00142 | Gateway | 2026-08-10 10:01:12.601 | 3345 | ERROR |
| t00460 | Gateway | 2026-08-10 10:03:35.904 | 3341 | ERROR |
| t01838 | Gateway | 2026-08-10 10:14:40.580 | 3341 | ERROR |
| t00916 | Gateway | 2026-08-10 10:07:14.296 | 3335 | ERROR |
| t01596 | Gateway | 2026-08-10 10:12:42.224 | 3335 | ERROR |

## 4. 异常汇总与聚类（共 1039 条 ERROR，涉及 438 个请求）

### 4.1 request failed status=500 totalCost=<dur>

- 次数：223（223 个请求）· 模块：Gateway×223
- 时间：2026-08-10 10:00:01.844 ~ 2026-08-10 10:14:45.606
- 样本：`2026-08-10 10:00:01.844 ERROR [Gateway] [traceId=t00004] request failed status=500 totalCost=804ms`
- 同链路伴随 WARN：[Database] slow query cost=<dur> sql=update_inventory（100% 的请求）
- **候选原因（推测）**：推测：数据库慢查询拖垮上游（同链路伴随 slow query）

### 4.2 request failed status=504 totalCost=<dur>

- 次数：100（100 个请求）· 模块：Gateway×100
- 时间：2026-08-10 10:00:03.942 ~ 2026-08-10 10:15:09.936
- 样本：`2026-08-10 10:00:03.942 ERROR [Gateway] [traceId=t00002] request failed status=504 totalCost=3256ms`
- **候选原因（推测）**：推测：网关层汇报的上游失败，需看同 traceId 的上游错误

### 4.3 request failed status=502 totalCost=<dur>

- 次数：89（89 个请求）· 模块：Gateway×89
- 时间：2026-08-10 10:00:13.548 ~ 2026-08-10 10:15:21.197
- 样本：`2026-08-10 10:00:13.548 ERROR [Gateway] [traceId=t00029] request failed status=502 totalCost=310ms`
- **候选原因（推测）**：推测：网关层汇报的上游失败，需看同 traceId 的上游错误

### 4.4 query failed error=deadlock_detected retries=#

- 次数：82（82 个请求）· 模块：UserService×25，OrderService×24，PaymentService×17，InventoryService×16
- 时间：2026-08-10 10:00:18.392 ~ 2026-08-10 10:12:52.501
- 样本：`2026-08-10 10:00:18.392 ERROR [UserService] [traceId=t00039] query failed error=deadlock_detected retries=2`
- 同链路伴随 WARN：[Database] slow query cost=<dur> sql=update_inventory（100% 的请求）
- **候选原因（推测）**：推测：数据库慢查询拖垮上游（同链路伴随 slow query）

### 4.5 query failed error=database_timeout retries=#

- 次数：71（71 个请求）· 模块：InventoryService×14，OrderService×22，UserService×20，PaymentService×15
- 时间：2026-08-10 10:00:01.837 ~ 2026-08-10 10:14:45.605
- 样本：`2026-08-10 10:00:01.837 ERROR [InventoryService] [traceId=t00004] query failed error=database_timeout retries=2`
- 同链路伴随 WARN：[Database] slow query cost=<dur> sql=update_inventory（100% 的请求）
- **候选原因（推测）**：推测：数据库慢查询拖垮上游（同链路伴随 slow query）

### 4.6 query failed error=connection_pool_exhausted retries=#

- 次数：70（70 个请求）· 模块：OrderService×18，InventoryService×10，UserService×20，PaymentService×22
- 时间：2026-08-10 10:00:08.957 ~ 2026-08-10 10:14:09.667
- 样本：`2026-08-10 10:00:08.957 ERROR [OrderService] [traceId=t00020] query failed error=connection_pool_exhausted retries=2`
- 同链路伴随 WARN：[Database] slow query cost=<dur> sql=update_inventory（100% 的请求）
- **候选原因（推测）**：推测：数据库慢查询拖垮上游（同链路伴随 slow query）

## 5. 代表链路还原

### traceId=t00004（FAILED，804 ms，InventoryService → Notification → Database → Gateway）

```text
2026-08-10 10:00:01.025 INFO  [InventoryService] [traceId=t00004] request start userId=10427
2026-08-10 10:00:01.072 INFO  [Notification] [traceId=t00004] call send cost=47ms
2026-08-10 10:00:01.818 WARN  [Database] [traceId=t00004] slow query cost=746ms sql=update_inventory
2026-08-10 10:00:01.837 ERROR [InventoryService] [traceId=t00004] query failed error=database_timeout retries=2
2026-08-10 10:00:01.844 ERROR [Gateway] [traceId=t00004] request failed status=500 totalCost=804ms
```

### traceId=t00002（FAILED，3256 ms，InventoryService → Database → Notification → Gateway）

```text
2026-08-10 10:00:00.683 INFO  [InventoryService] [traceId=t00002] request start userId=10849
2026-08-10 10:00:00.810 INFO  [Database] [traceId=t00002] query ok cost=127ms
2026-08-10 10:00:00.926 INFO  [Database] [traceId=t00002] query ok cost=116ms
2026-08-10 10:00:03.926 ERROR [Notification] [traceId=t00002] call timeout after 3000ms target=notification-svc
2026-08-10 10:00:03.929 ERROR [InventoryService] [traceId=t00002] request failed error=timeout upstream=Notification
2026-08-10 10:00:03.942 ERROR [Gateway] [traceId=t00002] request failed status=504 totalCost=3256ms
```

## 6. 时间趋势（每 60s）

| 时间桶 | 总数 | ERROR | WARN | P95 (ms) |
|---|---|---|---|---|
| 2026-08-10 10:00:00 | 628 | 54 | 20 | 3059 |
| 2026-08-10 10:01:00 | 654 | 50 | 20 | 3004 |
| 2026-08-10 10:02:00 | 736 | 55 | 14 | 3060 |
| 2026-08-10 10:03:00 | 566 | 44 | 19 | 3079 |
| 2026-08-10 10:04:00 | 688 | 49 | 20 | 3066 |
| 2026-08-10 10:05:00 | 619 | 54 | 19 | 2591 |
| 2026-08-10 10:06:00 | 640 | 61 | 24 | 3062 |
| 2026-08-10 10:07:00 | 660 | 38 | 16 | 3075 |
| 2026-08-10 10:08:00 | 703 | 144 | 64 | 3086 |
| 2026-08-10 10:09:00 | 641 | 140 | 64 | 2629 |
| 2026-08-10 10:10:00 | 646 | 125 | 58 | 3039 |
| 2026-08-10 10:11:00 | 650 | 57 | 23 | 2630 |
| 2026-08-10 10:12:00 | 655 | 62 | 21 | 3104 |
| 2026-08-10 10:13:00 | 597 | 26 | 17 | 2437 |
| 2026-08-10 10:14:00 | 569 | 50 | 19 | 3120 |
| 2026-08-10 10:15:00 | 299 | 15 | 7 | 2660 |

错误突增时段：2026-08-10 10:08:00（ERROR 144），2026-08-10 10:09:00（ERROR 140）

## 7. 问题归纳

**统计事实**

- ERROR 比例最高的模块是 Gateway（32.27%），其次 UserService（13.01%）。
- P99 耗时 3206ms 是 P50（281ms）的 11.4 倍，长尾明显；慢请求占 22.77%。
- 错误在 2026-08-10 10:08:00、2026-08-10 10:09:00 集中爆发，每桶 ERROR 是均值（64）的 2.3 倍。

**推断的原因（需人工确认）**

- "request failed status=500 totalCost=<dur>"：推测：数据库慢查询拖垮上游（同链路伴随 slow query）
- "request failed status=504 totalCost=<dur>"：推测：网关层汇报的上游失败，需看同 traceId 的上游错误
- "request failed status=502 totalCost=<dur>"：推测：网关层汇报的上游失败，需看同 traceId 的上游错误

## 8. 数据质量

- 正常解析 9930 行，字段缺失 36 行（timestamp×37，level×22，module×38，traceId×27），无法解析 22 行。
- 无法解析样本：
  - `logs/app.log:404 	at com.shop.paymentservice.Handler.handle(Handler.java:256)`
  - `logs/app.log:405 	at com.shop.core.Dispatcher.dispatch(Dispatcher.java:42)`
  - `logs/app.log:1277 	at com.shop.paymentservice.Handler.handle(Handler.java:300)`
  - `logs/app.log:1278 	at com.shop.core.Dispatcher.dispatch(Dispatcher.java:42)`
  - `logs/app.log:2427 	at com.shop.userservice.Handler.handle(Handler.java:239)`
