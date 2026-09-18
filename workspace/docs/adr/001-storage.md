# ADR-001 存储选型

状态：已接受

## 决策
使用 PostgreSQL。当前代码仍是内存数组（见 `src/user.ts`），迁移计划见 `docs/adr/003-migration.md`。

## 后果
- TODO: 设计分页接口
- 关联：`docs/adr/002-cache.md`
