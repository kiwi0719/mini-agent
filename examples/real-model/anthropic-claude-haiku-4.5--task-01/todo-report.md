# TODO 报告

**生成时间**：$(date)  
**总数**：14 个 TODO  
**扫描文件数**：26 个

---

## 按文件分类

### README.md (2 个 TODO)

| 行号 | 内容 |
|------|------|
| 14 | TODO: 补充部署说明 |
| 15 | TODO: 添加 CI 配置 |

**备注**：第 17 行提到本项目的 TODOS 统一在 issue 跟踪

---

### config/app.yaml (1 个 TODO)

| 行号 | 内容 |
|------|------|
| 4 | TODO: 生产环境改成从环境变量读取 |

**优先级**：高（生产环境配置相关）

---

### docs/adr/001-storage.md (1 个 TODO)

| 行号 | 内容 |
|------|------|
| 9 | TODO: 设计分页接口 |

---

### docs/design.md (2 个 TODO)

| 行号 | 内容 |
|------|------|
| 19 | TODO: 补充部署架构图 |
| 20 | TODO: 评估是否引入 Redis 缓存（见 002） |

---

### src/order.ts (1 个 TODO)

| 行号 | 内容 |
|------|------|
| 22 | TODO: 订单状态机校验（pending → paid → shipped） |

---

### src/payment.ts (1 个 TODO)

| 行号 | 内容 |
|------|------|
| 8 | TODO: 幂等键，防止重复扣款 |

**备注**：第 5 行 `todoList` 是变量名，不是 TODO 注释；第 9 行是对该变量的使用

**优先级**：高（涉及支付数据安全）

---

### src/user.ts (2 个 TODO)

| 行号 | 内容 |
|------|------|
| 12 | TODO: 接入真实数据库，替换内存数组 |
| 24 | TODO(alice): 实现分页，见 docs/adr/001-storage.md |

**备注**：第 24 行标记了责任人（alice）

---

### src/utils/validate.ts (1 个 TODO)

| 行号 | 内容 |
|------|------|
| 5 | TODO: 手机号校验支持国际区号 |

---

## 统计分析

### 按模块分类

| 模块 | 数量 |
|------|------|
| 文档 (docs/) | 3 |
| 源码 (src/) | 6 |
| 配置 (config/) | 1 |
| 项目文件 | 2 |
| 其他 | 2 |

### 优先级建议

**高优先级**（需要立即处理）：
- config/app.yaml: 生产环境改成从环境变量读取
- src/payment.ts: 幂等键，防止重复扣款

**中优先级**（功能开发相关）：
- src/user.ts: 接入真实数据库，替换内存数组
- src/order.ts: 订单状态机校验
- src/user.ts: 实现分页

**低优先级**（文档和优化）：
- README.md: 补充部署说明 / 添加 CI 配置
- docs/design.md: 补充部署架构图 / 评估是否引入 Redis 缓存
- src/utils/validate.ts: 手机号校验支持国际区号

---

## 特殊情况

1. **src/payment.ts** 包含了 `todoList` 变量名，在搜索结果中被识别但不是实际的 TODO 注释
2. **src/user.ts** 的第 24 行 TODO 标记了责任人 `alice`，表示这是分配给特定人员的任务

