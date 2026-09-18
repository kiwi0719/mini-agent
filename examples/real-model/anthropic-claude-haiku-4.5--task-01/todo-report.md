# TODO 报告

生成时间：此报告统计了 workspace 中所有的 TODO 注释和标记

**统计摘要**
- 总计 TODO 项：14 项
- 涉及文件：8 个

---

## 按文件分类

### 1. README.md (2 TODOs)

| 行号 | 内容 |
|------|------|
| 14 | TODO: 补充部署说明 |
| 15 | TODO: 添加 CI 配置 |

### 2. config/app.yaml (1 TODO)

| 行号 | 内容 |
|------|------|
| 4 | TODO: 生产环境改成从环境变量读取 |

### 3. docs/adr/001-storage.md (1 TODO)

| 行号 | 内容 |
|------|------|
| 9 | TODO: 设计分页接口 |

### 4. docs/design.md (2 TODOs)

| 行号 | 内容 |
|------|------|
| 19 | TODO: 补充部署架构图 |
| 20 | TODO: 评估是否引入 Redis 缓存（见 002） |

### 5. src/order.ts (1 TODO)

| 行号 | 内容 |
|------|------|
| 22 | TODO: 订单状态机校验（pending → paid → shipped） |

### 6. src/payment.ts (2 TODOs)

| 行号 | 内容 |
|------|------|
| 8 | TODO: 幂等键，防止重复扣款 |

*注：第 5、9 行包含 "todo"，但为变量/注释说明，非 TODO 标记项*

### 7. src/user.ts (2 TODOs)

| 行号 | 内容 |
|------|------|
| 12 | TODO: 接入真实数据库，替换内存数组 |
| 24 | TODO(alice): 实现分页，见 docs/adr/001-storage.md |

### 8. src/utils/validate.ts (1 TODO)

| 行号 | 内容 |
|------|------|
| 5 | TODO: 手机号校验支持国际区号 |

---

## 按优先级/类别分类（推测）

### 基础设施/配置 (3)
- config/app.yaml:4 - 环境变量配置
- README.md:14 - 部署说明
- README.md:15 - CI 配置

### 功能实现 (6)
- src/order.ts:22 - 订单状态机
- src/payment.ts:8 - 幂等键实现
- src/user.ts:12 - 数据库接入
- src/user.ts:24 - 分页功能
- src/utils/validate.ts:5 - 国际区号支持
- docs/adr/001-storage.md:9 - 分页接口设计

### 文档/设计 (2)
- docs/design.md:19 - 架构图
- docs/design.md:20 - Redis 缓存评估

---

## 说明

- 报告源自 `search_text` 工具在 workspace 中的 TODO 搜索结果
- 搜索范围：26 个文件已扫描，总计 14 项匹配
- 过滤说明：第 5、9、17 行的 "todo" 因为是变量名或说明文字，已排除出 TODO 项计数
