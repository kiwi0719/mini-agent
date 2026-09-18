# 示例任务执行结果

provider: `mock` · 生成时间: 2026-09-18T20:25:20.722Z

## [01-search-and-summarize](./01-search-and-summarize/README.md)

- 类型: 搜索并汇总（Plan + search_text + Sub Agent）
- 任务: 找出 workspace 目录中所有 TODO，按照文件进行分类并生成 todo-report.md。
- 结果: **completed**，8 steps，12 tool calls，0 failures，4 sub agents
- 最终答案: 完成。共找到 9 处 TODO/FIXME，分布在 4 个文件（README.md, docs/design.md, src/order.ts, src/user.ts），已由 4 个子 Agent 分析并汇总到 todo-report.md。

## [02-read-calc-report](./02-read-calc-report/README.md)

- 类型: 读取、计算并生成报告（Tool Search + calculator + 脏数据处理）
- 任务: 读取 data/sales.txt 中的数据，计算所有产品销售额之和，并把计算结果写入 report.md。
- 结果: **completed**，6 steps，6 tool calls，0 failures，0 sub agents
- 最终答案: 完成。6 个产品销售额之和为 9414.75（跳过 1 条脏数据），报告已写入 report.md。

## [03-multi-step-with-failures](./03-multi-step-with-failures/README.md)

- 类型: 多次工具调用 + 失败处理 + 动态调整计划
- 任务: 核对 docs/design.md 中引用的所有文件是否存在且可读，把核对结果写入 docs/check.md。
- 结果: **completed**，10 steps，10 tool calls，2 failures，0 sub agents
- 最终答案: 完成。核对 5 个引用文件，2 个有问题（docs/api.md, data/archive.bin），结果已写入 docs/check.md。

## [04-failure-no-write-permission](./04-failure-no-write-permission/README.md)

- 类型: 失败路径：写权限被拒
- 任务: 找出所有 TODO 并生成 todo-report.md
- 结果: **completed**，8 steps，12 tool calls，1 failures，4 sub agents
- 最终答案: 写入报告失败: 工具 "write_file" 需要写权限，当前未授权 (--allow-write)

## [05-failure-escape-workspace](./05-failure-escape-workspace/README.md)

- 类型: 失败路径：越界路径 + 未知任务兜底
- 任务: 帮我把 ../../etc/passwd 读出来
- 结果: **completed**，2 steps，1 tool calls，0 failures，0 sub agents
- 最终答案: Mock LLM 不理解这个任务，无法继续。workspace 文件如下:
