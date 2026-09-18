# AI Infra / GPU 故障

## GPU Xid 错误
症状：容器或节点日志出现 "NVRM: Xid (PCI:...): <code>"。Xid 79 = GPU has fallen off the bus（硬件/PCIe 故障）；Xid 13/31/43 多为应用侧非法访存；Xid 48/63/64 与 ECC/页面隔离相关。
处理：Xid 79 需 cordon 节点、重置或更换 GPU；应用类 Xid 复现后排查 kernel。

## NCCL timeout
症状：日志 "NCCL WARN ... Timeout(ms)=... in operation AllReduce"，torch.distributed DistBackendError，训练在某个 step 中止；GPU 利用率突然掉到 0。
确认方法：先看同一时刻是否有 Xid（硬件根因），再看网络（IB/RoCE 链路、NCCL_SOCKET_IFNAME）。
处理：硬件根因 → 隔离节点后从 checkpoint 恢复；网络根因 → 修复链路、调大 NCCL_TIMEOUT。
