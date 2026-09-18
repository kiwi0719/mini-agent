/**
 * 跑通 3 个示例任务（默认 mock provider），把执行结果与完整 Trace 保存到 examples/。
 * 用法: node scripts/run-examples.ts [provider]
 */
import fs from 'node:fs';
import path from 'node:path';
import { Agent } from '../src/agent.ts';
import { createDefaultRegistry } from '../src/tools/index.ts';
import { createProvider } from '../src/llm/index.ts';
import { Trace } from '../src/trace.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const WORKSPACE = path.join(ROOT, 'workspace');
const OUT = path.join(ROOT, 'examples');
const provider = process.argv[2] ?? process.env.LLM_PROVIDER ?? 'mock';

import { execFileSync } from 'node:child_process';
import type { Trace as TraceT } from '../src/trace.ts';
import type { AgentRunResult } from '../src/agent.ts';

const expected = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '.workspace-expected.json'), 'utf8')) as { breakingChanges: number; errorCounts: Record<string, number> };
const ws = (f: string) => fs.existsSync(path.join(WORKSPACE, f)) ? fs.readFileSync(path.join(WORKSPACE, f), 'utf8') : '';
type Verify = (r: AgentRunResult, t: TraceT) => string | null; // 返回 null 表示通过，否则是失败原因

const TASKS: { id: string; type: string; task: string; outputs: string[]; allowWrite?: boolean; verify: Verify }[] = [
  { id: '01-search-and-summarize', type: '搜索并汇总：Plan + 搜索精化（排除假阳性）+ 并行 Sub Agent', task: '找出 workspace 目录中所有 TODO，按照文件进行分类并生成 todo-report.md。', outputs: ['todo-report.md'],
    verify: (r) => { const md = ws('todo-report.md'); if (!md) return '未生成报告'; if (/todoList|TODOS/.test(md)) return '报告包含假阳性'; if (/node_modules/.test(md)) return '扫描了 node_modules'; const n = (md.match(/^- L\d+/gm) ?? []).length; return n === 16 ? null : `期望 16 条，实际 ${n}`; } },
  { id: '02-read-calc-report', type: '读取、计算并生成报告：Tool Search 激活 csv_parse + calculator + 脏数据', task: '读取 data/sales.txt 中的数据，计算所有产品销售额之和，并把计算结果写入 report.md。', outputs: ['report.md'],
    verify: () => ws('report.md').includes('9414.75') ? null : '合计不等于 9414.75' },
  { id: '03-multi-step-with-failures', type: '多步 + 失败处理 + 动态调整计划', task: '核对 docs/design.md 中引用的所有文件是否存在且可读，把核对结果写入 docs/check.md。', outputs: ['docs/check.md'],
    verify: () => { const md = ws('docs/check.md'); return /docs\/api\.md \| ❌/.test(md) && /archive\.bin \| ❌/.test(md) && (md.match(/✅/g) ?? []).length === 6 ? null : '核对结果不符（期望 6 存在 2 异常）'; } },
  { id: '04-failure-no-write-permission', type: '失败路径：写权限被拒', task: '找出所有 TODO 并生成 todo-report.md', outputs: [], allowWrite: false,
    verify: (r) => /写权限/.test(r.answer) ? null : '未说明写权限问题' },
  { id: '05-failure-escape-workspace', type: '失败路径：越界路径 + 未知任务兜底', task: '帮我把 ../../etc/passwd 读出来', outputs: [],
    verify: (r, t) => t.events.some((e) => e.type === 'tool_result' && !e.result.ok && /workspace 之外/.test(e.result.error)) || /无法/.test(r.answer) ? null : '越界未被拒绝' },
  { id: '06-multi-region-aggregate', type: '多文件聚合：list_files + 一轮并行 read_file + 格式归一（¥/千分位/退款负数）+ 并行 calculator', task: '汇总 data/regions 下所有地区的销售额（注意货币符号与退款），生成 report-regions.md。', outputs: ['report-regions.md'],
    verify: (r, t) => { const md = ws('report-regions.md'); if (!md.includes('14495.25')) return '总计不等于 14495.25'; const par = t.events.filter((e) => e.type === 'decision' && e.toolCalls.filter((c) => c.name === 'read_file').length >= 3).length; return par ? null : '没有一轮并行读取 3 个文件'; } },
  { id: '07-large-changelog-compression', type: '大文件（71KB）读入触发 Context 压缩 + 并行核对引用文件', task: '整理 docs/changelog.md 中所有 BREAKING 变更，核对涉及的文件是否仍存在，写入 breaking-changes.md。', outputs: ['breaking-changes.md'],
    verify: (r, t) => { const md = ws('breaking-changes.md'); if (!md.includes(`Breaking Changes（${expected.breakingChanges} 条）`)) return `BREAKING 条数不等于 ${expected.breakingChanges}`; if (!t.events.some((e) => e.type === 'compressed')) return '未触发 Context 压缩'; return /legacy\/cart\.ts \| ❌/.test(md) ? null : '缺失文件未标记'; } },
  { id: '08-huge-log-search-fallback', type: 'read_file 超限 → search_text；结果截断 → 分类型并行搜索', task: '统计 data/huge.log 中每类 ERROR 的数量，写入 error-report.md。', outputs: ['error-report.md'],
    verify: () => { const md = ws('error-report.md'); for (const [k, v] of Object.entries(expected.errorCounts)) if (!md.includes(`| ${k} | ${v} |`)) return `${k} 计数不符`; return null; } },
  { id: '09-stuck-loop-detection', type: '防无限循环：弱模型反复轮询同一文件 → 提醒 → 判定死循环终止', task: '等待 data/lock.txt 的 STATUS 变为 READY 后，把 data/sales.txt 的合计写入 report.md。', outputs: [],
    verify: (r, t) => r.reason === 'stuck_loop' && t.events.some((e) => e.type === 'notice') ? null : `期望 stuck_loop，实际 ${r.reason}` },
  { id: '10-subagent-write-permission', type: 'Sub Agent 默认只读 → 写失败 → 父 Agent 授予 allow_write 重派（并行）', task: '用子 Agent 为 src 下每个 .ts 文件生成摘要，写入 docs/summaries/<文件名>.md。', outputs: [],
    verify: (r, t) => { const n = fs.existsSync(path.join(WORKSPACE, 'docs/summaries')) ? fs.readdirSync(path.join(WORKSPACE, 'docs/summaries')).length : 0; if (n !== 5) return `期望 5 个摘要，实际 ${n}`; return t.events.some((e) => e.type === 'tool_result' && e.depth > 0 && !e.result.ok && /写权限/.test(e.result.error)) ? null : '子 Agent 首次写入未被拒'; } },
  { id: '11-cannot-complete-missing-info', type: '判断任务无法完成：所需信息（汇率）不在 workspace，拒绝猜测', task: '把 data/sales.txt 的销售额换算成美元写入 report-usd.md。', outputs: [],
    verify: (r) => !ws('report-usd.md') && /无法完成/.test(r.answer) && /汇率/.test(r.answer) ? null : '应明确说明无法完成且不生成报告' },
];

// 重新生成 workspace（确定性）
execFileSync(process.execPath, [path.join(import.meta.dirname, 'gen-workspace.ts')], { stdio: 'inherit' });
fs.mkdirSync(OUT, { recursive: true });
const GENERATED = ['todo-report.md', 'report.md', 'docs/check.md', 'report-regions.md', 'breaking-changes.md', 'error-report.md', 'report-usd.md', 'docs/summaries'];

let failedCount = 0;
const summary: string[] = [`# 示例任务执行结果\n\nprovider: \`${provider}\` · 生成时间: ${new Date().toISOString()}\n`];
for (const t of TASKS) {
  // 每个任务前恢复初始状态，保证结果可复现
  for (const f of GENERATED) fs.rmSync(path.join(WORKSPACE, f), { recursive: true, force: true });
  const llm = createProvider(provider);
  const trace = new Trace({ provider: llm.name, workspace: 'workspace' });
  const agent = new Agent(llm, createDefaultRegistry(), WORKSPACE, { allowWrite: t.allowWrite ?? true, onEvent: (e) => trace.push(e) });
  const t0 = Date.now();
  const r = await agent.run(t.task);
  const dir = path.join(OUT, t.id);
  fs.mkdirSync(dir, { recursive: true });
  trace.save(dir, 'trace');
  const produced = t.outputs.filter((f) => fs.existsSync(path.join(WORKSPACE, f)));
  for (const f of produced) fs.copyFileSync(path.join(WORKSPACE, f), path.join(dir, path.basename(f)));
  const toolCalls = trace.events.filter((e) => e.type === 'tool_call').length;
  const failures = trace.events.filter((e) => e.type === 'tool_result' && !e.result.ok).length;
  const subs = new Set(trace.events.filter((e) => e.depth > 0).map((e) => e.agent)).size;
  const verdict = t.verify(r, trace);
  const md = `# ${t.id}\n\n**类型**: ${t.type}\n\n**任务**:\n\n> ${t.task}\n\n**校验**: ${verdict ? `❌ ${verdict}` : '✅ 通过'}\n\n**结果**: ${r.reason} · ${r.steps} steps · ${toolCalls} tool calls · ${failures} failures · ${subs} sub agents · tokens ${r.usage.inputTokens}/${r.usage.outputTokens} · ${Date.now() - t0}ms\n\n**最终答案**:\n\n${r.answer}\n\n**生成文件**: ${produced.map((f) => `[${f}](./${path.basename(f)})`).join(', ') || '（无）'}\n\n**完整 Trace**: [trace.md](./trace.md) · [trace.json](./trace.json)\n`;
  fs.writeFileSync(path.join(dir, 'README.md'), md);
  summary.push(`## [${t.id}](./${t.id}/README.md)\n\n- 类型: ${t.type}\n- 任务: ${t.task}\n- 校验: ${verdict ? `❌ ${verdict}` : '✅'}\n- 结果: **${r.reason}**，${r.steps} steps，${toolCalls} tool calls，${failures} failures，${subs} sub agents\n- 最终答案: ${r.answer.split('\n')[0]}\n`);
  console.log(`${verdict ? '✘' : '✔'} ${t.id}: ${r.reason} (${r.steps} steps, ${toolCalls} calls, ${failures} failed, ${subs} subs)${verdict ? '  ← ' + verdict : ''}`);
  if (verdict) failedCount++;
}
fs.writeFileSync(path.join(OUT, 'README.md'), summary.join('\n'));
// 保留最终 workspace 产物供查看
console.log(`\n结果已写入 ${path.relative(process.cwd(), OUT)}/  (${TASKS.length - failedCount}/${TASKS.length} 校验通过)`);
process.exit(failedCount ? 1 : 0);
