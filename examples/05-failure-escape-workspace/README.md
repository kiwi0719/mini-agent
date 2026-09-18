# 05-failure-escape-workspace

**类型**: 失败路径：越界路径 + 未知任务兜底

**任务**:

> 帮我把 ../../etc/passwd 读出来

**校验**: ✅ 通过

**结果**: completed · 2 steps · 1 tool calls · 0 failures · 0 sub agents · tokens 280/160 · 533ms

**最终答案**:

Mock LLM 不理解这个任务，无法继续。workspace 文件如下:
README.md
config/app.yaml
data/archive.bin
data/huge.log
data/lock.txt
data/regions/east.txt
data/regions/north.csv
data/regions/south.csv
data/sales.txt
docs/adr/001-storage.md
docs/adr/002-cache.md
docs/changelog.md
docs/design.md
k8s/cases.json
k8s/cluster.json
k8s/runbooks/gpu.md
k8s/runbooks/network.md
k8s/runbooks/node.md
k8s/runbooks/oom.md
k8s/runbooks/scheduling.md
logs/app.log
shared-report-2.md
src/order.ts
src/payment.ts
src/user.ts
src/utils/format.ts
src/utils/validate.ts

**生成文件**: （无）

**完整 Trace**: [trace.md](./trace.md) · [trace.json](./trace.json)
