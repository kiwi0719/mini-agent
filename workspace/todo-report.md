# TODO / FIXME 报告

共 9 项，分布在 4 个文件。

## README.md

- L12: TODO: 补充部署说明
- L13: TODO: 添加 CI 配置

## docs/design.md

- L17: TODO: 补充部署架构图
- L18: TODO: 评估是否引入 Redis 缓存

## src/order.ts

- L13: FIXME: 浮点运算精度问题，金额应使用整数分
- L22: TODO: 订单状态机校验（pending → paid → shipped）

## src/user.ts

- L12: TODO: 接入真实数据库，替换内存数组
- L17: FIXME: 没有校验 email 格式
- L24: TODO: 实现分页

