/**
 * 集群数据源抽象。没有真实 K8s 时用 MockClusterSource（读 workspace/k8s/cluster.json）；
 * 之后接 kind/minikube/生产集群只需实现同一接口（kubectl / Prometheus / Loki），工具代码不变。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveInWorkspace } from '../sandbox.ts';

export interface ContainerStatus { name: string; ready: boolean; restartCount: number; state: Record<string, unknown>; lastState?: Record<string, unknown>; image?: string }
export interface PodStatus {
  namespace: string; name: string; phase: string; reason?: string; message?: string; nodeName?: string | null; startTime?: string;
  labels?: Record<string, string>; containers: ContainerStatus[]; conditions: { type: string; status: string; reason?: string; message?: string }[];
  resources?: { requests?: Record<string, string>; limits?: Record<string, string> };
}
export interface K8sEvent { time: string; type: 'Normal' | 'Warning'; reason: string; message: string; count?: number; source?: string }
export interface NodeStatus { name: string; conditions: { type: string; status: string; reason?: string; message?: string; lastHeartbeatTime?: string }[]; allocatable: Record<string, string>; allocated?: Record<string, string>; taints?: { key: string; value?: string; effect: string }[]; kubeletVersion?: string; unschedulable?: boolean }
export interface MetricPoint { t: string; v: number }
export interface MetricSeries { available: boolean; note?: string; window?: string; cpu?: { unit: string; limit?: number; request?: number; points: MetricPoint[] }; memory?: { unit: string; limit?: number; request?: number; points: MetricPoint[] }; gpu?: { unit: string; points: MetricPoint[] }; disk?: { unit: string; capacity?: number; points: MetricPoint[] } }
export interface PodLogs { current: string; previous?: string; error?: string }
export interface Remediation { action: string; description: string; risk: 'low' | 'medium' | 'high'; command: string; resultPod: Partial<PodStatus>; resultNode?: Partial<NodeStatus>; resultEvents?: K8sEvent[] }

export interface ClusterSource {
  getPod(ns: string, name: string): Promise<PodStatus | null>;
  listPodNames(ns: string): Promise<string[]>;
  getPodEvents(ns: string, name: string): Promise<K8sEvent[] | null>;
  getNode(name: string): Promise<NodeStatus | null>;
  listNodeNames(): Promise<string[]>;
  getMetrics(ns: string, name: string): Promise<MetricSeries | null>;
  getLogs(ns: string, name: string, opts: { previous?: boolean; tail?: number }): Promise<PodLogs | null>;
  listRemediations(ns: string, name: string): Promise<Remediation[]>;
  applyRemediation(ns: string, name: string, action: string, operator: string): Promise<Remediation>;
  appliedRemediations(ns: string, name: string): Promise<{ action: string; at: string; operator: string }[]>;
}

interface ClusterFile {
  nodes: Record<string, NodeStatus>;
  pods: Record<string, PodStatus>;
  events: Record<string, K8sEvent[]>;
  metrics: Record<string, MetricSeries>;
  logs: Record<string, PodLogs>;
  remediations: Record<string, Remediation[]>;
}
type Applied = Record<string, { action: string; at: string; operator: string }[]>;

export class MockClusterSource implements ClusterSource {
  private file: string; private appliedFile: string;
  constructor(workspace: string, rel = 'k8s/cluster.json') {
    this.file = resolveInWorkspace(workspace, rel);
    this.appliedFile = path.join(path.dirname(this.file), 'applied.json');
  }
  private async load(): Promise<ClusterFile> {
    try { return JSON.parse(await fs.readFile(this.file, 'utf8')); }
    catch { throw new Error(`Mock 集群数据不存在: ${path.basename(path.dirname(this.file))}/${path.basename(this.file)}（先运行 node scripts/gen-k8s.ts）`); }
  }
  private async loadApplied(): Promise<Applied> { try { return JSON.parse(await fs.readFile(this.appliedFile, 'utf8')); } catch { return {}; } }
  private key(ns: string, name: string) { return `${ns}/${name}`; }

  /** 已执行的修复动作会叠加到 Pod / Node / Events 上，模拟"修复后集群状态变化" */
  private async overlay<T>(kind: 'pod' | 'node' | 'events', base: T | null, ns: string, name: string, c: ClusterFile): Promise<T | null> {
    const applied = await this.loadApplied();
    const entries = kind === 'node'
      ? Object.entries(applied).flatMap(([k, list]) => list.map((a) => ({ k, a }))).filter(({ k, a }) => c.remediations[k]?.find((r) => r.action === a.action)?.resultNode && (c.pods[k]?.nodeName === name || c.remediations[k]!.find((r) => r.action === a.action)!.resultNode!.name === name))
      : (applied[this.key(ns, name)] ?? []).map((a) => ({ k: this.key(ns, name), a }));
    let out = base;
    for (const { k, a } of entries) {
      const r = c.remediations[k]?.find((x) => x.action === a.action); if (!r) continue;
      if (kind === 'pod') out = { ...(out ?? {}), ...r.resultPod, conditions: r.resultPod.conditions ?? (out as any)?.conditions, containers: r.resultPod.containers ?? (out as any)?.containers } as T;
      if (kind === 'node' && r.resultNode) out = { ...(out ?? {}), ...r.resultNode } as T;
      if (kind === 'events' && r.resultEvents) out = [...((out as any) ?? []), ...r.resultEvents] as T;
    }
    return out;
  }

  async getPod(ns: string, name: string) { const c = await this.load(); return this.overlay('pod', c.pods[this.key(ns, name)] ?? null, ns, name, c); }
  async listPodNames(ns: string) { const c = await this.load(); return Object.keys(c.pods).filter((k) => k.startsWith(ns + '/')).map((k) => k.split('/')[1]); }
  async getPodEvents(ns: string, name: string) { const c = await this.load(); if (!c.pods[this.key(ns, name)]) return null; return this.overlay('events', c.events[this.key(ns, name)] ?? [], ns, name, c); }
  async getNode(name: string) { const c = await this.load(); return this.overlay('node', c.nodes[name] ?? null, '', name, c); }
  async listNodeNames() { return Object.keys((await this.load()).nodes); }
  async getMetrics(ns: string, name: string) { const c = await this.load(); return c.metrics[this.key(ns, name)] ?? (c.pods[this.key(ns, name)] ? { available: false, note: '该 Pod 没有指标数据（未被采集或未运行）' } : null); }
  async getLogs(ns: string, name: string, opts: { previous?: boolean; tail?: number }) {
    const c = await this.load(); const l = c.logs[this.key(ns, name)]; if (!l) return c.pods[this.key(ns, name)] ? { current: '' } : null;
    const cut = (s: string | undefined) => { if (s === undefined) return undefined; const lines = s.split('\n'); return opts.tail ? lines.slice(-opts.tail).join('\n') : s; };
    return { current: cut(l.current)!, previous: cut(l.previous), error: l.error };
  }
  async listRemediations(ns: string, name: string) { return (await this.load()).remediations[this.key(ns, name)] ?? []; }
  async appliedRemediations(ns: string, name: string) { return (await this.loadApplied())[this.key(ns, name)] ?? []; }
  async applyRemediation(ns: string, name: string, action: string, operator: string) {
    const list = await this.listRemediations(ns, name);
    const r = list.find((x) => x.action === action);
    if (!r) throw new Error(`Pod ${ns}/${name} 没有名为 "${action}" 的修复方案，可选: ${list.map((x) => x.action).join(', ') || '无'}`);
    const applied = await this.loadApplied();
    (applied[this.key(ns, name)] ??= []).push({ action, at: new Date().toISOString(), operator });
    await fs.writeFile(this.appliedFile, JSON.stringify(applied, null, 2));
    return r;
  }
}

export function createClusterSource(workspace: string): ClusterSource {
  // 预留：K8S_SOURCE=kubectl 时返回真实实现
  return new MockClusterSource(workspace);
}
