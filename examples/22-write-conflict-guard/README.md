# 22-write-conflict-guard

**类型**: 并发写冲突：两个任务同时预约同一输出 → 后者在 plan 阶段就被拒 → 换文件名重规划

**任务**:

> 并发写冲突演练：把 data/sales.txt 的合计写入 shared-report.md。

**校验**: ✅ 通过

**结果**: completed · 6 steps · 5 tool calls · 1 failures · 0 sub agents · tokens 2442/480 · 224ms

**最终答案**:

完成。合计 9414.75。原计划的输出 shared-report.md 被另一个并发任务预约，已改用 shared-report-2.md 写入——冲突在制定计划时就被发现，没有走到写入才失败。

**生成文件**: （无）

**完整 Trace**: [trace.md](./trace.md) · [trace.json](./trace.json)
