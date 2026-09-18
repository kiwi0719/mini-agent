import type { LLMProvider, LLMResponse, Message, ToolSchema, ToolCall, PlanStep } from '../types.ts';

/**
 * 规则驱动的 Mock LLM，用于无 API 条件下验证 Agent Loop 及全部增强项
 * （Plan / 动态调整 / Sub Agent / Tool Search / Streaming）。
 * 它像真模型一样只看消息历史（尤其是最近的 tool result）决定下一步，会对失败做出反应。
 * 仅覆盖 3 类内置任务 + 子任务 + 通用兜底。
 */
export class MockLLM implements LLMProvider {
  readonly name = 'mock';
  private counter = 0;

  async chat(_system: string, messages: Message[], tools: ToolSchema[], onDelta?: (t: string) => void): Promise<LLMResponse> {
    const task = (messages.find((m) => m.role === 'user') as { content: string }).content;
    const h = collect(messages);
    const available = new Set(tools.map((t) => t.name));
    const usage = { inputTokens: estimateTokens(messages), outputTokens: 80 };
    const call = (name: string, input: unknown): ToolCall => ({ id: `mock_${++this.counter}`, name, input });
    const reply = async (text: string, ...toolCalls: ToolCall[]): Promise<LLMResponse> => {
      // 模拟流式输出：按 6 个字符一段推送
      if (onDelta) for (let i = 0; i < text.length; i += 6) { onDelta(text.slice(i, i + 6)); await sleep(5); }
      return { text, toolCalls, usage, stopReason: toolCalls.length ? 'tool_use' : 'end_turn' };
    };
    const plan = (steps: [string, PlanStep['status'], string?][], reason?: string) =>
      call('update_plan', { steps: steps.map(([title, status, note], i) => ({ id: i + 1, title, status, ...(note ? { note } : {}) })), ...(reason ? { reason } : {}) });
    const has = (name: string) => h.some((x) => x.name === name);
    const last = (name: string) => h.filter((x) => x.name === name).at(-1);

    // ---------- 子任务（由 delegate 派生）：分析单个文件的 TODO/FIXME ----------
    if (/^分析文件/.test(task)) {
      const file = task.match(/分析文件\s*([\w\/.-]+)/)![1];
      const r = last('read_file');
      if (!r) return reply(`读取 ${file}。`, call('read_file', { path: file }));
      if (!r.ok) return reply(`无法读取 ${file}: ${r.error}`);
      const lines = r.output.split('\n').map((l, i) => ({ n: i + 1, l: l.trim() })).filter((x) => /TODO|FIXME/.test(x.l));
      return reply(`${file} 中共 ${lines.length} 项:\n` + lines.map((x) => `- L${x.n}: ${x.l.replace(/^\/\/\s*/, '')}`).join('\n'));
    }

    // ---------- 任务 A：TODO / FIXME 汇总（Plan + search_text + Sub Agent） ----------
    if (/todo|fixme/i.test(task)) {
      if (!has('update_plan')) return reply('这是多步任务，先制定计划。', plan([['搜索所有 TODO/FIXME', 'in_progress'], ['逐文件分析（委派子 Agent）', 'pending'], ['生成分类报告', 'pending']]));
      const search = last('search_text');
      if (!search) return reply('搜索 TODO 与 FIXME。', call('search_text', { pattern: 'TODO|FIXME' }));
      if (!search.ok) return reply('搜索失败，无法继续: ' + search.error);
      const hits = parseHits(search.output);
      const files = [...new Set(hits.map((x) => x.file))];
      const delegated = h.filter((x) => x.name === 'delegate');
      const pending = files.filter((f) => !delegated.some((d) => d.input?.task?.includes(f)));
      if (pending.length && available.has('delegate')) {
        return reply(`找到 ${hits.length} 处，分布在 ${files.length} 个文件。委派子 Agent 分析 ${pending[0]}。`, call('delegate', { task: `分析文件 ${pending[0]}：读取它并列出其中所有 TODO/FIXME 行（含行号）。` }));
      }
      const written = last('write_file');
      if (!written) {
        const outName = task.match(/([\w-]+\.md)/)?.[1] ?? 'todo-report.md';
        let md = `# TODO / FIXME 报告\n\n共 ${hits.length} 项，分布在 ${files.length} 个文件。\n\n`;
        for (const f of files) {
          const d = delegated.find((x) => x.input?.task?.includes(f));
          const fromSub = d?.ok ? d.output.split('\n').filter((l) => l.startsWith('- L')).join('\n') : '';
          const body = fromSub || hits.filter((x) => x.file === f).map((x) => `- L${x.line}: ${x.text}`).join('\n');
          md += `## ${f}\n\n${body}\n\n`;
        }
        return reply('子 Agent 全部返回，更新计划并生成报告。',
          plan([['搜索所有 TODO/FIXME', 'done'], ['逐文件分析（委派子 Agent）', 'done', `${delegated.length} 个子 Agent`], ['生成分类报告', 'in_progress']]),
          call('write_file', { path: outName, content: md }));
      }
      if (!written.ok) return reply('写入报告失败: ' + written.error);
      return reply(`完成。共找到 ${hits.length} 处 TODO/FIXME，分布在 ${files.length} 个文件（${files.join(', ')}），已由 ${delegated.length} 个子 Agent 分析并汇总到 ${written.input.path}。`);
    }

    // ---------- 任务 B：销售数据求和（Plan + Tool Search + calculator） ----------
    if (/销售|sales/i.test(task)) {
      const p = task.match(/([\w\/.-]+\.txt)/)?.[1] ?? 'sales.txt';
      if (!has('update_plan')) return reply('制定计划。', plan([['解析销售数据文件', 'in_progress'], ['计算销售额之和', 'pending'], ['写入报告', 'pending']]));
      if (!has('search_tools') && !available.has('csv_parse')) return reply('数据是表格格式，先看看有没有更合适的解析工具。', call('search_tools', { query: 'csv 解析' }));
      const csv = last('csv_parse');
      if (!csv) {
        if (available.has('csv_parse')) return reply('使用 csv_parse 解析文件（金额列为数字）。', call('csv_parse', { path: p, numeric_columns: [1] }));
        return reply('没有找到解析工具，退回到 read_file。', call('read_file', { path: p }));
      }
      if (!csv.ok) {
        const ls = last('list_files');
        if (!ls) return reply(`解析失败（${csv.error}），先列出文件确认路径。`, call('list_files', {}));
        const candidate = ls.ok ? ls.output.split('\n').find((l) => /sales/i.test(l)) : undefined;
        if (candidate && h.filter((x) => x.name === 'csv_parse').length < 2) return reply(`找到 ${candidate}，重新解析。`, call('csv_parse', { path: candidate, numeric_columns: [1] }));
        return reply('无法读取销售数据文件，任务无法继续: ' + csv.error);
      }
      const data = JSON.parse(csv.output) as { rows: [string, number][]; invalid: { line: number; text: string; reason: string }[] };
      const calc = last('calculator');
      if (!calc) return reply(`解析出 ${data.rows.length} 条有效记录，跳过 ${data.invalid.length} 条脏数据。用 calculator 精确求和。`, call('calculator', { expression: `sum(${data.rows.map((r) => r[1]).join(', ')})` }));
      if (!calc.ok) return reply('计算失败: ' + calc.error);
      const total = calc.output.split('=').at(-1)!.trim();
      const written = last('write_file');
      if (!written) {
        const outName = task.match(/([\w-]+\.md)/)?.[1] ?? 'report.md';
        let md = `# 销售报告\n\n| 产品 | 销售额 |\n|---|---|\n`;
        for (const [name, amount] of data.rows) md += `| ${name} | ${amount} |\n`;
        md += `| **合计** | **${total}** |\n`;
        if (data.invalid.length) md += `\n> 跳过 ${data.invalid.length} 条无法解析的记录:\n` + data.invalid.map((x) => `> - 第 ${x.line} 行 "${x.text}"：${x.reason}`).join('\n') + '\n';
        return reply('生成报告。', plan([['解析销售数据文件', 'done'], ['计算销售额之和', 'done', `合计 ${total}`], ['写入报告', 'in_progress']]), call('write_file', { path: outName, content: md }));
      }
      if (!written.ok) return reply('写入报告失败: ' + written.error);
      return reply(`完成。${data.rows.length} 个产品销售额之和为 ${total}（跳过 ${data.invalid.length} 条脏数据），报告已写入 ${written.input.path}。`);
    }

    // ---------- 任务 C：核对引用文件（Plan + 失败后动态调整计划） ----------
    if (/核对|引用|check|reference/i.test(task)) {
      const doc = task.match(/([\w\/.-]+\.md)/)?.[1] ?? 'docs/design.md';
      if (!has('update_plan')) return reply('制定计划。', plan([[`读取 ${doc}`, 'in_progress'], ['逐个读取引用文件', 'pending'], ['写入核对结果', 'pending']]));
      const first = h.find((x) => x.name === 'read_file');
      if (!first) return reply(`读取 ${doc}。`, call('read_file', { path: doc }));
      if (!first.ok) return reply('无法读取文档，任务终止: ' + first.error);
      const uniq = [...new Set([...first.output.matchAll(/`([\w\/.-]+\.(?:ts|md|txt|json|bin))`/g)].map((m) => m[1]).filter((r) => r !== doc))];
      const reads = h.filter((x) => x.name === 'read_file').slice(1);
      const failed = reads.filter((x) => !x.ok);
      // 动态调整：第一次遇到失败后修订计划（加一步“记录异常文件”，并把失败标注进 note）
      const plans = h.filter((x) => x.name === 'update_plan');
      if (failed.length && plans.length < 2) {
        return reply(`${failed[0].input.path} 读取失败，这不是致命错误——调整计划，继续核对其余文件并单独记录异常。`,
          plan([[`读取 ${doc}`, 'done'], ['逐个读取引用文件', 'in_progress', `${failed[0].input.path}: ${failed[0].error}`], ['汇总异常文件清单', 'pending'], ['写入核对结果', 'pending']], '引用文件缺失/不可读，需要在结果中单独列出'));
      }
      const next = uniq.find((r) => !reads.some((x) => x.input?.path === r));
      if (next) return reply(`核对引用文件 ${next}。`, call('read_file', { path: next }));
      const written = last('write_file');
      if (!written) {
        const outName = task.match(/(?:写入|生成|到)\s*`?([\w\/.-]+\.md)/)?.[1] ?? 'docs/check.md';
        let md = `# 文档引用核对\n\n来源: ${doc}\n\n| 文件 | 状态 | 说明 |\n|---|---|---|\n`;
        for (const r of uniq) {
          const res = reads.find((x) => x.input?.path === r)!;
          md += `| ${r} | ${res.ok ? '✅ 存在' : '❌ 异常'} | ${res.ok ? `${res.output.split('\n').length} 行` : res.error} |\n`;
        }
        if (failed.length) md += `\n## 异常文件\n\n` + failed.map((f) => `- ${f.input.path}: ${f.error}`).join('\n') + '\n';
        return reply('核对完毕，写入结果。', plan([[`读取 ${doc}`, 'done'], ['逐个读取引用文件', 'done'], ['汇总异常文件清单', 'done', `${failed.length} 个`], ['写入核对结果', 'in_progress']]), call('write_file', { path: outName, content: md }));
      }
      if (!written.ok) return reply('写入失败: ' + written.error);
      return reply(`完成。核对 ${uniq.length} 个引用文件，${failed.length} 个有问题（${failed.map((f) => f.input.path).join(', ') || '无'}），结果已写入 ${written.input?.path}。`);
    }

    // ---------- 兜底 ----------
    const ls = last('list_files');
    if (!ls) return reply('我先看看 workspace 里有什么。', call('list_files', {}));
    return reply('Mock LLM 不理解这个任务，无法继续。workspace 文件如下:\n' + (ls.ok ? ls.output : ls.error));
  }
}

// ----- helpers -----
type H = { name: string; input: any; ok: boolean; output: string; error: string };
function collect(messages: Message[]): H[] {
  const calls = new Map<string, ToolCall>();
  const out: H[] = [];
  for (const m of messages) {
    if (m.role === 'assistant') for (const c of m.toolCalls) calls.set(c.id, c);
    if (m.role === 'tool') for (const r of m.results) {
      const c = calls.get(r.callId);
      out.push({ name: r.name, input: c?.input ?? {}, ok: r.result.ok, output: r.result.ok ? r.result.output : '', error: r.result.ok ? '' : r.result.error });
    }
  }
  return out;
}
function parseHits(s: string): { file: string; line: number; text: string }[] {
  try { return JSON.parse(s).matches ?? []; } catch { return []; }
}
function estimateTokens(messages: Message[]): number { return Math.round(JSON.stringify(messages).length / 3); }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
