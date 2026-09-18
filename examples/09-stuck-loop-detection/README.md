# 09-stuck-loop-detection

**类型**: 防无限循环：弱模型反复轮询同一文件 → 提醒 → 判定死循环终止

**任务**:

> 等待 data/lock.txt 的 STATUS 变为 READY 后，把 data/sales.txt 的合计写入 report.md。

**校验**: ✅ 通过

**结果**: stuck_loop · 5 steps · 5 tool calls · 0 failures · 0 sub agents · tokens 1166/400 · 58ms

**最终答案**:

提醒后仍连续重复相同的工具调用（read_file），判定为死循环，任务中止。

**生成文件**: （无）

**完整 Trace**: [trace.md](./trace.md) · [trace.json](./trace.json)
