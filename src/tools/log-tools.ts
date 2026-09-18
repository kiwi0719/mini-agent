/**
 * 应用运行日志分析工具：log_stats / log_latency / log_trace / log_errors / log_timeline。
 * 全部只读、幂等；单遍流式扫描（readline），内存里只保留聚合结果与有限样本。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import type { Tool, ToolContext } from '../types.ts';
import { resolveInWorkspace, toRel } from './sandbox.ts';

// ---------------- 解析 ----------------

export type Quality = 'ok' | 'partial' | 'malformed';
export interface LogLine {
  file: string; lineNo: number; raw: string;
  ts?: number; tsText?: string; level?: string; module?: string; traceId?: string; message: string;
  kv: Record<string, string>;
  quality: Quality; missing: string[];
}

const TS_RE = /(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:[.,](\d{1,3}))?/;
const LEVEL_RE = /\b(TRACE|DEBUG|INFO|WARN|WARNING|ERROR|FATAL)\b/;
const BRACKET_RE = /\[([^\[\]]+)\]/g;
const TRACE_RE = /traceId[=:]\s*([\w-]+)/;
const KV_RE = /\b([A-Za-z_][\w]*)=([^\s,;\]]+)/g;

/** 容错解析：字段顺序可变、每个字段可缺失；连级别都识别不出来的行判为 malformed */
export function parseLine(raw: string, file: string, lineNo: number): LogLine {
  const kv: Record<string, string> = {};
  const missing: string[] = [];
  const tsm = raw.match(TS_RE);
  let ts: number | undefined; let tsText: string | undefined;
  if (tsm) { tsText = tsm[0]; const ms = tsm[3] ? Number(tsm[3].padEnd(3, '0')) : 0; ts = Date.parse(`${tsm[1]}T${tsm[2]}Z`) + ms; if (Number.isNaN(ts)) ts = undefined; }
  if (ts === undefined) missing.push('timestamp');
  const lvm = raw.match(LEVEL_RE);
  const level = lvm ? (lvm[1] === 'WARNING' ? 'WARN' : lvm[1]) : undefined;
  if (!level) missing.push('level');
  let module: string | undefined; let traceId: string | undefined;
  for (const m of raw.matchAll(BRACKET_RE)) {
    const inner = m[1];
    const t = inner.match(TRACE_RE);
    if (t) { traceId = t[1]; continue; }
    if (!module && /^[A-Za-z][\w.-]*$/.test(inner)) module = inner;
  }
  if (!traceId) { const t = raw.match(TRACE_RE); if (t) traceId = t[1]; }
  if (!module) missing.push('module');
  if (!traceId) missing.push('traceId');
  for (const m of raw.matchAll(KV_RE)) if (m[1] !== 'traceId') kv[m[1]] = m[2];
  // message = 去掉 ts / level / 方括号段之后的剩余部分
  let message = raw;
  if (tsText) message = message.replace(tsText, '');
  if (lvm) message = message.replace(LEVEL_RE, '');
  message = message.replace(BRACKET_RE, '').replace(/\s+/g, ' ').trim();
  const quality: Quality = !level ? 'malformed' : missing.length ? 'partial' : 'ok';
  return { file, lineNo, raw, ts, tsText, level, module, traceId, message, kv, quality, missing };
}

/** 从 kv 中取耗时（毫秒）。支持 108ms / 1.2s / 纯数字 */
export function durationMs(v: string | undefined): number | undefined {
  if (!v) return undefined;
  const m = v.match(/^(\d+(?:\.\d+)?)(ms|s)?$/);
  if (!m) return undefined;
  const n = Number(m[1]);
  return m[2] === 's' ? n * 1000 : n;
}

// ---------------- 文件枚举 + 流式扫描 ----------------

async function expandPaths(ctx: ToolContext, patterns: string[]): Promise<string[]> {
  const out = new Set<string>();
  for (const p of patterns) {
    if (!/[*?]/.test(p)) { out.add(resolveInWorkspace(ctx.workspace, p)); continue; }
    const dir = resolveInWorkspace(ctx.workspace, path.posix.dirname(p));
    const re = new RegExp('^' + path.posix.basename(p).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
    let entries: string[] = [];
    try { entries = await fsp.readdir(dir); } catch { throw new Error(`目录不存在: ${path.posix.dirname(p)}`); }
    for (const e of entries.filter((e) => re.test(e)).sort()) out.add(path.join(dir, e));
  }
  if (!out.size) throw new Error(`没有匹配到日志文件: ${patterns.join(', ')}`);
  return [...out];
}

export interface ScanInfo { files: string[]; lines: number; blank: number; bytes: number }

/** 逐行流式扫描多个文件；回调里做聚合。空行跳过但计数。 */
export async function scanLogs(ctx: ToolContext, patterns: string[], onLine: (l: LogLine) => void): Promise<ScanInfo> {
  const files = await expandPaths(ctx, patterns);
  const info: ScanInfo = { files: files.map((f) => toRel(ctx.workspace, f)), lines: 0, blank: 0, bytes: 0 };
  for (const abs of files) {
    const rel = toRel(ctx.workspace, abs);
    let st; try { st = await fsp.stat(abs); } catch { throw new Error(`文件不存在: ${rel}`); }
    info.bytes += st.size;
    const rl = readline.createInterface({ input: fs.createReadStream(abs, { encoding: 'utf8' }), crlfDelay: Infinity });
    let n = 0;
    for await (const raw of rl) {
      n++;
      if (ctx.signal?.aborted) throw new Error('任务已被中止');
      if (!raw.trim()) { info.blank++; continue; }
      info.lines++;
      onLine(parseLine(raw, rel, n));
    }
  }
  return info;
}

// ---------------- 统计辅助 ----------------

export function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}
function round(n: number, d = 1) { const f = 10 ** d; return Math.round(n * f) / f; }
function summarize(values: number[]) {
  const s = [...values].sort((a, b) => a - b);
  const sum = s.reduce((a, b) => a + b, 0);
  return { count: s.length, avg: s.length ? round(sum / s.length) : 0, p50: percentile(s, 50), p95: percentile(s, 95), p99: percentile(s, 99), max: s.at(-1) ?? 0, min: s[0] ?? 0 };
}
const isoMs = (t: number) => new Date(t).toISOString().replace('T', ' ').replace('Z', '');

/** 错误消息归一化：数字、id、耗时、IP 等替换为占位符，用于相似错误聚类 */
export function normalizeMessage(msg: string): string {
  return msg
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/g, '<ip>')
    .replace(/\b[0-9a-f]{8,}\b/gi, '<hex>')
    .replace(/\b\d+(?:\.\d+)?(ms|s)\b/g, '<dur>')
    .replace(/\bstatus=(\d{3})\b/g, 'status=S$1')   // HTTP 状态码本身是分类依据，保留
    .replace(/\b\d+\b/g, '#')
    .replace(/status=S/g, 'status=')
    .replace(/\s+/g, ' ')
    .trim();
}

const PATHS_PROP = { paths: { type: 'array', items: { type: 'string' }, minItems: 1, description: '日志文件路径列表（相对 workspace，支持 * 通配，如 ["logs/*.log"]）' } };

// ---------------- 工具 1：log_stats ----------------

export const logStats: Tool = {
  name: 'log_stats',
  description: '扫描日志文件，统计各日志级别数量、按模块的日志数 / ERROR 数 / ERROR 比例、时间范围、解析质量（正常 / 字段缺失 / 无法解析的行数及样本）。是日志分析的第一步。',
  permission: 'read', idempotent: true,
  inputSchema: { type: 'object', properties: { ...PATHS_PROP }, required: ['paths'], additionalProperties: false },
  async execute(input: { paths: string[] }, ctx) {
    const levels: Record<string, number> = {};
    const modules: Record<string, { total: number; error: number; warn: number }> = {};
    const quality = { ok: 0, partial: 0, malformed: 0 };
    const missingFields: Record<string, number> = {};
    const samples: { partial: string[]; malformed: string[] } = { partial: [], malformed: [] };
    const traceIds = new Set<string>();
    let tMin = Infinity, tMax = -Infinity;
    let info: ScanInfo;
    try {
      info = await scanLogs(ctx, input.paths, (l) => {
        quality[l.quality]++;
        for (const f of l.missing) missingFields[f] = (missingFields[f] ?? 0) + 1;
        if (l.quality !== 'ok' && samples[l.quality].length < 5) samples[l.quality].push(`${l.file}:${l.lineNo} ${l.raw.slice(0, 160)}`);
        if (l.level) levels[l.level] = (levels[l.level] ?? 0) + 1;
        const mod = l.module ?? '(unknown)';
        const m = (modules[mod] ??= { total: 0, error: 0, warn: 0 });
        m.total++; if (l.level === 'ERROR' || l.level === 'FATAL') m.error++; if (l.level === 'WARN') m.warn++;
        if (l.traceId) traceIds.add(l.traceId);
        if (l.ts !== undefined) { if (l.ts < tMin) tMin = l.ts; if (l.ts > tMax) tMax = l.ts; }
      });
    } catch (e) { return { ok: false, error: (e as Error).message }; }
    const byModule = Object.entries(modules).map(([module, m]) => ({ module, total: m.total, warn: m.warn, error: m.error, errorRate: m.total ? round((m.error / m.total) * 100, 2) + '%' : '0%' })).sort((a, b) => b.error - a.error || b.total - a.total);
    return { ok: true, output: JSON.stringify({
      files: info.files, totalLines: info.lines, blankLines: info.blank, bytes: info.bytes,
      timeRange: tMin < Infinity ? { from: isoMs(tMin), to: isoMs(tMax) } : null,
      distinctTraceIds: traceIds.size,
      byLevel: levels, byModule,
      parseQuality: { ...quality, missingFields, samples },
    }, null, 1) };
  },
};

// ---------------- 工具 2：log_latency ----------------

export const logLatency: Tool = {
  name: 'log_latency',
  description: '分析请求耗时：从日志的 cost= / totalCost= 字段提取毫秒数，计算平均值、P50/P95/P99/最大值，可按模块分组，并列出 Top N 最慢请求（含 traceId）。默认统计请求总耗时 totalCost，也可指定 field=cost 分析单步耗时。',
  permission: 'read', idempotent: true,
  inputSchema: { type: 'object', properties: {
    ...PATHS_PROP,
    field: { type: 'string', description: '耗时字段名，默认 totalCost；填 cost 则统计每个模块调用的耗时' },
    group_by_module: { type: 'boolean', description: '是否按模块分组，默认 true' },
    top_n: { type: 'integer', minimum: 1, maximum: 50, description: 'Top N 慢请求，默认 10' },
    threshold_ms: { type: 'integer', minimum: 0, description: '慢请求阈值（毫秒），默认 1000' },
  }, required: ['paths'], additionalProperties: false },
  async execute(input: { paths: string[]; field?: string; group_by_module?: boolean; top_n?: number; threshold_ms?: number }, ctx) {
    const field = input.field ?? 'totalCost';
    const topN = input.top_n ?? 10; const threshold = input.threshold_ms ?? 1000;
    const all: number[] = []; const byModule: Record<string, number[]> = {};
    const top: { traceId?: string; module?: string; ts?: string; ms: number; level?: string; message: string }[] = [];
    let slow = 0;
    try {
      await scanLogs(ctx, input.paths, (l) => {
        const ms = durationMs(l.kv[field]);
        if (ms === undefined) return;
        all.push(ms);
        (byModule[l.module ?? '(unknown)'] ??= []).push(ms);
        if (ms >= threshold) slow++;
        // 维护 Top N（小数组插入排序即可）
        if (top.length < topN || ms > top[top.length - 1].ms) {
          top.push({ traceId: l.traceId, module: l.module, ts: l.tsText, ms, level: l.level, message: l.message.slice(0, 120) });
          top.sort((a, b) => b.ms - a.ms); if (top.length > topN) top.pop();
        }
      });
    } catch (e) { return { ok: false, error: (e as Error).message }; }
    if (!all.length) return { ok: false, error: `日志中没有找到 ${field}= 字段，试试 field=cost` };
    const out: Record<string, unknown> = { field, unit: 'ms', overall: summarize(all), slowRequests: { thresholdMs: threshold, count: slow, ratio: round((slow / all.length) * 100, 2) + '%' }, topSlow: top };
    if (input.group_by_module !== false) out.byModule = Object.entries(byModule).map(([module, v]) => ({ module, ...summarize(v) })).sort((a, b) => b.p95 - a.p95);
    return { ok: true, output: JSON.stringify(out, null, 1) };
  },
};

// ---------------- 工具 3：log_trace ----------------

export const logTrace: Tool = {
  name: 'log_trace',
  description: '按 traceId 还原一次请求的完整日志链路：该 traceId 的全部日志按时间排序，并给出摘要（起止时间、总耗时、经过的模块、各步耗时、是否包含 WARN/ERROR）。',
  permission: 'read', idempotent: true,
  inputSchema: { type: 'object', properties: { ...PATHS_PROP, trace_id: { type: 'string', description: '要还原的 traceId' } }, required: ['paths', 'trace_id'], additionalProperties: false },
  async execute(input: { paths: string[]; trace_id: string }, ctx) {
    const lines: LogLine[] = [];
    try { await scanLogs(ctx, input.paths, (l) => { if (l.traceId === input.trace_id) lines.push(l); }); } catch (e) { return { ok: false, error: (e as Error).message }; }
    if (!lines.length) return { ok: false, error: `没有找到 traceId=${input.trace_id} 的日志` };
    lines.sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0) || a.lineNo - b.lineNo);
    const withTs = lines.filter((l) => l.ts !== undefined);
    const modules = [...new Set(lines.map((l) => l.module).filter(Boolean))];
    const steps = lines.filter((l) => l.kv.cost).map((l) => ({ module: l.module, ms: durationMs(l.kv.cost), message: l.message.slice(0, 80) }));
    const total = lines.map((l) => durationMs(l.kv.totalCost)).find((v) => v !== undefined);
    const errors = lines.filter((l) => l.level === 'ERROR' || l.level === 'FATAL');
    const warns = lines.filter((l) => l.level === 'WARN');
    return { ok: true, output: JSON.stringify({
      traceId: input.trace_id,
      summary: {
        lines: lines.length, modules,
        start: withTs[0]?.tsText, end: withTs.at(-1)?.tsText,
        wallMs: withTs.length >= 2 ? withTs.at(-1)!.ts! - withTs[0].ts! : undefined,
        totalCostMs: total,
        status: errors.length ? 'FAILED' : warns.length ? 'WARN' : 'OK',
        errors: errors.map((l) => `[${l.module}] ${l.message}`), warnings: warns.map((l) => `[${l.module}] ${l.message}`),
        steps,
      },
      lines: lines.map((l) => `${l.file}:${l.lineNo} ${l.raw}`),
    }, null, 1) };
  },
};

// ---------------- 工具 4：log_errors ----------------

export const logErrors: Tool = {
  name: 'log_errors',
  description: '汇总并聚类错误：把 ERROR/FATAL 日志的消息归一化（去掉数字、id、耗时）后分组，输出每类错误的数量、涉及模块、首末出现时间、代表 traceId，以及同一请求链路中伴随出现的 WARN（用于推断可能原因，例如 slow query → database_timeout）。可选包含 WARN。',
  permission: 'read', idempotent: true,
  inputSchema: { type: 'object', properties: {
    ...PATHS_PROP,
    top: { type: 'integer', minimum: 1, maximum: 50, description: '返回前 N 类，默认 10' },
    include_warn: { type: 'boolean', description: '是否把 WARN 也作为独立类别输出，默认 false' },
  }, required: ['paths'], additionalProperties: false },
  async execute(input: { paths: string[]; top?: number; include_warn?: boolean }, ctx) {
    type Cluster = { pattern: string; level: string; count: number; modules: Record<string, number>; first?: string; last?: string; sampleTraceIds: string[]; sample: string; traceIds: Set<string> };
    const clusters = new Map<string, Cluster>();
    const warnsByTrace = new Map<string, string[]>();   // traceId → WARN 归一化消息
    const errorTraces = new Set<string>();
    let errorLines = 0, warnLines = 0, errorsWithoutTrace = 0;
    try {
      await scanLogs(ctx, input.paths, (l) => {
        if (l.level === 'WARN') {
          warnLines++;
          if (l.traceId) { const a = warnsByTrace.get(l.traceId) ?? []; if (a.length < 5) a.push(`[${l.module ?? '?'}] ${normalizeMessage(l.message)}`); warnsByTrace.set(l.traceId, a); }
          if (!input.include_warn) return;
        } else if (l.level === 'ERROR' || l.level === 'FATAL') { errorLines++; if (l.traceId) errorTraces.add(l.traceId); else errorsWithoutTrace++; }
        else return;
        const key = `${l.level}|${normalizeMessage(l.message)}`;
        let c = clusters.get(key);
        if (!c) { c = { pattern: normalizeMessage(l.message), level: l.level!, count: 0, modules: {}, first: l.tsText, last: l.tsText, sampleTraceIds: [], sample: l.raw.slice(0, 160), traceIds: new Set() }; clusters.set(key, c); }
        c.count++; c.modules[l.module ?? '(unknown)'] = (c.modules[l.module ?? '(unknown)'] ?? 0) + 1; c.last = l.tsText ?? c.last;
        if (l.traceId) { c.traceIds.add(l.traceId); if (c.sampleTraceIds.length < 3) c.sampleTraceIds.push(l.traceId); }
      });
    } catch (e) { return { ok: false, error: (e as Error).message }; }
    const list = [...clusters.values()].sort((a, b) => b.count - a.count).slice(0, input.top ?? 10).map((c) => {
      const related: Record<string, number> = {};
      for (const t of c.traceIds) for (const w of warnsByTrace.get(t) ?? []) related[w] = (related[w] ?? 0) + 1;
      const relatedWarnings = Object.entries(related).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([pattern, n]) => ({ pattern, inTraces: n, ratio: round((n / Math.max(1, c.traceIds.size)) * 100) + '%' }));
      return { level: c.level, pattern: c.pattern, count: c.count, distinctTraces: c.traceIds.size, modules: c.modules, firstSeen: c.first, lastSeen: c.last, sampleTraceIds: c.sampleTraceIds, sample: c.sample, relatedWarnings, likelyCause: guessCause(c.pattern, relatedWarnings.map((r) => r.pattern)) };
    });
    return { ok: true, output: JSON.stringify({ errorLines, warnLines, errorTraces: errorTraces.size, errorsWithoutTraceId: errorsWithoutTrace, clusters: list }, null, 1) };
  },
};

/** 规则归纳：给每类错误一个候选原因（明确标注为推测，最终由模型综合判断） */
function guessCause(pattern: string, warns: string[]): string {
  const p = pattern.toLowerCase(); const w = warns.join(' ').toLowerCase();
  if (/slow query/.test(w)) return '推测：数据库慢查询拖垮上游（同链路伴随 slow query）';
  if (/timeout|timed out/.test(p)) return '推测：下游依赖响应超时';
  if (/database|db|sql|deadlock|pool/.test(p)) return '推测：数据库连接/查询失败';
  if (/connection_reset|connection refused|dns|network|unreachable/.test(p)) return '推测：网络或依赖服务不可达';
  if (/status=5#|status=#/.test(p) || /request failed/.test(p)) return '推测：网关层汇报的上游失败，需看同 traceId 的上游错误';
  if (/oom|memory/.test(p)) return '推测：内存不足';
  if (/null|npe|exception/.test(p)) return '推测：代码缺陷（未处理异常）';
  return '未归纳出明确原因，需人工查看链路';
}

// ---------------- 工具 5：log_timeline ----------------

export const logTimeline: Tool = {
  name: 'log_timeline',
  description: '按时间桶统计日志趋势：每个时间桶内各级别数量、请求 P95 耗时，并标出 ERROR 数显著高于平均值的异常时段（突增检测）。用于回答"错误集中在什么时候"。',
  permission: 'read', idempotent: true,
  inputSchema: { type: 'object', properties: { ...PATHS_PROP, bucket_seconds: { type: 'integer', minimum: 1, description: '时间桶大小（秒），默认 60' } }, required: ['paths'], additionalProperties: false },
  async execute(input: { paths: string[]; bucket_seconds?: number }, ctx) {
    const size = (input.bucket_seconds ?? 60) * 1000;
    const buckets = new Map<number, { levels: Record<string, number>; costs: number[] }>();
    let noTs = 0;
    try {
      await scanLogs(ctx, input.paths, (l) => {
        if (l.ts === undefined) { noTs++; return; }
        const k = Math.floor(l.ts / size) * size;
        const b = buckets.get(k) ?? { levels: {}, costs: [] }; buckets.set(k, b);
        if (l.level) b.levels[l.level] = (b.levels[l.level] ?? 0) + 1;
        const ms = durationMs(l.kv.totalCost); if (ms !== undefined) b.costs.push(ms);
      });
    } catch (e) { return { ok: false, error: (e as Error).message }; }
    const rows = [...buckets.entries()].sort((a, b) => a[0] - b[0]).map(([k, b]) => ({ bucket: isoMs(k).slice(0, 19), total: Object.values(b.levels).reduce((a, n) => a + n, 0), ...b.levels, p95: percentile(b.costs.sort((x, y) => x - y), 95), requests: b.costs.length }));
    const errs = rows.map((r) => (r as any).ERROR ?? 0);
    const mean = errs.reduce((a, b) => a + b, 0) / Math.max(1, errs.length);
    const sd = Math.sqrt(errs.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, errs.length));
    const spikes = rows.filter((r) => ((r as any).ERROR ?? 0) > mean + 2 * sd && ((r as any).ERROR ?? 0) >= 3).map((r) => ({ bucket: r.bucket, errors: (r as any).ERROR, p95: r.p95 }));
    return { ok: true, output: JSON.stringify({ bucketSeconds: size / 1000, buckets: rows.length, linesWithoutTimestamp: noTs, errorMeanPerBucket: round(mean, 2), spikes, series: rows }, null, 1) };
  },
};

export const logTools: Tool[] = [logStats, logLatency, logTrace, logErrors, logTimeline];
