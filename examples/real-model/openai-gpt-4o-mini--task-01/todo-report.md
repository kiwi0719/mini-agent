# TODO Report

## README.md
- Line 14: TODO: 补充部署说明
- Line 15: TODO: 添加 CI 配置
- Line 17: 注意：本项目的 TODOS 统一在 issue 跟踪，代码里的 TODO 注释仅作临时标记。

## config/app.yaml
- Line 4: # TODO: 生产环境改成从环境变量读取

## docs/adr/001-storage.md
- Line 9: - TODO: 设计分页接口

## docs/design.md
- Line 19: TODO: 补充部署架构图
- Line 20: TODO: 评估是否引入 Redis 缓存（见 002）

## src/order.ts
- Line 22: /* TODO: 订单状态机校验（pending → paid → shipped） */

## src/payment.ts
- Line 8: // TODO: 幂等键，防止重复扣款

## src/user.ts
- Line 12: // TODO: 接入真实数据库，替换内存数组
- Line 24: // TODO(alice): 实现分页，见 docs/adr/001-storage.md

## src/utils/validate.ts
- Line 5: // TODO: 手机号校验支持国际区号
