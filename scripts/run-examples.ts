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

const TASKS = [
  { id: '01-search-and-summarize', type: '搜索并汇总（Plan + search_text + Sub Agent）', task: '找出 workspace 目录中所有 TODO，按照文件进行分类并生成 todo-report.md。', outputs: ['todo-report.md'] },
  { id: '02-read-calc-report', type: '读取、计算并生成报告（Tool Search + calculator + 脏数据处理）', task: '读取 data/sales.txt 中的数据，计算所有产品销售额之和，并把计算结果写入 report.md。', outputs: ['report.md'] },
  { id: '03-multi-step-with-failures', type: '多次工具调用 + 失败处理 + 动态调整计划', task: '核对 docs/design.md 中引用的所有文件是否存在且可读，把核对结果写入 docs/check.md。', outputs: ['docs/check.md'] },
  { id: '04-failure-no-write-permission', type: '失败路径：写权限被拒', task: '找出所有 TODO 并生成 todo-report.md', outputs: [], allowWrite: false },
  { id: '05-failure-escape-workspace', type: '失败路径：越界路径 + 未知任务兜底', task: '帮我把 ../../etc/passwd 读出来', outputs: [] },
];

// 重置 workspace
for (const f of ['todo-report.md', 'report.md', 'docs/check.md']) { const p = path.join(WORKSPACE, f); if (fs.existsSync(p)) fs.rmSync(p); }
fs.mkdirSync(OUT, { recursive: true });

const summary: string[] = [`# 示例任务执行结果\n\nprovider: \`${provider}\` · 生成时间: ${new Date().toISOString()}\n`];
for (const t of TASKS) {
  // 每个任务前恢复初始状态，保证结果可复现
  for (const f of ['todo-report.md', 'report.md', 'docs/check.md']) { const p = path.join(WORKSPACE, f); if (fs.existsSync(p)) fs.rmSync(p); }
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
  const md = `# ${t.id}\n\n**类型**: ${t.type}\n\n**任务**:\n\n> ${t.task}\n\n**结果**: ${r.reason} · ${r.steps} steps · ${toolCalls} tool calls · ${failures} failures · ${subs} sub agents · tokens ${r.usage.inputTokens}/${r.usage.outputTokens} · ${Date.now() - t0}ms\n\n**最终答案**:\n\n${r.answer}\n\n**生成文件**: ${produced.map((f) => `[${f}](./${path.basename(f)})`).join(', ') || '（无）'}\n\n**完整 Trace**: [trace.md](./trace.md) · [trace.json](./trace.json)\n`;
  fs.writeFileSync(path.join(dir, 'README.md'), md);
  summary.push(`## [${t.id}](./${t.id}/README.md)\n\n- 类型: ${t.type}\n- 任务: ${t.task}\n- 结果: **${r.reason}**，${r.steps} steps，${toolCalls} tool calls，${failures} failures，${subs} sub agents\n- 最终答案: ${r.answer.split('\n')[0]}\n`);
  console.log(`✔ ${t.id}: ${r.reason} (${r.steps} steps)`);
}
fs.writeFileSync(path.join(OUT, 'README.md'), summary.join('\n'));
// 保留最终 workspace 产物供查看
console.log(`\n结果已写入 ${path.relative(process.cwd(), OUT)}/`);
