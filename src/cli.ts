import path from 'node:path';
import { parseArgs } from 'node:util';
import { Agent } from './agent.ts';
import { createDefaultRegistry } from './tools/index.ts';
import { createProvider } from './llm/index.ts';
import { Trace } from './trace.ts';
import type { AgentEvent } from './types.ts';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    workspace: { type: 'string', short: 'w', default: 'workspace' },
    provider: { type: 'string', short: 'p' },
    'max-steps': { type: 'string', default: '15' },
    'no-write': { type: 'boolean', default: false },
    'trace-dir': { type: 'string', default: 'traces' },
    quiet: { type: 'boolean', short: 'q', default: false },
    stream: { type: 'boolean', short: 's', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

const task = positionals.join(' ').trim();
if (values.help || !task) {
  console.log(`用法: node src/cli.ts [选项] "<任务描述>"

选项:
  -w, --workspace <dir>   workspace 目录 (默认 workspace)
  -p, --provider <name>   anthropic | openai | mock (默认取 $LLM_PROVIDER，否则 mock)
      --max-steps <n>     最大轮数 (默认 15)
      --no-write          禁止 write_file
      --trace-dir <dir>   trace 输出目录 (默认 traces)
  -s, --stream            流式打印模型输出
  -q, --quiet             只输出最终答案`);
  process.exit(task ? 0 : 1);
}

const workspace = path.resolve(values.workspace!);
const llm = createProvider(values.provider);
const trace = new Trace({ provider: llm.name, workspace });
const log = (s: string) => { if (!values.quiet) console.log(s); };

let streaming = false;
const onEvent = (e: AgentEvent) => {
  trace.push(e);
  const ind = '   '.repeat(e.depth);
  const tag = e.depth > 0 ? `[${e.agent}] ` : '';
  switch (e.type) {
    case 'user': log(e.depth > 0 ? `${ind}🤖 ${tag}子任务: ${e.task}` : `\n👤 User: ${e.task}\n`); break;
    case 'delta':
      if (values.quiet || !values.stream) break;
      if (!streaming) { process.stdout.write(`${ind}🧠 ${tag}[step ${e.step}] `); streaming = true; }
      process.stdout.write(e.text);
      break;
    case 'decision':
      if (streaming) { process.stdout.write('\n'); streaming = false; }
      else log(`${ind}🧠 ${tag}[step ${e.step}] ${e.text || '(无说明)'}`);
      log(`${ind}   ⏱ LLM ${e.durationMs}ms · tokens ${e.usage.inputTokens}/${e.usage.outputTokens}`);
      break;
    case 'plan': log(`${ind}   📋 Plan: ` + e.plan.map((p) => `${p.status === 'done' ? '✔' : p.status === 'blocked' ? '✖' : p.status === 'in_progress' ? '▶' : '·'} ${p.title}`).join(' | ')); break;
    case 'tools_activated': log(`${ind}   🔍 激活工具: ${e.names.join(', ')}`); break;
    case 'compressed': log(`${ind}   🗜 Context 压缩: -${e.savedChars} 字符 → ${e.sizeChars}`); break;
    case 'tool_call': log(`${ind}   🔧 ${e.call.name} ${JSON.stringify(e.call.input).slice(0, 200)}`); break;
    case 'tool_result': {
      const body = e.result.ok ? e.result.output : e.result.error;
      const short = body.length > 300 ? body.slice(0, 300) + '…' : body;
      log(`${ind}   ${e.result.ok ? '✅' : '❌'} (${e.durationMs}ms) ${short.replace(/\n/g, '\n' + ind + '      ')}`);
      break;
    }
    case 'notice': log(`${ind}   ⚠️  ${e.message}`); break;
    case 'final':
      if (e.depth > 0) { log(`${ind}🤖 ${tag}结束 (${e.reason}, ${e.steps} steps): ${e.answer.split('\n')[0]}`); break; }
      console.log(`\n🏁 Final Answer [${e.reason}, ${e.steps} steps, tokens in/out ${e.usage.inputTokens}/${e.usage.outputTokens}]\n${e.answer}`);
      break;
  }
};

const ac = new AbortController();
let sigints = 0;
process.on('SIGINT', () => { if (++sigints === 1) { console.error('\n⏹ 收到 Ctrl+C，正在优雅中止（再按一次强制退出）…'); ac.abort(); } else process.exit(130); });

const agent = new Agent(llm, createDefaultRegistry(), workspace, {
  maxSteps: Number(values['max-steps']),
  allowWrite: !values['no-write'],
  signal: ac.signal,
  onEvent,
});

const result = await agent.run(task);
const saved = trace.save(path.resolve(values['trace-dir']!));
log(`\n📝 trace: ${path.relative(process.cwd(), saved.md)}`);
process.exit(result.reason === 'completed' ? 0 : 2);
