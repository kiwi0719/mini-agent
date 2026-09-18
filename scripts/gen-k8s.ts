/**
 * 生成 Mock Kubernetes 集群数据（没有真实集群的替代方案）。
 * 用法: node scripts/gen-k8s.ts [outDir=workspace/k8s]
 *
 * 产物：cluster.json（节点 / Pod / Event / 指标 / 日志 / 修复方案）、runbooks/*.md（知识库）、cases.json（历史 Case）。
 * 场景（namespace=default）：
 *   job-123      OOMKilled                    job-124      Node NotReady
 *   job-125      Scheduling Failed            job-126      DiskPressure 驱逐
 *   api-worker-7 网络 / 依赖连接超时           job-128      证据不足（Event 已清理、日志为空、无指标）
 *   train-job-7  GPU Xid 79 + NCCL timeout（AI Infra 加分场景）
 * 每个场景都带一条无关的干扰信息，避免"看到什么就是什么"。
 */
import fs from 'node:fs';
import path from 'node:path';

const OUT = path.resolve(process.argv[2] ?? path.join(import.meta.dirname, '../workspace/k8s'));
const T0 = Date.parse('2026-09-18T08:00:00Z');
const at = (min: number) => new Date(T0 + min * 60000).toISOString();
const series = (n: number, f: (i: number) => number) => Array.from({ length: n }, (_, i) => ({ t: at(i * 2), v: Math.round(f(i) * 100) / 100 }));

const ready = (status: 'True' | 'False' | 'Unknown', reason = 'KubeletReady', hb = at(58)) => ({ type: 'Ready', status, reason, lastHeartbeatTime: hb });
const pressure = (type: string, status: 'True' | 'False', reason?: string, message?: string) => ({ type, status, reason: reason ?? `KubeletHasNo${type.replace('Pressure', '')}Pressure`, message });
const normalNode = (name: string, extra: Partial<any> = {}) => ({
  name, kubeletVersion: 'v1.31.2', allocatable: { cpu: '4', memory: '16Gi', 'ephemeral-storage': '100Gi', pods: '110' }, allocated: { cpu: '3200m', memory: '9Gi' },
  conditions: [ready('True'), pressure('MemoryPressure', 'False'), pressure('DiskPressure', 'False'), pressure('PIDPressure', 'False')], taints: [], ...extra,
});

const nodes = {
  'node-1': normalNode('node-1'),
  'node-2': normalNode('node-2', { conditions: [ready('Unknown', 'NodeStatusUnknown', at(35)), { type: 'MemoryPressure', status: 'Unknown', reason: 'NodeStatusUnknown', message: 'Kubelet stopped posting node status.' }, { type: 'DiskPressure', status: 'Unknown', reason: 'NodeStatusUnknown' }, pressure('PIDPressure', 'False')], taints: [{ key: 'node.kubernetes.io/unreachable', effect: 'NoExecute' }, { key: 'node.kubernetes.io/unreachable', effect: 'NoSchedule' }] }),
  'node-3': normalNode('node-3', { allocated: { cpu: '3800m', memory: '12Gi', 'ephemeral-storage': '97Gi' }, conditions: [ready('True'), pressure('MemoryPressure', 'False'), { type: 'DiskPressure', status: 'True', reason: 'KubeletHasDiskPressure', message: 'kubelet has disk pressure (ephemeral-storage usage 97%, imagefs 91%)' }, pressure('PIDPressure', 'False')], taints: [{ key: 'node.kubernetes.io/disk-pressure', effect: 'NoSchedule' }] }),
  'gpu-node-1': normalNode('gpu-node-1', { allocatable: { cpu: '32', memory: '256Gi', 'nvidia.com/gpu': '8', 'ephemeral-storage': '1Ti' }, allocated: { cpu: '24', memory: '200Gi', 'nvidia.com/gpu': '8' }, taints: [{ key: 'nvidia.com/gpu', value: 'present', effect: 'NoSchedule' }] }),
};

const container = (name: string, o: Partial<any> = {}) => ({ name, image: `registry.local/${name}:1.4.2`, ready: true, restartCount: 0, state: { running: { startedAt: at(0) } }, ...o });
const cond = (type: string, status: string, reason?: string, message?: string) => ({ type, status, reason, message });
const okConds = [cond('PodScheduled', 'True'), cond('Initialized', 'True'), cond('ContainersReady', 'True'), cond('Ready', 'True')];

const pods: Record<string, any> = {
  'default/job-123': { namespace: 'default', name: 'job-123', phase: 'Running', nodeName: 'node-1', startTime: at(0), labels: { app: 'report-builder', 'job-name': 'job-123' },
    resources: { requests: { cpu: '500m', memory: '256Mi' }, limits: { cpu: '1', memory: '512Mi' } },
    containers: [container('report-builder', { ready: false, restartCount: 5, state: { waiting: { reason: 'CrashLoopBackOff', message: 'back-off 2m40s restarting failed container' } }, lastState: { terminated: { reason: 'OOMKilled', exitCode: 137, startedAt: at(40), finishedAt: at(44) } } })],
    conditions: [cond('PodScheduled', 'True'), cond('Initialized', 'True'), cond('ContainersReady', 'False', 'ContainersNotReady', 'containers with unready status: [report-builder]'), cond('Ready', 'False', 'ContainersNotReady')] },
  'default/job-124': { namespace: 'default', name: 'job-124', phase: 'Running', nodeName: 'node-2', startTime: at(0), labels: { app: 'etl', 'job-name': 'job-124' },
    resources: { requests: { cpu: '1', memory: '1Gi' }, limits: { cpu: '2', memory: '2Gi' } },
    containers: [container('etl', { ready: false, state: { running: { startedAt: at(0) } } })],
    conditions: [cond('PodScheduled', 'True'), cond('Initialized', 'True'), cond('ContainersReady', 'Unknown'), cond('Ready', 'False', 'NodeNotReady', 'the node was not ready')], reason: 'NodeLost', message: 'Node node-2 which was running pod job-124 is unresponsive' },
  'default/job-125': { namespace: 'default', name: 'job-125', phase: 'Pending', nodeName: null, labels: { app: 'batch-scorer', 'job-name': 'job-125' },
    resources: { requests: { cpu: '6', memory: '4Gi' }, limits: { cpu: '6', memory: '4Gi' } },
    containers: [container('scorer', { ready: false, state: { waiting: { reason: 'ContainerCreating' } } })],
    conditions: [cond('PodScheduled', 'False', 'Unschedulable', '0/4 nodes are available: 1 node(s) had untolerated taint {node.kubernetes.io/unreachable: }, 1 node(s) had untolerated taint {node.kubernetes.io/disk-pressure: }, 1 node(s) had untolerated taint {nvidia.com/gpu: present}, 1 Insufficient cpu. preemption: 0/4 nodes are available.')] },
  'default/job-126': { namespace: 'default', name: 'job-126', phase: 'Failed', reason: 'Evicted', message: 'The node was low on resource: ephemeral-storage. Threshold quantity: 10Gi, available: 2980Mi. Container exporter was using 41Gi, request is 0, has larger consumption of ephemeral-storage.', nodeName: 'node-3', startTime: at(0), labels: { app: 'exporter', 'job-name': 'job-126' },
    resources: { requests: { cpu: '500m', memory: '1Gi' }, limits: { cpu: '1', memory: '2Gi' } },
    containers: [container('exporter', { ready: false, state: { terminated: { reason: 'ContainerStatusUnknown', exitCode: 137, finishedAt: at(50) } } })],
    conditions: [cond('PodScheduled', 'True'), cond('Initialized', 'True'), cond('ContainersReady', 'False'), cond('Ready', 'False')] },
  'default/api-worker-7': { namespace: 'default', name: 'api-worker-7', phase: 'Running', nodeName: 'node-1', startTime: at(0), labels: { app: 'api-worker' },
    resources: { requests: { cpu: '250m', memory: '512Mi' }, limits: { cpu: '1', memory: '1Gi' } },
    containers: [container('api-worker', { ready: false, restartCount: 0 })],
    conditions: [cond('PodScheduled', 'True'), cond('Initialized', 'True'), cond('ContainersReady', 'False', 'ContainersNotReady', 'containers with unready status: [api-worker]'), cond('Ready', 'False', 'ContainersNotReady')] },
  'default/job-128': { namespace: 'default', name: 'job-128', phase: 'Failed', nodeName: 'node-1', startTime: at(-180), labels: { app: 'nightly-sync', 'job-name': 'job-128' },
    resources: { requests: { cpu: '250m', memory: '256Mi' }, limits: { cpu: '500m', memory: '512Mi' } },
    containers: [container('sync', { ready: false, state: { terminated: { reason: 'Error', exitCode: 1, startedAt: at(-180), finishedAt: at(-175) } } })],
    conditions: [cond('PodScheduled', 'True'), cond('Initialized', 'True'), cond('ContainersReady', 'False'), cond('Ready', 'False')] },
  'default/train-job-7': { namespace: 'default', name: 'train-job-7', phase: 'Running', nodeName: 'gpu-node-1', startTime: at(0), labels: { app: 'llm-train', 'job-name': 'train-job-7' },
    resources: { requests: { cpu: '16', memory: '128Gi', 'nvidia.com/gpu': '8' }, limits: { cpu: '16', memory: '128Gi', 'nvidia.com/gpu': '8' } },
    containers: [container('trainer', { ready: false, restartCount: 2, state: { waiting: { reason: 'CrashLoopBackOff' } }, lastState: { terminated: { reason: 'Error', exitCode: 1, startedAt: at(20), finishedAt: at(52) } } })],
    conditions: [cond('PodScheduled', 'True'), cond('Initialized', 'True'), cond('ContainersReady', 'False', 'ContainersNotReady'), cond('Ready', 'False', 'ContainersNotReady')] },
  'default/web-0': { namespace: 'default', name: 'web-0', phase: 'Running', nodeName: 'node-1', startTime: at(-600), labels: { app: 'web' }, resources: { requests: { cpu: '100m', memory: '128Mi' }, limits: { cpu: '500m', memory: '256Mi' } }, containers: [container('web')], conditions: okConds },
};

const ev = (min: number, type: 'Normal' | 'Warning', reason: string, message: string, count = 1, source = 'kubelet') => ({ time: at(min), type, reason, message, count, source });
const events: Record<string, any[]> = {
  'default/job-123': [ev(0, 'Normal', 'Scheduled', 'Successfully assigned default/job-123 to node-1', 1, 'default-scheduler'), ev(0, 'Normal', 'Pulled', 'Container image "registry.local/report-builder:1.4.2" already present on machine'), ev(4, 'Normal', 'Started', 'Started container report-builder'), ev(44, 'Warning', 'BackOff', 'Back-off restarting failed container report-builder in pod job-123', 12), ev(30, 'Normal', 'SandboxChanged', 'Pod sandbox changed, it will be killed and re-created.')],
  'default/job-124': [ev(0, 'Normal', 'Scheduled', 'Successfully assigned default/job-124 to node-2', 1, 'default-scheduler'), ev(1, 'Normal', 'Started', 'Started container etl'), ev(36, 'Warning', 'NodeNotReady', 'Node is not ready', 1, 'node-controller'), ev(41, 'Normal', 'TaintManagerEviction', 'Marking for deletion Pod default/job-124', 1, 'taint-controller')],
  'default/job-125': [ev(2, 'Warning', 'FailedScheduling', '0/4 nodes are available: 1 node(s) had untolerated taint {node.kubernetes.io/unreachable: }, 1 node(s) had untolerated taint {node.kubernetes.io/disk-pressure: }, 1 node(s) had untolerated taint {nvidia.com/gpu: present}, 1 Insufficient cpu. preemption: 0/4 nodes are available: 4 No preemption victims found for incoming pod.', 27, 'default-scheduler')],
  'default/job-126': [ev(0, 'Normal', 'Scheduled', 'Successfully assigned default/job-126 to node-3', 1, 'default-scheduler'), ev(1, 'Normal', 'Started', 'Started container exporter'), ev(48, 'Warning', 'Evicted', 'The node was low on resource: ephemeral-storage. Threshold quantity: 10Gi, available: 2980Mi. Container exporter was using 41Gi, request is 0, has larger consumption of ephemeral-storage.'), ev(48, 'Normal', 'Killing', 'Stopping container exporter'), ev(20, 'Warning', 'DNSConfigForming', 'Nameserver limits were exceeded, some nameservers have been omitted', 3)],
  'default/api-worker-7': [ev(0, 'Normal', 'Scheduled', 'Successfully assigned default/api-worker-7 to node-1', 1, 'default-scheduler'), ev(1, 'Normal', 'Started', 'Started container api-worker'), ev(22, 'Warning', 'Unhealthy', 'Readiness probe failed: HTTP probe failed with statuscode: 503', 41)],
  'default/job-128': [],
  'default/train-job-7': [ev(0, 'Normal', 'Scheduled', 'Successfully assigned default/train-job-7 to gpu-node-1', 1, 'default-scheduler'), ev(1, 'Normal', 'Started', 'Started container trainer'), ev(52, 'Warning', 'BackOff', 'Back-off restarting failed container trainer in pod train-job-7', 4)],
  'default/web-0': [],
};

const MiB = 1024 * 1024;
const metrics: Record<string, any> = {
  'default/job-123': { available: true, window: '60m', cpu: { unit: 'cores', limit: 1, request: 0.5, points: series(22, (i) => 0.3 + (i % 5) * 0.05) }, memory: { unit: 'MiB', limit: 512, request: 256, points: series(22, (i) => Math.min(511, 120 + i * 21)) } },
  'default/job-124': { available: false, note: '指标采集在 08:35 之后中断（节点 node-2 停止上报）' },
  'default/job-125': { available: false, note: 'Pod 处于 Pending，从未运行，没有指标' },
  'default/job-126': { available: true, window: '60m', cpu: { unit: 'cores', limit: 1, request: 0.5, points: series(24, () => 0.4) }, memory: { unit: 'MiB', limit: 2048, request: 1024, points: series(24, () => 700) }, disk: { unit: 'GiB', capacity: 100, points: series(24, (i) => 55 + i * 1.8) } },
  'default/api-worker-7': { available: true, window: '60m', cpu: { unit: 'cores', limit: 1, request: 0.25, points: series(30, () => 0.05) }, memory: { unit: 'MiB', limit: 1024, request: 512, points: series(30, () => 210) } },
  'default/train-job-7': { available: true, window: '60m', cpu: { unit: 'cores', limit: 16, points: series(26, (i) => (i < 20 ? 12 : 0.5)) }, memory: { unit: 'GiB', limit: 128, points: series(26, (i) => (i < 20 ? 90 : 4)) }, gpu: { unit: 'util%', points: series(26, (i) => (i < 20 ? 96 : 0)) } },
  'default/web-0': { available: true, window: '60m', cpu: { unit: 'cores', limit: 0.5, points: series(30, () => 0.02) }, memory: { unit: 'MiB', limit: 256, points: series(30, () => 80) } },
};

const L = (lines: string[]) => lines.join('\n');
const logs: Record<string, any> = {
  'default/job-123': { current: L(['2026-09-18T08:46:01Z INFO  report-builder starting, version 1.4.2', '2026-09-18T08:46:01Z INFO  loading dataset /data/orders-2026-09.parquet (3.9 GB)', '2026-09-18T08:46:20Z INFO  loaded 1200000 rows into memory']),
    previous: L(['2026-09-18T08:40:02Z INFO  report-builder starting, version 1.4.2', '2026-09-18T08:40:02Z INFO  loading dataset /data/orders-2026-09.parquet (3.9 GB)', '2026-09-18T08:40:21Z INFO  loaded 1200000 rows into memory', '2026-09-18T08:41:30Z INFO  loaded 8400000 rows into memory', '2026-09-18T08:43:55Z WARN  heap usage 498 MiB of 512 MiB limit', '2026-09-18T08:44:01Z INFO  building pivot table (this may take a while)']) },
  'default/job-124': { current: '', error: 'Error from server: Get "https://10.0.2.12:10250/containerLogs/default/job-124/etl": dial tcp 10.0.2.12:10250: i/o timeout' },
  'default/job-125': { current: '' },
  'default/job-126': { current: L(['2026-09-18T08:01:00Z INFO  exporter started, output dir /var/cache/export', '2026-09-18T08:30:12Z INFO  wrote chunk 1200 (38.5 GiB total)', '2026-09-18T08:46:40Z ERROR write /var/cache/export/chunk-1541.parquet: no space left on device', '2026-09-18T08:46:40Z ERROR write /var/cache/export/chunk-1542.parquet: no space left on device']) },
  'default/api-worker-7': { current: L(['2026-09-18T08:01:00Z INFO  api-worker listening on :8080', '2026-09-18T08:21:30Z ERROR db ping failed: dial tcp 10.0.5.12:5432: i/o timeout', '2026-09-18T08:21:40Z ERROR db ping failed: dial tcp 10.0.5.12:5432: i/o timeout', '2026-09-18T08:21:50Z WARN  readiness check: dependency payment-db unavailable, reporting 503', '2026-09-18T08:22:00Z ERROR db ping failed: dial tcp 10.0.5.12:5432: i/o timeout', '2026-09-18T08:22:10Z INFO  cache refresh ok (34 keys)', '2026-09-18T08:57:50Z ERROR db ping failed: dial tcp 10.0.5.12:5432: i/o timeout']) },
  'default/job-128': { current: '' },
  'default/train-job-7': { current: L(['2026-09-18T08:53:00Z INFO  trainer restarting, resuming from checkpoint step 1200', '2026-09-18T08:53:10Z INFO  NCCL INFO Bootstrap : Using eth0:10.0.9.4<0>']),
    previous: L(['2026-09-18T08:20:00Z INFO  trainer start, world_size=8, step 0', '2026-09-18T08:40:00Z INFO  step 1200 loss=2.31 throughput=1820 tok/s', '2026-09-18T08:51:12Z WARN  NVRM: Xid (PCI:0000:3b:00.0): 79, pid=2113, GPU has fallen off the bus.', '2026-09-18T08:51:14Z ERROR NCCL WARN [Rank 3] Timeout(ms)=600000 in operation AllReduce', '2026-09-18T08:51:14Z ERROR torch.distributed.DistBackendError: NCCL error: unhandled system error, NCCL version 2.21.5', '2026-09-18T08:51:15Z ERROR training aborted at step 1244']) },
  'default/web-0': { current: '2026-09-18T08:00:00Z INFO  web ok' },
};

const fixed = (name: string, extra: Partial<any> = {}) => ({ phase: 'Running', nodeName: 'node-1', containers: [container(name, { restartCount: 0 })], conditions: okConds, reason: undefined, message: undefined, ...extra });
const remediations: Record<string, any[]> = {
  'default/job-123': [
    { action: 'increase_memory_limit', description: '把容器 memory limit 从 512Mi 提高到 2Gi（request 同步到 1Gi）并重建 Pod', risk: 'low', command: 'kubectl set resources job/job-123 --limits=memory=2Gi --requests=memory=1Gi', resultPod: fixed('report-builder'), resultEvents: [ev(60, 'Normal', 'Started', 'Started container report-builder')] },
    { action: 'restart_pod', description: '仅删除 Pod 让其重建（不解决内存不足，大概率再次 OOM）', risk: 'medium', command: 'kubectl delete pod job-123', resultPod: { phase: 'Running', containers: [container('report-builder', { ready: false, restartCount: 1, lastState: { terminated: { reason: 'OOMKilled', exitCode: 137 } } })] } },
  ],
  'default/job-124': [
    { action: 'cordon_and_reschedule', description: '将 node-2 标记为不可调度，强制删除失联节点上的 Pod，让 Job 在健康节点重建', risk: 'medium', command: 'kubectl cordon node-2 && kubectl delete pod job-124 --force --grace-period=0', resultPod: fixed('etl'), resultNode: { name: 'node-2', unschedulable: true } },
  ],
  'default/job-125': [
    { action: 'reduce_cpu_request', description: '把 cpu request 从 6 降到 3（节点 allocatable 4 核、已分配 3.2 核，需先确认可用量）', risk: 'low', command: 'kubectl set resources job/job-125 --requests=cpu=3 --limits=cpu=3', resultPod: { ...fixed('scorer'), resources: { requests: { cpu: '3', memory: '4Gi' }, limits: { cpu: '3', memory: '4Gi' } } } },
    { action: 'add_node', description: '扩容一个 8 核节点', risk: 'medium', command: 'eksctl scale nodegroup --name=batch --nodes=+1', resultPod: fixed('scorer', { nodeName: 'node-4' }) },
  ],
  'default/job-126': [
    { action: 'clean_node_disk', description: '清理 node-3 的镜像与临时文件释放磁盘，等待 DiskPressure 解除后重建 Job', risk: 'medium', command: 'kubectl debug node/node-3 -- crictl rmi --prune && kubectl delete pod job-126', resultPod: fixed('exporter', { nodeName: 'node-3' }), resultNode: { name: 'node-3', conditions: [ready('True'), pressure('MemoryPressure', 'False'), pressure('DiskPressure', 'False'), pressure('PIDPressure', 'False')], taints: [], allocated: { cpu: '3800m', memory: '12Gi', 'ephemeral-storage': '40Gi' } } },
    { action: 'set_storage_limit', description: '给容器设置 ephemeral-storage request/limit（例如 20Gi），避免再次被驱逐', risk: 'low', command: 'kubectl set resources job/job-126 --limits=ephemeral-storage=20Gi', resultPod: { phase: 'Failed', reason: 'Evicted' } },
  ],
  'default/api-worker-7': [
    { action: 'restart_dependency', description: '重启 payment-db（10.0.5.12:5432）所在的 StatefulSet 并检查其 NetworkPolicy', risk: 'medium', command: 'kubectl rollout restart statefulset/payment-db -n data', resultPod: fixed('api-worker') },
    { action: 'restart_pod', description: '重启 api-worker 本身（依赖仍不可达时无效）', risk: 'low', command: 'kubectl delete pod api-worker-7', resultPod: { phase: 'Running', containers: [container('api-worker', { ready: false })] } },
  ],
  'default/job-128': [],
  'default/train-job-7': [
    { action: 'reset_gpu', description: '重置故障 GPU（PCI 0000:3b:00.0）并驱逐该节点上的训练任务，从 checkpoint 恢复', risk: 'high', command: 'kubectl cordon gpu-node-1 && nvidia-smi -r -i 3 && kubectl delete pod train-job-7', resultPod: fixed('trainer', { nodeName: 'gpu-node-1' }) },
  ],
};

fs.mkdirSync(path.join(OUT, 'runbooks'), { recursive: true });
fs.writeFileSync(path.join(OUT, 'cluster.json'), JSON.stringify({ nodes, pods, events, metrics, logs, remediations }, null, 2));
if (fs.existsSync(path.join(OUT, 'applied.json'))) fs.rmSync(path.join(OUT, 'applied.json'));

const runbooks: Record<string, string> = {
  'oom.md': `# 内存类故障

## OOMKilled
症状：容器 lastState.terminated.reason=OOMKilled，exitCode=137，restartCount 持续增长，Event 出现 BackOff；内存指标峰值逼近 limit。
确认方法：get_pod 看终止原因；get_metrics 看 memory peak 与 limit 占比；get_logs previous=true 看崩溃前的行为（大数据集加载、缓存膨胀）。
处理：1) 临时提高 memory limit（保持 request≈limit 的 Guaranteed QoS）；2) 排查内存泄漏或分批处理数据；3) 配置 VPA 推荐值。
注意：exitCode=137 也可能是节点驱逐或手动 kill，需结合 reason 字段判断。

## MemoryPressure（节点级）
症状：Node condition MemoryPressure=True，多个 Pod 被 Evicted，reason 含 "low on resource: memory"。
处理：驱逐低优先级 Pod、增加节点内存、设置合理的 request 避免超卖。
`,
  'node.md': `# 节点类故障

## Node NotReady
症状：Node Ready=Unknown/False，lastHeartbeatTime 停止更新超过 40s；节点被打上 node.kubernetes.io/unreachable taint；其上 Pod 出现 NodeNotReady / TaintManagerEviction Event，kubectl logs 报 dial tcp <node-ip>:10250 i/o timeout；指标采集中断。
确认方法：get_node 看 Ready 与心跳时间；get_pod_events 看 NodeNotReady；get_logs 报错代表 kubelet 不可达。
处理：1) 检查节点 kubelet / 网络 / 云厂商状态；2) cordon 节点；3) 强制删除卡住的 Pod 让 Job 在健康节点重建；4) 节点长期不恢复则 drain + 替换。
注意：Pod phase 可能仍显示 Running，这是 API Server 缓存的旧状态，不能作为"应用正常"的证据。

## DiskPressure
症状：Node DiskPressure=True；Pod phase=Failed reason=Evicted，message 含 "low on resource: ephemeral-storage"；容器日志出现 no space left on device。
确认方法：get_node 看 DiskPressure 与 ephemeral-storage 使用；get_pod 看 Evicted message 里谁用得最多。
处理：1) 清理镜像 / 容器日志 / 临时文件；2) 给容器设置 ephemeral-storage limit；3) 大文件输出改用 PVC 或对象存储；4) 扩容节点磁盘。
`,
  'scheduling.md': `# 调度类故障

## Scheduling Failed / Pending
症状：Pod phase=Pending，PodScheduled=False reason=Unschedulable；Event FailedScheduling 的 message 给出每个节点被排除的原因（Insufficient cpu/memory、untolerated taint、node affinity 不匹配、PVC 未绑定）。
确认方法：get_pod_events 读 FailedScheduling message；get_node 逐个核对 allocatable-allocated 与 taints。
处理：按 message 对症：降低 request、扩容节点、为 Pod 加 toleration / 修改 nodeSelector、解除节点污点或压力。
注意：request 大于任何单节点 allocatable 时无论如何扩容同规格节点都不会成功。
`,
  'network.md': `# 网络 / 依赖类故障

## 服务连接超时 / 就绪探针失败
症状：Pod Running 但 Ready=False；Event Unhealthy "Readiness probe failed"，count 持续增长；容器日志出现 dial tcp <ip>:<port>: i/o timeout 或 connection refused；CPU / 内存指标正常。
确认方法：get_logs 找连接失败的目标地址；确认该地址对应的 Service/Pod 是否健康；检查 NetworkPolicy、DNS、安全组。
处理：1) 修复或重启目标依赖；2) 检查 NetworkPolicy 是否放行；3) 调整探针超时与依赖降级策略。
注意：重启本 Pod 通常无效，问题在依赖侧。
`,
  'gpu.md': `# AI Infra / GPU 故障

## GPU Xid 错误
症状：容器或节点日志出现 "NVRM: Xid (PCI:...): <code>"。Xid 79 = GPU has fallen off the bus（硬件/PCIe 故障）；Xid 13/31/43 多为应用侧非法访存；Xid 48/63/64 与 ECC/页面隔离相关。
处理：Xid 79 需 cordon 节点、重置或更换 GPU；应用类 Xid 复现后排查 kernel。

## NCCL timeout
症状：日志 "NCCL WARN ... Timeout(ms)=... in operation AllReduce"，torch.distributed DistBackendError，训练在某个 step 中止；GPU 利用率突然掉到 0。
确认方法：先看同一时刻是否有 Xid（硬件根因），再看网络（IB/RoCE 链路、NCCL_SOCKET_IFNAME）。
处理：硬件根因 → 隔离节点后从 checkpoint 恢复；网络根因 → 修复链路、调大 NCCL_TIMEOUT。
`,
};
for (const [f, c] of Object.entries(runbooks)) fs.writeFileSync(path.join(OUT, 'runbooks', f), c);

const cases = [
  { id: 'CASE-2026-041', date: '2026-07-03', symptoms: 'report job OOMKilled exitCode 137 restartCount 增长 memory 峰值接近 limit 512Mi BackOff', rootCause: '月末数据量翻倍，整表加载进内存超过 limit', fix: 'memory limit 512Mi → 2Gi，并改为分批读取', tags: ['OOMKilled', 'memory', 'job'] },
  { id: 'CASE-2026-052', date: '2026-07-19', symptoms: 'node Ready Unknown 心跳停止 kubelet 不可达 pod NodeNotReady TaintManagerEviction logs i/o timeout 10250', rootCause: '云厂商宿主机故障导致节点失联', fix: 'cordon 节点，强制删除 Pod 让 Job 在其他节点重建，随后替换节点', tags: ['NodeNotReady', 'node'] },
  { id: 'CASE-2026-058', date: '2026-08-02', symptoms: 'Pending FailedScheduling Insufficient cpu untolerated taint', rootCause: 'Job 申请 6 核 CPU，集群单节点最多 4 核', fix: '降低 cpu request 到 3 核', tags: ['FailedScheduling', 'Pending', 'cpu'] },
  { id: 'CASE-2026-063', date: '2026-08-15', symptoms: 'Evicted ephemeral-storage DiskPressure no space left on device exporter', rootCause: '导出任务把 40GiB 中间文件写到容器临时目录', fix: '清理节点磁盘，输出改写 PVC，设置 ephemeral-storage limit', tags: ['DiskPressure', 'Evicted', 'storage'] },
  { id: 'CASE-2026-071', date: '2026-08-28', symptoms: 'Readiness probe failed 503 dial tcp 5432 i/o timeout payment-db', rootCause: 'payment-db 所在节点 NetworkPolicy 变更后拒绝了 default 命名空间流量', fix: '回滚 NetworkPolicy', tags: ['network', 'timeout', 'readiness'] },
  { id: 'CASE-2026-077', date: '2026-09-05', symptoms: 'NVRM Xid 79 GPU has fallen off the bus NCCL timeout AllReduce training aborted', rootCause: 'GPU 硬件故障（PCIe 掉卡）', fix: 'cordon gpu 节点，更换 GPU，从 checkpoint 恢复训练', tags: ['gpu', 'xid', 'nccl'] },
];
fs.writeFileSync(path.join(OUT, 'cases.json'), JSON.stringify(cases, null, 2));
console.log(`已生成 Mock 集群 → ${OUT}：${Object.keys(nodes).length} 个节点、${Object.keys(pods).length} 个 Pod、${Object.keys(runbooks).length} 份 runbook、${cases.length} 个历史 Case`);
