/**
 * Mock LLM 的两个新剧本：日志分析 / Kubernetes 故障诊断。
 * 与 mock.ts 一样，只根据消息历史（最近的 tool result）决定下一步；诊断结论由启发式规则从工具返回的证据里推导，
 * 用来演示 Loop + 工具 + 结构化输出，不代表真实模型的推理能力。
 */
import type { LLMResponse, ToolCall, PlanStep } from '../types.ts';

export type H = { name: string; input: any; ok: boolean; output: string; error: string };
export interface Helpers {
  call: (name: string, input: unknown) => ToolCall;
  reply: (text: string, ...calls: ToolCall[]) => Promise<LLMResponse>;
  plan: (steps: [string, PlanStep['status'], string?][], reason?: string) => ToolCall;
  has: (name: string) => boolean;
  last: (name: string) => H | undefined;
  available: Set<string>;
}
const J = (h?: H) => { try { return h?.ok ? JSON.parse(h.output) : null; } catch { return null; } };

// =====================================================================
// 剧本 D：日志分析
// =====================================================================
export async function logScenario(task: string, h: H[], k: Helpers): Promise<LLMResponse | null> {
  const isLog = /日志|\.log\b/i.test(task) && !/huge\.log/i.test(task);   // huge.log 属于 mock.ts 的任务 H
  if (!isLog) return null;
  const { call, reply, plan, has, last } = k;
  const pathMatch = task.match(/([\w\/.-]+\.log)/);
  const paths = [pathMatch ? pathMatch[1] : 'logs/*.log'];

  // D0：只还原某个 traceId 的链路
  const tid = task.match(/traceId\s*[=:]?\s*([\w-]+)/i)?.[1];
  if (tid && /链路|还原|trace/i.test(task) && !/报告|分析所有|统计/.test(task)) {
    const tr = last('log_trace');
    if (!tr) return reply(`还原 traceId=${tid} 的完整链路。`, call('log_trace', { paths, trace_id: tid }));
    if (!tr.ok) return reply(`无法还原链路：${tr.error}`);
    const d = J(tr);
    return reply(`traceId=${tid} 的链路（${d.summary.lines} 条日志，状态 ${d.summary.status}）：\n\n- 模块顺序：${d.summary.modules.join(' → ')}\n- 起止：${d.summary.start} → ${d.summary.end}（总耗时 ${d.summary.totalCostMs ?? d.summary.wallMs} ms）\n- 各步耗时：${d.summary.steps.map((s: any) => `${s.module} ${s.ms}ms`).join('，') || '无'}\n- 错误：${d.summary.errors.join('；') || '无'}\n- 告警：${d.summary.warnings.join('；') || '无'}\n\n完整日志：\n${d.lines.map((l: string) => '  ' + l).join('\n')}`);
  }

  if (!has('update_plan')) return reply('这是一个多步分析任务，先制定计划。', plan([['统计级别 / 模块 / 耗时 / 错误簇 / 时间趋势', 'in_progress'], ['对主要错误簇还原代表链路', 'pending'], ['归纳问题并写报告', 'pending']]));
  const stats = last('log_stats'), lat = last('log_latency'), errs = last('log_errors'), tl = last('log_timeline');
  if (!stats) return reply('四类统计互不依赖，同一轮并行获取。', call('log_stats', { paths }), call('log_latency', { paths, top_n: 5 }), call('log_errors', { paths, top: 6 }), call('log_timeline', { paths, bucket_seconds: 60 }));
  if (!stats.ok) {
    const ls = last('list_files');
    if (!ls) return reply(`读取日志失败（${stats.error}），先列出 workspace 文件确认路径。`, call('list_files', {}));
    return reply(`无法读取日志文件：${stats.error}。workspace 中的文件：\n${ls.ok ? ls.output : ls.error}\n任务无法继续。`);
  }
  const S = J(stats), L = J(lat), E = J(errs), T = J(tl);
  const clusters: any[] = E?.clusters ?? [];
  const wanted = clusters.slice(0, 2).map((c) => c.sampleTraceIds?.[0]).filter(Boolean);
  const traced = h.filter((x) => x.name === 'log_trace');
  const missing = wanted.filter((t) => !traced.some((x) => x.input?.trace_id === t));
  if (missing.length) return reply(`发现 ${clusters.length} 类错误。对前 ${wanted.length} 类各取一个代表 traceId 并行还原链路。`, plan([['统计级别 / 模块 / 耗时 / 错误簇 / 时间趋势', 'done'], ['对主要错误簇还原代表链路', 'in_progress'], ['归纳问题并写报告', 'pending']]), ...missing.map((t) => call('log_trace', { paths, trace_id: t })));

  const written = last('write_file');
  if (!written) {
    const out = task.match(/([\w\/.-]+\.md)/)?.[1] ?? 'logs/report.md';
    const md = buildLogReport(S, L, E, T, traced.map(J).filter(Boolean));
    return reply('链路已还原，写入分析报告。', plan([['统计级别 / 模块 / 耗时 / 错误簇 / 时间趋势', 'done'], ['对主要错误簇还原代表链路', 'done'], ['归纳问题并写报告', 'in_progress']]), call('write_file', { path: out, content: md }));
  }
  if (!written.ok) return reply(`报告写入失败（${written.error}）。以下是分析结论：\n\n` + buildLogReport(S, L, E, T, traced.map(J).filter(Boolean)).split('\n').slice(0, 40).join('\n'));
  const top = clusters[0];
  return reply(`完成。分析了 ${S.files.join(', ')} 共 ${S.totalLines} 行（${S.timeRange?.from} ~ ${S.timeRange?.to}）：\n- 级别：${Object.entries(S.byLevel).map(([k, v]) => `${k} ${v}`).join('，')}；ERROR 比例最高的模块是 ${S.byModule[0]?.module}（${S.byModule[0]?.errorRate}）\n- 请求耗时：平均 ${L?.overall.avg}ms，P95 ${L?.overall.p95}ms，P99 ${L?.overall.p99}ms，慢请求 ${L?.slowRequests.count} 个（${L?.slowRequests.ratio}）\n- 主要错误：${top ? `"${top.pattern}" ${top.count} 次` : '无'}，${top?.likelyCause ?? ''}\n- 错误突增时段：${T?.spikes?.map((s: any) => s.bucket).join('，') || '无明显突增'}\n- 解析质量：${S.parseQuality.partial} 行字段缺失、${S.parseQuality.malformed} 行无法解析（已计入报告，不影响统计）\n报告已写入 ${written.input.path}。`);
}

function buildLogReport(S: any, L: any, E: any, T: any, traces: any[]): string {
  const md: string[] = [`# 应用日志分析报告`, ``, `- 文件：${S.files.join(', ')}（${(S.bytes / 1024).toFixed(0)} KB，${S.totalLines} 行，空行 ${S.blankLines}）`, `- 时间范围：${S.timeRange?.from} ~ ${S.timeRange?.to}`, `- traceId 数：${S.distinctTraceIds}`, ``];
  md.push(`## 1. 日志级别统计`, ``, `| 级别 | 数量 |`, `|---|---|`, ...Object.entries(S.byLevel).map(([k, v]) => `| ${k} | ${v} |`), ``);
  md.push(`## 2. 按模块统计`, ``, `| 模块 | 日志数 | WARN | ERROR | ERROR 比例 |`, `|---|---|---|---|---|`, ...S.byModule.map((m: any) => `| ${m.module} | ${m.total} | ${m.warn} | ${m.error} | ${m.errorRate} |`), ``);
  if (L) {
    md.push(`## 3. 请求耗时（${L.field}）`, ``, `| 指标 | 值 (ms) |`, `|---|---|`, `| 样本数 | ${L.overall.count} |`, `| 平均 | ${L.overall.avg} |`, `| P50 | ${L.overall.p50} |`, `| P95 | ${L.overall.p95} |`, `| P99 | ${L.overall.p99} |`, `| 最大 | ${L.overall.max} |`, ``, `慢请求（≥ ${L.slowRequests.thresholdMs}ms）：${L.slowRequests.count} 个，占 ${L.slowRequests.ratio}`, ``);
    if (L.byModule) md.push(`### 按模块 P95`, ``, `| 模块 | 样本 | 平均 | P95 | P99 |`, `|---|---|---|---|---|`, ...L.byModule.map((m: any) => `| ${m.module} | ${m.count} | ${m.avg} | ${m.p95} | ${m.p99} |`), ``);
    md.push(`### Top ${L.topSlow.length} 慢请求`, ``, `| traceId | 模块 | 时间 | 耗时 (ms) | 级别 |`, `|---|---|---|---|---|`, ...L.topSlow.map((t: any) => `| ${t.traceId ?? '-'} | ${t.module ?? '-'} | ${t.ts ?? '-'} | ${t.ms} | ${t.level ?? '-'} |`), ``);
  }
  if (E) {
    md.push(`## 4. 异常汇总与聚类（共 ${E.errorLines} 条 ERROR，涉及 ${E.errorTraces} 个请求）`, ``);
    E.clusters.forEach((c: any, i: number) => {
      md.push(`### 4.${i + 1} ${c.pattern}`, ``, `- 次数：${c.count}（${c.distinctTraces} 个请求）· 模块：${Object.entries(c.modules).map(([k, v]) => `${k}×${v}`).join('，')}`, `- 时间：${c.firstSeen} ~ ${c.lastSeen}`, `- 样本：\`${c.sample}\``);
      if (c.relatedWarnings?.length) md.push(`- 同链路伴随 WARN：${c.relatedWarnings.map((w: any) => `${w.pattern}（${w.ratio} 的请求）`).join('；')}`);
      md.push(`- **候选原因（推测）**：${c.likelyCause}`, ``);
    });
  }
  if (traces.length) {
    md.push(`## 5. 代表链路还原`, ``);
    for (const t of traces) md.push(`### traceId=${t.traceId}（${t.summary.status}，${t.summary.totalCostMs ?? t.summary.wallMs} ms，${t.summary.modules.join(' → ')}）`, ``, '```text', ...t.lines.map((l: string) => l.replace(/^[^ ]+ /, '')), '```', ``);
  }
  if (T) md.push(`## 6. 时间趋势（每 ${T.bucketSeconds}s）`, ``, `| 时间桶 | 总数 | ERROR | WARN | P95 (ms) |`, `|---|---|---|---|---|`, ...T.series.map((r: any) => `| ${r.bucket} | ${r.total} | ${r.ERROR ?? 0} | ${r.WARN ?? 0} | ${r.p95} |`), ``, `错误突增时段：${T.spikes.length ? T.spikes.map((s: any) => `${s.bucket}（ERROR ${s.errors}）`).join('，') : '无'}`, ``);
  md.push(`## 7. 问题归纳`, ``, `**统计事实**`, ``);
  if (S.byModule[0]) md.push(`- ERROR 比例最高的模块是 ${S.byModule[0].module}（${S.byModule[0].errorRate}），其次 ${S.byModule[1]?.module ?? '-'}（${S.byModule[1]?.errorRate ?? '-'}）。`);
  if (L) md.push(`- P99 耗时 ${L.overall.p99}ms 是 P50（${L.overall.p50}ms）的 ${(L.overall.p99 / Math.max(1, L.overall.p50)).toFixed(1)} 倍，长尾明显；慢请求占 ${L.slowRequests.ratio}。`);
  if (T?.spikes?.length) md.push(`- 错误在 ${T.spikes.map((s: any) => s.bucket).join('、')} 集中爆发，每桶 ERROR 是均值（${T.errorMeanPerBucket}）的 ${(T.spikes[0].errors / Math.max(1, T.errorMeanPerBucket)).toFixed(1)} 倍。`);
  md.push(``, `**推断的原因（需人工确认）**`, ``);
  for (const c of (E?.clusters ?? []).slice(0, 3)) md.push(`- "${c.pattern}"：${c.likelyCause}`);
  md.push(``, `## 8. 数据质量`, ``, `- 正常解析 ${S.parseQuality.ok} 行，字段缺失 ${S.parseQuality.partial} 行（${Object.entries(S.parseQuality.missingFields).map(([k, v]) => `${k}×${v}`).join('，')}），无法解析 ${S.parseQuality.malformed} 行。`, `- 无法解析样本：`, ...S.parseQuality.samples.malformed.map((s: string) => `  - \`${s}\``), ``);
  return md.join('\n');
}

// =====================================================================
// 剧本 E：Kubernetes 故障诊断
// =====================================================================
export async function k8sScenario(task: string, h: H[], k: Helpers): Promise<LLMResponse | null> {
  const pod = task.match(/\b([a-z][a-z0-9]*(?:-[a-z0-9]+)*-\d+)\b/i)?.[1];
  if (!pod || !/pod|job|k8s|kubernetes|失败|诊断|分析|为什么|挂|不 ?ready|修复/i.test(task)) return null;
  const { call, reply, plan, has, last } = k;
  const ns = task.match(/namespace[=\s:]+([\w-]+)/i)?.[1] ?? 'default';
  const wantFix = /修复|恢复|处理掉|fix/i.test(task);

  if (!has('update_plan')) return reply(`诊断 ${pod}：先看 Pod 状态，再决定查哪些信息。`, plan([['获取 Pod 状态', 'in_progress'], ['按信号收集 Event / Node / Metrics / Logs', 'pending'], ['对照知识库与历史 Case', 'pending'], ['给出诊断结论' + (wantFix ? '并执行修复' : ''), 'pending']]));
  const gp = last('get_pod');
  if (!gp) return reply('获取 Pod 状态。', call('get_pod', { name: pod, namespace: ns }));
  if (!gp.ok) return reply(diagnosisMarkdown({ phenomenon: `无法获取 Pod ${ns}/${pod}：${gp.error}`, evidence: [`[Pod] ${gp.error}（get_pod）`], facts: [`Pod ${ns}/${pod} 在 namespace ${ns} 中不存在`], causes: [], advice: ['确认 Pod 名与 namespace 是否正确（错误信息里列出了相似的 Pod）', 'Job 的 Pod 可能已被 ttlSecondsAfterFinished 清理，请查 kubectl get job 与 events'], insufficient: '没有任何关于该 Pod 的状态、Event 或日志，无法判断失败原因。' }));
  const P = J(gp);
  const nodeName: string | undefined = P.nodeName ?? undefined;
  const oomish = /OOMKilled|重启|CrashLoopBackOff|终止原因/.test(P.signals.join(' '));   // 崩溃/重启类：看上一个容器实例的日志

  if (!has('get_pod_events')) {
    const calls = [call('get_pod_events', { name: pod, namespace: ns }), call('get_node', nodeName ? { name: nodeName } : {}), call('get_metrics', { name: pod, namespace: ns, window: '60m' }), call('get_logs', { name: pod, namespace: ns, previous: oomish, tail: 100 })];
    return reply(`Pod 信号：${P.signals.join('；') || '无异常信号'}。并行获取 Event、节点${nodeName ? ` ${nodeName}` : '列表'}、指标与${oomish ? '上一次崩溃前的' : '当前'}日志。`, plan([['获取 Pod 状态', 'done'], ['按信号收集 Event / Node / Metrics / Logs', 'in_progress'], ['对照知识库与历史 Case', 'pending'], ['给出诊断结论' + (wantFix ? '并执行修复' : ''), 'pending']]), ...calls);
  }
  const EV = J(last('get_pod_events')), ND = J(last('get_node')), MT = J(last('get_metrics')), LG = last('get_logs');
  const logText: string = LG?.ok ? (J(LG)?.log ?? '') : '';
  const d = diagnose(P, EV, ND, MT, LG, logText);

  if (!has('search_runbook')) {
    if (d.kind === 'insufficient') return reply('证据不足以确定原因，仍然检索知识库看是否有类似模式。', call('search_runbook', { query: `${P.phase} ${P.signals.join(' ')}`, top: 2 }), call('search_cases', { symptoms: `${P.phase} ${P.signals.join(' ')}`, top: 2 }));
    return reply(`初步判断为 ${d.title}。对照知识库与历史 Case。`, plan([['获取 Pod 状态', 'done'], ['按信号收集 Event / Node / Metrics / Logs', 'done'], ['对照知识库与历史 Case', 'in_progress'], ['给出诊断结论' + (wantFix ? '并执行修复' : ''), 'pending']]), call('search_runbook', { query: d.query, top: 2 }), call('search_cases', { symptoms: d.query, top: 2 }));
  }
  const RB = J(last('search_runbook')), CS = J(last('search_cases'));
  const rb = RB?.results?.[0]; const cs = CS?.cases?.[0];
  if (d.kind === 'insufficient') { if (!rb && !cs) d.evidence.push('[Runbook/Case] 知识库与历史 Case 均无匹配'); else d.evidence.push(`[Runbook/Case] 仅有弱相关匹配（${rb?.title ?? ''} ${cs?.id ?? ''}），不足以作为依据`); }
  else if (rb) d.evidence.push(`[Runbook] ${rb.title}：${rb.content.split('\n')[1]?.slice(0, 120)}…（search_runbook → ${rb.file}）`);
  if (cs && d.kind !== 'insufficient' && cs.similarity >= 2) { d.evidence.push(`[Case] ${cs.id}（${cs.date}）根因：${cs.rootCause}；处理：${cs.fix}（search_cases）`); d.advice.push(`历史 Case ${cs.id} 的处理方式可参考：${cs.fix}`); }

  // ---- 修复流程（可选）：propose_fix → apply_fix（需写权限）→ verify_fix → 复盘报告 ----
  if (wantFix && d.kind !== 'insufficient') {
    const pf = last('propose_fix');
    if (!pf) return reply('生成修复方案。', call('propose_fix', { name: pod, namespace: ns, diagnosis: d.query }));
    const proposals: any[] = J(pf)?.proposals ?? [];
    const chosen = proposals.find((p) => p.risk !== 'high') ?? proposals[0];
    const af = last('apply_fix');
    if (chosen && !af) return reply(`准备执行修复动作 **${chosen.action}**（风险 ${chosen.risk}）：${chosen.description}\n等价命令：\`${chosen.command}\`\n该动作为写操作，需要人工确认；若未授权将被拒绝并转为处理建议。`, call('apply_fix', { name: pod, namespace: ns, action: chosen.action, confirmed_by: 'user' }));
    if (af && !af.ok) { d.advice.unshift(`【待人工确认执行】${chosen.action}：${chosen.description}（\`${chosen.command}\`）—— 本次未获写权限，未执行：${af.error}`); return reply(diagnosisMarkdown(d)); }
    const vf = last('verify_fix');
    if (af?.ok && !vf) return reply('修复已执行，复查 Pod 是否恢复。', call('verify_fix', { name: pod, namespace: ns }));
    const V = J(vf);
    const pm = last('write_file');
    if (V) {   // 每一步都会重新推导 d，所以复查结果要在写报告与最终回答两步都补进去
      d.evidence.push(`[Pod] 修复后 phase=${V.phase}，containersReady=${V.containersReady.join(',')}，recovered=${V.recovered}（verify_fix）`);
      d.advice.unshift(V.recovered ? `已执行 ${chosen.action} 并复查恢复（recovered=true）。` : `已执行 ${chosen.action} 但未恢复，剩余信号：${V.remainingSignals.join('；')}`);
    }
    if (V && !pm) {
      const report = `# 故障复盘：${ns}/${pod}\n\n- 时间：${new Date().toISOString()}\n- 分类：${d.title}\n- 修复动作：${chosen.action}（${chosen.command}）\n- 复查结果：${V.recovered ? '已恢复' : '未恢复'}\n\n${diagnosisMarkdown(d)}\n\n## 改进项\n\n${d.improvements.map((x) => `- ${x}`).join('\n')}\n`;
      return reply('生成故障复盘报告。', plan([['获取 Pod 状态', 'done'], ['按信号收集 Event / Node / Metrics / Logs', 'done'], ['对照知识库与历史 Case', 'done'], ['给出诊断结论并执行修复', 'done', V.recovered ? '已恢复' : '未恢复']]), call('write_file', { path: `k8s/postmortem-${pod}.md`, content: report }));
    }
    if (pm) { d.advice.push(pm.ok ? `复盘报告已写入 ${pm.input.path}` : `复盘报告写入失败：${pm.error}`); }
  }
  return reply(diagnosisMarkdown(d));
}

interface Diag { kind: string; title: string; query: string; phenomenon: string; evidence: string[]; facts: string[]; causes: { cause: string; conf: '高' | '中' | '低'; basis: string }[]; advice: string[]; insufficient: string; improvements: string[] }

/** 启发式诊断：把工具返回的证据映射到 5+1 类故障；证据不足时如实说明 */
function diagnose(P: any, EV: any, ND: any, MT: any, LG: H | undefined, log: string): Diag {
  const ev: any[] = EV?.events ?? [];
  const node = ND?.nodes ? null : ND;
  const evidence: string[] = []; const facts: string[] = [];
  const sig = P.signals as string[];
  const cont = P.containers?.[0]; const term = cont?.lastState?.terminated ?? cont?.state?.terminated;
  facts.push(`Pod ${P.namespace}/${P.name} phase=${P.phase}${P.reason ? ' reason=' + P.reason : ''}，节点 ${P.nodeName ?? '未调度'}`);
  if (term?.reason) { evidence.push(`[Pod] 容器 ${cont.name} lastState.terminated.reason=${term.reason} exitCode=${term.exitCode}，restartCount=${cont.restartCount}（get_pod）`); facts.push(`容器上次终止原因 ${term.reason}，exitCode ${term.exitCode}，已重启 ${cont.restartCount} 次`); }
  for (const e of ev.filter((e) => e.type === 'Warning').slice(0, 3)) { evidence.push(`[Event] ${e.reason}: ${e.message.slice(0, 160)}（count=${e.count}，get_pod_events）`); facts.push(`Event ${e.reason} 出现 ${e.count} 次`); }
  if (node) { const bad = node.signals ?? []; if (bad.length) { evidence.push(`[Node] ${node.name}: ${bad.join('；')}（get_node）`); facts.push(`节点 ${node.name} 状态异常：${bad.join('；')}`); } else facts.push(`节点 ${node.name} Ready=True，无资源压力`); }
  if (MT?.available) { const m = MT.summary.memory; if (m) evidence.push(`[Metric] memory 峰值 ${m.peak}${m.unit} / limit ${m.limit}${m.unit}（${m.peakPctOfLimit}），cpu 峰值 ${MT.summary.cpu?.peak}${MT.summary.cpu?.unit}（get_metrics）`); if (MT.summary.disk) evidence.push(`[Metric] 磁盘使用最近 ${MT.summary.disk.last}${MT.summary.disk.unit} / ${MT.summary.disk.limit}${MT.summary.disk.unit}（get_metrics）`); if (MT.summary.gpu) evidence.push(`[Metric] GPU 利用率从 ${MT.summary.gpu.peak}% 掉到 ${MT.summary.gpu.last}%（get_metrics）`); }
  else if (MT) { evidence.push(`[Metric] 无指标：${MT.note}（get_metrics）`); }
  if (LG && !LG.ok) evidence.push(`[Log] 取日志失败：${LG.error}（get_logs）`);
  else if (log.trim()) { const hl = log.split('\n').filter((x) => /warn|error|xid|nccl|timeout|no space|heap/i.test(x)).slice(0, 3); if (hl.length) evidence.push(`[Log] ${hl.join(' | ').slice(0, 300)}（get_logs${LG?.input?.previous ? ' previous=true' : ''}）`); }
  else evidence.push(`[Log] 日志为空（get_logs）`);

  const base = { evidence, facts, advice: [] as string[], insufficient: '无', improvements: [] as string[] };
  const evReasons = ev.map((e) => e.reason);
  if (term?.reason === 'OOMKilled') return { ...base, kind: 'oom', title: 'OOMKilled（容器内存超过 limit）', query: 'OOMKilled memory limit exitCode 137 BackOff', phenomenon: `Pod ${P.name} 反复重启（restartCount=${cont.restartCount}），容器被内核 OOM Killer 杀死，处于 CrashLoopBackOff。`,
    causes: [{ cause: `应用工作集超过 memory limit ${P.resources?.limits?.memory}`, conf: '高', basis: `terminated.reason=OOMKilled、内存峰值达 limit 的 ${MT?.summary?.memory?.peakPctOfLimit ?? '?'}、崩溃前日志显示在加载大数据集` }, { cause: '数据量增长或内存泄漏导致占用持续上升', conf: '中', basis: '内存曲线单调上升而非平台期；需对比历史批次数据量' }],
    advice: [`临时：把 memory limit 从 ${P.resources?.limits?.memory} 提高（如 2Gi）并重建 Pod`, '根本：分批加载数据 / 排查泄漏；配置 VPA 推荐值', '注意 exitCode 137 也可能来自驱逐，此处 reason 明确为 OOMKilled'], improvements: ['为批处理 Job 设置基于数据量的内存预估', '增加内存使用率 > 90% 的告警'] };
  if (node && /Ready=Unknown|Ready=False/.test((node.signals ?? []).join(' '))) return { ...base, kind: 'node', title: 'Node NotReady（节点失联）', query: 'Node NotReady unreachable kubelet heartbeat', phenomenon: `Pod ${P.name} 所在节点 ${node.name} 失去心跳，Pod 状态 ${P.phase} 为过期缓存，实际不可用。`,
    causes: [{ cause: `节点 ${node.name} 的 kubelet 或宿主机故障 / 网络隔离`, conf: '高', basis: `Ready=Unknown、心跳停止、unreachable taint、NodeNotReady Event、日志端口 10250 超时、指标中断` }],
    advice: [`检查节点 ${node.name} 的 kubelet 与云厂商状态`, `kubectl cordon ${node.name}，强制删除 Pod 让 Job 在健康节点重建`, '长期不恢复则 drain 并替换节点'], improvements: ['节点失联自动 cordon + Pod 迁移策略', '关键 Job 设置 backoffLimit 与重试'] };
  if (P.phase === 'Pending' && evReasons.includes('FailedScheduling')) { const msg = ev.find((e) => e.reason === 'FailedScheduling')?.message ?? ''; return { ...base, kind: 'sched', title: 'Scheduling Failed（无可用节点）', query: 'FailedScheduling Pending Insufficient cpu taint', phenomenon: `Pod ${P.name} 一直 Pending，调度器找不到满足条件的节点。`,
    causes: [{ cause: `请求 cpu=${P.resources?.requests?.cpu} 超过任何单节点的可用量`, conf: '高', basis: `FailedScheduling: ${msg.slice(0, 120)}；节点列表显示健康节点 allocatable 4 核已分配 3.2 核` }, { cause: '其余节点因 taint（unreachable / disk-pressure / gpu）被排除', conf: '高', basis: 'FailedScheduling message 逐个列出了 untolerated taint' }],
    advice: ['降低 cpu request（例如 3 核）或扩容更大规格节点', '不要给 Pod 加 toleration 绕过 unreachable/disk-pressure 节点，那些节点本身有故障'], improvements: ['为 Job 模板设置 request 上限校验', '集群容量告警'] }; }
  if (P.reason === 'Evicted' && /ephemeral-storage|DiskPressure/i.test(P.message + evidence.join(' '))) return { ...base, kind: 'disk', title: 'DiskPressure（节点磁盘不足导致驱逐）', query: 'DiskPressure Evicted ephemeral-storage no space left', phenomenon: `Pod ${P.name} 被 kubelet 驱逐（phase=Failed reason=Evicted），节点 ${P.nodeName} 处于 DiskPressure。`,
    causes: [{ cause: '容器把大量中间文件写入本地临时目录，耗尽节点 ephemeral-storage', conf: '高', basis: `Evicted message: 容器使用 41Gi 且 request=0；节点 DiskPressure=True；日志 no space left on device；磁盘曲线持续上升` }],
    advice: [`清理节点 ${P.nodeName} 的镜像 / 临时文件，等待 DiskPressure 解除后重建 Job`, '为容器设置 ephemeral-storage request/limit', '大文件输出改用 PVC 或对象存储'], improvements: ['节点磁盘使用率 > 85% 告警', '禁止 request=0 的大量本地写入'] };
  if (/dial tcp .*i\/o timeout|connection refused/i.test(log) && (evReasons.includes('Unhealthy') || sig.some((s) => /未 Ready/.test(s)))) { const target = log.match(/dial tcp ([\d.]+:\d+)/)?.[1]; return { ...base, kind: 'net', title: '网络 / 依赖服务连接超时', query: 'readiness probe failed dial tcp i/o timeout dependency', phenomenon: `Pod ${P.name} 运行中但持续未 Ready，就绪探针返回 503。`,
    causes: [{ cause: `依赖 ${target ?? '数据库'} 不可达（网络策略 / 依赖宕机）`, conf: '高', basis: `日志连续 dial tcp ${target} i/o timeout；Unhealthy Event 持续累计；本 Pod CPU/内存正常，问题不在自身` }, { cause: 'DNS 或 NetworkPolicy 变更', conf: '中', basis: '历史 Case 中同类症状由 NetworkPolicy 变更引起，需核实近期变更' }],
    advice: [`检查 ${target ?? '依赖'} 对应的 Service / Pod 是否健康，以及 NetworkPolicy、安全组`, '重启本 Pod 无效，先修复依赖', '为依赖不可用配置降级，避免整个服务不 Ready'], improvements: ['依赖连通性探测与告警', '变更 NetworkPolicy 走审批'] }; }
  if (/NVRM: Xid|NCCL WARN|NCCL error/i.test(log)) { const xid = log.match(/Xid \(([^)]+)\): (\d+)/); return { ...base, kind: 'gpu', title: `GPU 故障（Xid ${xid?.[2] ?? '?'}）引发 NCCL 超时`, query: `Xid ${xid?.[2] ?? ''} NCCL timeout GPU fallen off the bus`, phenomenon: `训练任务 ${P.name} 在 step 1244 中止并反复重启，GPU 利用率掉到 0。`,
    causes: [{ cause: `GPU ${xid?.[1] ?? ''} 硬件故障（Xid ${xid?.[2]}：GPU has fallen off the bus）`, conf: '高', basis: '崩溃前日志先出现 NVRM Xid 79，随后 NCCL AllReduce 超时与 DistBackendError；GPU 利用率骤降' }, { cause: 'NCCL 网络链路问题', conf: '低', basis: 'NCCL 超时是 Xid 之后的次生现象，无独立网络错误证据' }],
    advice: ['cordon gpu-node-1，重置或更换故障 GPU', '从 checkpoint step 1200 在健康节点恢复训练', '把该卡加入硬件巡检'], improvements: ['节点级 Xid 告警自动隔离', '训练框架开启 elastic / 自动 checkpoint'] }; }
  return { ...base, kind: 'insufficient', title: '证据不足', query: `${P.phase} ${sig.join(' ')}`, phenomenon: `Pod ${P.name} phase=${P.phase}${term ? `，容器以 exitCode=${term.exitCode} 退出（reason=${term.reason}）` : ''}，但没有足够证据说明原因。`,
    causes: [], advice: ['查看 Job 控制器与应用侧监控 / 集中日志系统（Loki / ELS）中该 Pod 的历史日志', '如为定时任务，对比上次成功运行的配置与输入数据', '增大 Event 保留期或接入事件持久化'],
    insufficient: `Event 已被清理（${EV?.note ?? '空列表'}）、容器日志为空、${MT?.available ? '' : '指标不可用'}，节点状态正常。exitCode=${term?.exitCode ?? '?'} 只能说明应用自身退出失败，无法区分是代码错误、输入数据问题还是依赖故障。`, improvements: ['为 Job 配置日志持久化', '延长 Event TTL'] };
}

function diagnosisMarkdown(d: Omit<Diag, 'kind' | 'title' | 'query' | 'improvements'> & Partial<Diag>): string {
  return [
    `## 故障现象`, d.phenomenon, ``,
    `## 关键证据`, ...(d.evidence.length ? d.evidence.map((e) => `- ${e}`) : ['- 无']), ``,
    `## 已确认事实`, ...(d.facts.length ? d.facts.map((f) => `- ${f}`) : ['- 无']), ``,
    `## 可能原因（推测）`, ...(d.causes.length ? d.causes.map((c) => `- ${c.cause} · 置信度 ${c.conf} · 依据：${c.basis}`) : ['- 现有证据不足以给出原因，见下节']), ``,
    `## 处理建议`, ...d.advice.map((a) => `- ${a}`), ``,
    `## 证据不足说明`, d.insufficient,
  ].join('\n');
}
