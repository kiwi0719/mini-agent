# ADR-002 缓存

状态：提议中

## 决策
暂不引入 Redis；先用进程内 LRU。依赖 `docs/adr/001-storage.md` 的表结构。

FIXME: 配置项 cache.enabled 在 `config/app.yaml` 中存在但代码未读取
