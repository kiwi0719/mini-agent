# 11-cannot-complete-missing-info

**类型**: 判断任务无法完成：所需信息（汇率）不在 workspace，拒绝猜测

**任务**:

> 把 data/sales.txt 的销售额换算成美元写入 report-usd.md。

> ⚠️ 本用例由 Mock LLM 演示，证明的是**框架支持"拒绝猜测"这条路径**，不是"Agent 一定会拒绝"。真实模型实测：`claude-haiku-4.5` 会主动搜索汇率、找不到就拒绝；`gpt-4o-mini` 仍然编造汇率并写出报告。对照见 [examples/real-model](../real-model/README.md#ab给系统提示加一条数值溯源规则)。

**校验**: ✅ 通过

**结果**: completed · 4 steps · 3 tool calls · 0 failures · 0 sub agents · tokens 1363/320 · 219ms

**最终答案**:

无法完成：换算成美元需要人民币兑美元汇率，但任务没有提供，workspace 中也没有任何汇率配置（搜索 "汇率|exchange|USD|CNY|rate" 无有效结果）。我不会猜一个汇率写进报告。请提供汇率（例如 "1 USD = 7.2 CNY"）后重试；销售数据本身已读取成功，共 6 条有效记录。

**生成文件**: （无）

**完整 Trace**: [trace.md](./trace.md) · [trace.json](./trace.json)
