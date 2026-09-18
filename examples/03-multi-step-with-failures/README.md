# 03-multi-step-with-failures

**类型**: 多次工具调用 + 失败处理 + 动态调整计划

**任务**:

> 核对 docs/design.md 中引用的所有文件是否存在且可读，把核对结果写入 docs/check.md。

**结果**: completed · 10 steps · 10 tool calls · 2 failures · 0 sub agents · tokens 8460/800 · 275ms

**最终答案**:

完成。核对 5 个引用文件，2 个有问题（docs/api.md, data/archive.bin），结果已写入 docs/check.md。

**生成文件**: [docs/check.md](./check.md)

**完整 Trace**: [trace.md](./trace.md) · [trace.json](./trace.json)
