/**
 * Kubernetes 故障诊断工具：get_pod / get_pod_events / get_node / get_metrics / get_logs（必选）
 * + search_runbook / search_cases / propose_fix / apply_fix / verify_fix（加分项）。
 * 数据来自 ClusterSource（当前为 Mock，见 k8s/cluster.ts）。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Tool, ToolContext } from '../types.ts';
import { createClusterSource, type PodStatus } from './k8s/cluster.ts';
import { resolveInWorkspace } from './sandbox.ts';

const src = (ctx: ToolContext) => createClusterSource(ctx.workspace);
const NS = { namespace: { type: 'string', description: '命名空间，默认 default' } };
const ns = (i: { namespace?: string }) => i.namespace ?? 'default';
const j = (v: unknown) => JSON.stringify(v, null, 1);
const wrap = async (fn: () => Promise<{ ok: true; output: string } | { ok: false; error: string }>) => { try { return await fn(); } catch (e) { return { ok: false as const, error: (e as Error).message }; } };

async function notFound(ctx: ToolContext, n: string, name: string) {
  const names = await src(ctx).listPodNames(n);
  const similar = names.filter((x) => x.includes(name.replace(/-\d+$/, '')) || name.includes(x.replace(/-\d+$/, ''))).slice(0, 5);
  return { ok: false as const, error: `Pod ${n}/${name} 不存在。${similar.length ? '相似的 Pod: ' + similar.join(', ') : `该 namespace 下的 Pod: ${names.join(', ') || '无'}`}` };
}

/** 从 Pod 状态里提炼"值得注意的信号"，减少模型漏看 */
function podSignals(p: PodStatus): string[] {
  const s: string[] = [];
  if (p.phase !== 'Running' && p.phase !== 'Succeeded') s.push(`phase=${p.phase}${p.reason ? ' reason=' + p.reason : ''}`);
  for (const c of p.containers) {
    const term = (c.lastState?.terminated ?? c.state?.terminated) as any;
    if (term?.reason) s.push(`容器 ${c.name} 终止原因=${term.reason} exitCode=${term.exitCode}`);
    if (c.restartCount >= 3) s.push(`容器 ${c.name} 重启 ${c.restartCount} 次`);
    if ((c.state as any)?.waiting?.reason) s.push(`容器 ${c.name} waiting=${(c.state as any).waiting.reason}`);
    if (!c.ready && p.phase === 'Running') s.push(`容器 ${c.name} 未 Ready`);
  }
  for (const c of p.conditions) if (c.status !== 'True') s.push(`condition ${c.type}=${c.status}${c.reason ? ' (' + c.reason + ')' : ''}`);
  if (!p.nodeName) s.push('尚未调度到任何节点');
  return s;
}

export const getPod: Tool = {
  name: 'get_pod',
  description: '获取 Pod 状态（相当于 kubectl get/describe pod）：phase、容器状态与上次终止原因（如 OOMKilled）、重启次数、资源 requests/limits、所在节点、conditions。附带自动提炼的异常信号列表。',
  permission: 'read', idempotent: true,
  inputSchema: { type: 'object', properties: { name: { type: 'string', description: 'Pod 名，如 job-123' }, ...NS }, required: ['name'], additionalProperties: false },
  execute: (i: { name: string; namespace?: string }, ctx) => wrap(async () => {
    const p = await src(ctx).getPod(ns(i), i.name);
    if (!p) return notFound(ctx, ns(i), i.name);
    return { ok: true, output: j({ ...p, signals: podSignals(p) }) };
  }),
};

export const getPodEvents: Tool = {
  name: 'get_pod_events',
  description: '获取 Pod 相关的 Kubernetes Event（kubectl get events --field-selector involvedObject.name=<pod>），按时间排序，含 type/reason/message/count。Event 可能已过期被清理，此时返回空列表。',
  permission: 'read', idempotent: true,
  inputSchema: { type: 'object', properties: { name: { type: 'string' }, ...NS }, required: ['name'], additionalProperties: false },
  execute: (i: { name: string; namespace?: string }, ctx) => wrap(async () => {
    const ev = await src(ctx).getPodEvents(ns(i), i.name);
    if (ev === null) return notFound(ctx, ns(i), i.name);
    const sorted = [...ev].sort((a, b) => a.time.localeCompare(b.time));
    return { ok: true, output: j({ count: sorted.length, warnings: sorted.filter((e) => e.type === 'Warning').length, note: sorted.length ? undefined : '没有找到 Event（可能已超过保留期被清理，默认 1 小时）', events: sorted }) };
  }),
};

export const getNode: Tool = {
  name: 'get_node',
  description: '获取 Node 状态（kubectl describe node）：Ready/DiskPressure/MemoryPressure/PIDPressure 等 conditions 及最后心跳时间、allocatable 与已分配资源、taints、是否 unschedulable。不传 name 则列出所有节点摘要。',
  permission: 'read', idempotent: true,
  inputSchema: { type: 'object', properties: { name: { type: 'string', description: '节点名；留空列出全部节点' } }, additionalProperties: false },
  execute: (i: { name?: string }, ctx) => wrap(async () => {
    const s = src(ctx);
    if (!i.name) {
      const names = await s.listNodeNames();
      const rows = await Promise.all(names.map(async (n) => { const nd = (await s.getNode(n))!; return { name: n, ready: nd.conditions.find((c) => c.type === 'Ready')?.status, pressure: nd.conditions.filter((c) => c.type.endsWith('Pressure') && c.status === 'True').map((c) => c.type), taints: nd.taints?.map((t) => `${t.key}=${t.value ?? ''}:${t.effect}`), allocatable: nd.allocatable, allocated: nd.allocated, unschedulable: nd.unschedulable }; }));
      return { ok: true, output: j({ nodes: rows }) };
    }
    const n = await s.getNode(i.name);
    if (!n) return { ok: false, error: `节点 ${i.name} 不存在。现有节点: ${(await s.listNodeNames()).join(', ')}` };
    const bad = n.conditions.filter((c) => (c.type === 'Ready' ? c.status !== 'True' : c.status === 'True')).map((c) => `${c.type}=${c.status}${c.reason ? ' (' + c.reason + ')' : ''}`);
    return { ok: true, output: j({ ...n, signals: [...bad, ...(n.unschedulable ? ['节点已 cordon (unschedulable)'] : []), ...(n.taints?.length ? [`taints: ${n.taints.map((t) => `${t.key}:${t.effect}`).join(', ')}`] : [])] }) };
  }),
};

export const getMetrics: Tool = {
  name: 'get_metrics',
  description: '获取 Pod 的 CPU / 内存（以及 GPU、磁盘）时间序列指标，并给出峰值、均值和相对 limit 的占比。Pod 未运行或采集中断时 available=false。',
  permission: 'read', idempotent: true,
  inputSchema: { type: 'object', properties: { name: { type: 'string' }, ...NS, window: { type: 'string', description: '时间窗口，如 30m / 1h（Mock 数据固定，仅记录）' } }, required: ['name'], additionalProperties: false },
  execute: (i: { name: string; namespace?: string; window?: string }, ctx) => wrap(async () => {
    const m = await src(ctx).getMetrics(ns(i), i.name);
    if (!m) return notFound(ctx, ns(i), i.name);
    if (!m.available) return { ok: true, output: j({ available: false, note: m.note }) };
    const summary: Record<string, unknown> = {};
    for (const k of ['cpu', 'memory', 'gpu', 'disk'] as const) {
      const s = m[k]; if (!s || !s.points.length) continue;
      const vals = s.points.map((p) => p.v); const peak = Math.max(...vals); const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
      const limit = (s as any).limit ?? (s as any).capacity;
      summary[k] = { unit: s.unit, peak, avg: Math.round(avg * 100) / 100, last: vals.at(-1), limit, peakPctOfLimit: limit ? Math.round((peak / limit) * 100) + '%' : undefined, samples: vals.length };
    }
    return { ok: true, output: j({ available: true, window: i.window ?? m.window, summary, series: m }) };
  }),
};

export const getLogs: Tool = {
  name: 'get_logs',
  description: '获取容器日志（kubectl logs）。previous=true 读取上一次崩溃/重启前的容器日志（OOMKilled、CrashLoopBackOff 时必看）。tail 限制返回行数。节点失联时会返回错误。',
  permission: 'read', idempotent: true,
  inputSchema: { type: 'object', properties: { name: { type: 'string' }, ...NS, previous: { type: 'boolean' }, tail: { type: 'integer', minimum: 1, maximum: 500, description: '默认 100' } }, required: ['name'], additionalProperties: false },
  execute: (i: { name: string; namespace?: string; previous?: boolean; tail?: number }, ctx) => wrap(async () => {
    const l = await src(ctx).getLogs(ns(i), i.name, { previous: i.previous, tail: i.tail ?? 100 });
    if (!l) return notFound(ctx, ns(i), i.name);
    if (l.error) return { ok: false, error: l.error };
    const text = i.previous ? l.previous : l.current;
    if (i.previous && text === undefined) return { ok: false, error: '没有上一个容器实例的日志（容器未重启过）' };
    if (!text?.trim()) return { ok: true, output: j({ previous: !!i.previous, lines: 0, note: '日志为空', log: '' }) };
    const lines = text.split('\n');
    const highlights = lines.filter((x) => /error|fatal|panic|timeout|refused|oom|killed|xid|nccl|no space|exception/i.test(x)).slice(0, 15);
    return { ok: true, output: j({ previous: !!i.previous, lines: lines.length, highlights, log: text }) };
  }),
};

// ---------------- 加分项 ----------------

const tokens = (s: string) => new Set(s.toLowerCase().split(/[^a-z0-9一-龥]+/).filter((w) => w.length > 1));
const score = (q: Set<string>, text: string) => { const t = text.toLowerCase(); let n = 0; for (const w of q) if (t.includes(w)) n++; return n; };

export const searchRunbook: Tool = {
  name: 'search_runbook',
  description: '在故障知识库（workspace/k8s/runbooks/*.md）中检索与症状匹配的处理手册段落，返回排名靠前的条目（标题、内容、来源文件）。用于把证据映射到已知故障模式与标准处理步骤。',
  permission: 'read', idempotent: true,
  inputSchema: { type: 'object', properties: { query: { type: 'string', description: '症状关键词，如 "OOMKilled memory limit"' }, top: { type: 'integer', minimum: 1, maximum: 10 } }, required: ['query'], additionalProperties: false },
  execute: (i: { query: string; top?: number }, ctx) => wrap(async () => {
    const dir = resolveInWorkspace(ctx.workspace, 'k8s/runbooks');
    let files: string[] = []; try { files = (await fs.readdir(dir)).filter((f) => f.endsWith('.md')); } catch { return { ok: false, error: '知识库目录 k8s/runbooks 不存在' }; }
    const q = tokens(i.query); const hits: { file: string; title: string; score: number; content: string }[] = [];
    for (const f of files) {
      const text = await fs.readFile(path.join(dir, f), 'utf8');
      for (const sec of text.split(/^(?=## )/m)) { const title = sec.match(/^##\s*(.+)$/m)?.[1] ?? f; const sc = score(q, sec) + (score(q, title) * 2); if (sc > 0) hits.push({ file: `k8s/runbooks/${f}`, title, score: sc, content: sec.trim().slice(0, 1200) }); }
    }
    hits.sort((a, b) => b.score - a.score);
    return { ok: true, output: j({ query: i.query, total: hits.length, results: hits.slice(0, i.top ?? 3) }) };
  }),
};

export const searchCases: Tool = {
  name: 'search_cases',
  description: '按症状匹配历史故障 Case（workspace/k8s/cases.json）：返回相似度最高的历史事件，含当时的根因与处理方式，帮助快速对照。',
  permission: 'read', idempotent: true,
  inputSchema: { type: 'object', properties: { symptoms: { type: 'string', description: '症状描述 / 关键证据关键词' }, top: { type: 'integer', minimum: 1, maximum: 10 } }, required: ['symptoms'], additionalProperties: false },
  execute: (i: { symptoms: string; top?: number }, ctx) => wrap(async () => {
    let cases: { id: string; date: string; symptoms: string; rootCause: string; fix: string; tags: string[] }[];
    try { cases = JSON.parse(await fs.readFile(resolveInWorkspace(ctx.workspace, 'k8s/cases.json'), 'utf8')); } catch { return { ok: false, error: '历史 Case 库 k8s/cases.json 不存在' }; }
    const q = tokens(i.symptoms);
    const ranked = cases.map((c) => ({ ...c, similarity: score(q, `${c.symptoms} ${c.tags.join(' ')} ${c.rootCause}`) })).filter((c) => c.similarity > 0).sort((a, b) => b.similarity - a.similarity);
    return { ok: true, output: j({ total: ranked.length, cases: ranked.slice(0, i.top ?? 3) }) };
  }),
};

export const proposeFix: Tool = {
  name: 'propose_fix',
  description: '列出针对该 Pod 可用的修复方案（动作名、说明、风险等级、等价 kubectl 命令）。只生成方案，不执行；执行需用 apply_fix 且必须先获得人工确认。',
  permission: 'read', idempotent: true,
  inputSchema: { type: 'object', properties: { name: { type: 'string' }, ...NS, diagnosis: { type: 'string', description: '当前判断的故障原因，用于筛选相关方案' } }, required: ['name'], additionalProperties: false },
  execute: (i: { name: string; namespace?: string; diagnosis?: string }, ctx) => wrap(async () => {
    const s = src(ctx);
    if (!(await s.getPod(ns(i), i.name))) return notFound(ctx, ns(i), i.name);
    const list = await s.listRemediations(ns(i), i.name);
    const applied = await s.appliedRemediations(ns(i), i.name);
    const q = i.diagnosis ? tokens(i.diagnosis) : null;
    const ranked = list.map((r) => ({ action: r.action, description: r.description, risk: r.risk, command: r.command, relevance: q ? score(q, `${r.action} ${r.description}`) : undefined, applied: applied.some((a) => a.action === r.action) })).sort((a, b) => (b.relevance ?? 0) - (a.relevance ?? 0));
    return { ok: true, output: j({ pod: `${ns(i)}/${i.name}`, note: ranked.length ? '执行任一方案前需人工确认：apply_fix 是写操作，未授权写权限时会被拒绝。' : '没有预置的修复方案，请在处理建议中给出人工操作步骤。', proposals: ranked }) };
  }),
};

export const applyFix: Tool = {
  name: 'apply_fix',
  description: '【写操作，需人工确认】执行 propose_fix 给出的修复动作（Mock 集群中会更新 Pod/Node 状态并记录到 k8s/applied.json）。调用前必须已经在回复中说明将要执行的动作与风险；未授权写权限时会被拒绝，此时把方案写进处理建议即可。',
  permission: 'write',
  inputSchema: { type: 'object', properties: { name: { type: 'string' }, ...NS, action: { type: 'string', description: 'propose_fix 返回的 action 名' }, confirmed_by: { type: 'string', description: '确认人（用户名 / 工单号）' } }, required: ['name', 'action'], additionalProperties: false },
  // 写的是集群资源而非文件，用逻辑键参与同一套冲突检查
  writeTargets: (i: { name: string; namespace?: string }) => [`k8s://${i.namespace ?? 'default'}/${i.name}`],
  execute: (i: { name: string; namespace?: string; action: string; confirmed_by?: string }, ctx) => wrap(async () => {
    const r = await src(ctx).applyRemediation(ns(i), i.name, i.action, i.confirmed_by ?? 'operator');
    return { ok: true, output: j({ applied: r.action, command: r.command, description: r.description, note: '已执行（Mock）。请用 verify_fix 检查是否恢复。' }) };
  }),
};

export const verifyFix: Tool = {
  name: 'verify_fix',
  description: '修复后复查：重新读取 Pod（及其节点）状态，对比修复前的异常信号，判断是否恢复（recovered=true/false）并列出仍存在的问题。',
  permission: 'read', idempotent: true,
  inputSchema: { type: 'object', properties: { name: { type: 'string' }, ...NS }, required: ['name'], additionalProperties: false },
  execute: (i: { name: string; namespace?: string }, ctx) => wrap(async () => {
    const s = src(ctx);
    const p = await s.getPod(ns(i), i.name); if (!p) return notFound(ctx, ns(i), i.name);
    const applied = await s.appliedRemediations(ns(i), i.name);
    const signals = podSignals(p);
    const node = p.nodeName ? await s.getNode(p.nodeName) : null;
    const nodeIssues = node ? node.conditions.filter((c) => (c.type === 'Ready' ? c.status !== 'True' : c.status === 'True')).map((c) => `${node.name}: ${c.type}=${c.status}`) : [];
    const healthy = (p.phase === 'Running' && p.containers.every((c) => c.ready)) || p.phase === 'Succeeded';
    return { ok: true, output: j({ pod: `${ns(i)}/${i.name}`, appliedActions: applied, phase: p.phase, containersReady: p.containers.map((c) => `${c.name}:${c.ready}`), remainingSignals: signals, nodeIssues, recovered: healthy && nodeIssues.length === 0, note: applied.length ? undefined : '尚未执行任何修复动作' }) };
  }),
};

export const k8sTools: Tool[] = [getPod, getPodEvents, getNode, getMetrics, getLogs, searchRunbook, searchCases, proposeFix, applyFix, verifyFix];
