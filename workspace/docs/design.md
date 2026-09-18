# 系统设计

## 概述

系统由用户、订单、支付三个模块组成，数据暂存内存。存储与缓存决策见 ADR。

## 模块

- 用户模块：`src/user.ts`
- 订单模块：`src/order.ts`
- 支付模块：`src/payment.ts`
- API 文档：`docs/api.md`（待编写）
- 架构决策：`docs/adr/001-storage.md`、`docs/adr/002-cache.md`
- 销售数据：`data/sales.txt`
- 历史归档：`data/archive.bin`

## 待办

TODO: 补充部署架构图
TODO: 评估是否引入 Redis 缓存（见 002）

## 非功能需求

- 响应时间 P99 < 200ms
- 可用性 99.9%
