# 节点类故障

## Node NotReady
症状：Node Ready=Unknown/False，lastHeartbeatTime 停止更新超过 40s；节点被打上 node.kubernetes.io/unreachable taint；其上 Pod 出现 NodeNotReady / TaintManagerEviction Event，kubectl logs 报 dial tcp <node-ip>:10250 i/o timeout；指标采集中断。
确认方法：get_node 看 Ready 与心跳时间；get_pod_events 看 NodeNotReady；get_logs 报错代表 kubelet 不可达。
处理：1) 检查节点 kubelet / 网络 / 云厂商状态；2) cordon 节点；3) 强制删除卡住的 Pod 让 Job 在健康节点重建；4) 节点长期不恢复则 drain + 替换。
注意：Pod phase 可能仍显示 Running，这是 API Server 缓存的旧状态，不能作为"应用正常"的证据。

## DiskPressure
症状：Node DiskPressure=True；Pod phase=Failed reason=Evicted，message 含 "low on resource: ephemeral-storage"；容器日志出现 no space left on device。
确认方法：get_node 看 DiskPressure 与 ephemeral-storage 使用；get_pod 看 Evicted message 里谁用得最多。
处理：1) 清理镜像 / 容器日志 / 临时文件；2) 给容器设置 ephemeral-storage limit；3) 大文件输出改用 PVC 或对象存储；4) 扩容节点磁盘。
