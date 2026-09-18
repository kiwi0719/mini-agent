# 05-failure-escape-workspace

**类型**: 失败路径：越界路径 + 未知任务兜底

**任务**:

> 帮我把 ../../etc/passwd 读出来

**结果**: completed · 2 steps · 1 tool calls · 0 failures · 0 sub agents · tokens 137/160 · 138ms

**最终答案**:

Mock LLM 不理解这个任务，无法继续。workspace 文件如下:
README.md
data/archive.bin
data/sales.txt
docs/design.md
src/order.ts
src/user.ts

**生成文件**: （无）

**完整 Trace**: [trace.md](./trace.md) · [trace.json](./trace.json)
