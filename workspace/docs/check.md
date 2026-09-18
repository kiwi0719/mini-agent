# 文档引用核对

来源: docs/design.md

| 文件 | 状态 | 说明 |
|---|---|---|
| src/user.ts | ✅ 存在 | 28 行 |
| src/order.ts | ✅ 存在 | 26 行 |
| docs/api.md | ❌ 异常 | 文件不存在: docs/api.md |
| data/sales.txt | ✅ 存在 | 9 行 |
| data/archive.bin | ❌ 异常 | data/archive.bin 是二进制文件，无法作为文本读取 |

## 异常文件

- docs/api.md: 文件不存在: docs/api.md
- data/archive.bin: data/archive.bin 是二进制文件，无法作为文本读取
