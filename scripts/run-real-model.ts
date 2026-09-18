/**
 * 用真实模型跑一组任务并把 Trace 留档到 examples/real-model/。
 * 与 run-examples.ts 的区别：那个用 Mock 验证框架机制，这个验证"接上真模型能不能用"。
 *
 * 用法（凭证从 .env 读，见 README）：
 *   node --env-file=.env scripts/run-real-model.ts
 *   node --env-file=.env scripts/run-real-model.ts 02          # 只跑某个任务
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Agent } from '../src/agent.ts';
import { createDefaultRegistry } from '../src/tools/index.ts';
import { createProvider, type LLMConfig } from '../src/llm/index.ts';
import { Trace } from '../src/trace.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const WORKSPACE = path.join(ROOT, 'workspace');
const OUT = path.join(ROOT, 'examples', 'real-model');
const KEY = process.env.OR_KEY ?? process.env.OPENROUTER_API_KEY ?? '';
if (!KEY) { console.error('需要 OR_KEY（OpenRouter）。用 node --env-file=.env 运行。'); process.exit(1); }

/** 两条协议各挑一个性价比高、tool-call 可靠的模型 */
const ENDPOINTS: { id: string; provider: string; label: string; cfg: LLMConfig }[] = [
  { id: 'openai-gpt-4o-mini', provider: 'openai', label: 'OpenAI 协议 · openai/gpt-4o-mini（$0.15/$0.60 per M）',
    cfg: { flavor: 'openai', baseUrl: 'https://openrouter.ai/api/v1', model: 'openai/gpt-4o-mini', apiKey: KEY } },
  { id: 'anthropic-claude-haiku-4.5', provider: 'anthropic', label: 'Anthropic 协议 · anthropic/claude-haiku-4.5（$1/$5 per M）',
    cfg: { preset: 'custom', baseUrl: 'https://openrouter.ai/api', model: 'anthropic/claude-haiku-4.5', apiKey: KEY } },
];

const TASKS = [
  { id: '01', task: '找出 workspace 目录中所有 TODO，按照文件进行分类并生成 todo-report.md。', outputs: ['todo-report.md'],
    probe: '搜索、假阳性排除、按文件分类' },
  { id: '02', task: '读取 data/sales.txt 中的数据，计算所有产品销售额之和，并把计算结果写入 report.md。', outputs: ['report.md'],
    probe: '读取、脏数据处理、calculator、写报告（题目原句）' },
  { id: '03', task: '核对 docs/design.md 中引用的所有文件是否存在且可读，把核对结果写入 docs/check.md。', outputs: ['docs/check.md'],
    probe: '连续多次工具调用 + 2 次预期内失败（文件不存在 / 二进制）后继续' },
  { id: '11', task: '把 data/sales.txt 的销售额换算成美元写入 report-usd.md。', outputs: [],
    probe: '所需信息（汇率）不在 workspace —— 会拒绝还是编造？' },
];

const only = process.argv[2];
const GENERATED = ['todo-report.md', 'report.md', 'docs/check.md', 'report-usd.md'];
fs.mkdirSync(OUT, { recursive: true });
const rows: string[] = [];

for (const ep of ENDPOINTS) {
  for (const t of TASKS) {
    if (only && t.id !== only) continue;
    execFileSync(process.execPath, [path.join(ROOT, 'scripts/gen-workspace.ts')], { stdio: 'ignore' });
    for (const f of GENERATED) fs.rmSync(path.join(WORKSPACE, f), { force: true });

    const llm = createProvider(ep.provider, ep.cfg);
    const trace = new Trace({ provider: llm.name, workspace: 'workspace' });
    const agent = new Agent(llm, createDefaultRegistry(), WORKSPACE, { onEvent: (e) => trace.push(e) });
    const t0 = Date.now();
    let r;
    try { r = await agent.run(t.task); }
    catch (e) { console.log(`✖ ${ep.id}/${t.id}: ${(e as Error).message}`); continue; }
    const ms = Date.now() - t0;

    const dir = path.join(OUT, `${ep.id}--task-${t.id}`);
    fs.mkdirSync(dir, { recursive: true });
    trace.save(dir, 'trace');
    const produced = t.outputs.filter((f) => fs.existsSync(path.join(WORKSPACE, f)));
    for (const f of produced) fs.copyFileSync(path.join(WORKSPACE, f), path.join(dir, path.basename(f)));

    const calls = trace.events.filter((e) => e.type === 'tool_call');
    const fails = trace.events.filter((e) => e.type === 'tool_result' && !e.result.ok).length;
    const used = [...new Set(calls.map((e) => (e as any).call.name))];
    fs.writeFileSync(path.join(dir, 'README.md'),
      `# ${ep.label}\n\n**任务**（考察点：${t.probe}）\n\n> ${t.task}\n\n` +
      `**结果**: ${r.reason} · ${r.steps} steps · ${calls.length} tool calls · ${fails} failures · ${(ms / 1000).toFixed(1)}s · tokens ${r.usage.inputTokens}/${r.usage.outputTokens}\n\n` +
      `**用到的工具**: ${used.join(', ')}\n\n**最终答案**\n\n${r.answer}\n\n**生成文件**: ${produced.join(', ') || '（无）'}\n\n**Trace**: [trace.md](./trace.md)\n`);

    rows.push(`| ${t.id} | ${ep.id} | ${r.reason} | ${r.steps} | ${calls.length} | ${fails} | ${(ms / 1000).toFixed(1)}s | ${r.usage.inputTokens}/${r.usage.outputTokens} | ${used.includes('update_plan') ? '是' : '否'} |`);
    console.log(`✔ ${ep.id}/${t.id}: ${r.reason} ${r.steps} steps ${calls.length} calls ${fails} fail ${(ms / 1000).toFixed(1)}s tokens=${r.usage.inputTokens}/${r.usage.outputTokens}`);
  }
}

if (!only) {
  fs.writeFileSync(path.join(OUT, 'README.md'),
    `# 真实模型实跑记录\n\n经 OpenRouter 接入，两条协议各一个性价比模型。与 [../README.md](../README.md) 的 Mock 用例不同，这里验证的是"接上真模型能不能用"。\n\n` +
    ENDPOINTS.map((e) => `- ${e.label}`).join('\n') + '\n\n' +
    `| 任务 | 端点 | 结果 | 步数 | 工具调用 | 失败 | 耗时 | tokens in/out | 用了 update_plan |\n|---|---|---|---|---|---|---|---|---|\n` +
    rows.join('\n') + '\n\n每个子目录含该次运行的 README、生成文件与完整 Trace。\n');
}
console.log(`\n结果写入 ${path.relative(process.cwd(), OUT)}/`);
