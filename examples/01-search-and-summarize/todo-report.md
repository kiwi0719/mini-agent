# TODO / FIXME 报告

共 16 项，分布在 9 个文件。

## README.md

- L14: TODO: 补充部署说明
- L15: TODO: 添加 CI 配置

## config/app.yaml

- L4: # TODO: 生产环境改成从环境变量读取
- L7: enabled: false   # FIXME: 缓存开关未接入代码

## docs/adr/001-storage.md

- L9: - TODO: 设计分页接口

## docs/adr/002-cache.md

- L8: FIXME: 配置项 cache.enabled 在 `config/app.yaml` 中存在但代码未读取

## docs/design.md

- L19: TODO: 补充部署架构图
- L20: TODO: 评估是否引入 Redis 缓存（见 002）

## src/order.ts

- L13: FIXME: 浮点运算精度问题，金额应使用整数分
- L22: /* TODO: 订单状态机校验（pending → paid → shipped） */

## src/payment.ts

- L8: TODO: 幂等键，防止重复扣款
- L14: FIXME: 退款没有校验订单状态是否为 paid

## src/user.ts

- L12: TODO: 接入真实数据库，替换内存数组
- L17: FIXME: 没有校验 email 格式
- L24: TODO(alice): 实现分页，见 docs/adr/001-storage.md

## src/utils/validate.ts

- L5: TODO: 手机号校验支持国际区号

