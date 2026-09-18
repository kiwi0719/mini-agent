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
  /**
   * 历史工具调用的增量缓存（问题 14）。
   * Context 每次追加都会产生新的数组引用且旧内容保持前缀不变，因此以“已处理条数 + 前缀首条引用”为键做增量：
   * 每步只扫描新增的消息，时间 O(新增)、空间 O(历史条数)，而不是每步全量 O(n) 重扫导致 O(n²)。
   */
  private cache = new WeakMap<Message, { count: number; calls: Map<string, ToolCall>; hist: H[] }>();

  /** 每次调用的人工延迟（ms），用于测试排队 / 中止 / 流式展示；默认 0 */
  private delayMs = Number(process.env.MOCK_DELAY_MS ?? 0);

  async chat(_system: string, messages: readonly Message[], tools: ToolSchema[], onDelta?: (t: string) => void, signal?: AbortSignal): Promise<LLMResponse> {
    if (this.delayMs) await sleepAbortable(this.delayMs, signal);
    const task = (messages.find((m) => m.role === 'user') as { content: string }).content;
    const h = this.collectIncremental(messages);
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
      const lines = r.output.split('\n').map((l, i) => ({ n: i + 1, l: l.trim() })).filter((x) => /\b(TODO|FIXME)\b(\([^)]*\))?:/.test(x.l));
      return reply(`${file} 中共 ${lines.length} 项:\n` + lines.map((x) => `- L${x.n}: ${x.l.replace(/^\/\/\s*/, '')}`).join('\n'));
    }

    // ---------- 子任务（由 delegate 派生）：为文件生成摘要并写入 ----------
    if (/^为文件/.test(task)) {
      const [, src, dst] = task.match(/^为文件\s*([\w\/.-]+)\s*生成摘要并写入\s*([\w\/.-]+)/) ?? [];
      const r = last('read_file');
      if (!r) return reply(`读取 ${src}。`, call('read_file', { path: src }));
      if (!r.ok) return reply(`无法读取 ${src}: ${r.error}`);
      const wr = last('write_file');
      if (!wr) {
        const exports_ = [...r.output.matchAll(/export (?:async )?(?:function|interface|type|const) (\w+)/g)].map((m) => m[1]);
        const md = `# ${src}\n\n- 行数: ${r.output.split('\n').length}\n- 导出: ${exports_.join(', ') || '无'}\n- TODO/FIXME: ${r.output.split('\n').filter((l) => /\b(TODO|FIXME)\b/.test(l)).length} 处\n`;
        return reply(`生成摘要写入 ${dst}。`, call('write_file', { path: dst, content: md }));
      }
      if (!wr.ok) return reply(`摘要已生成但写入失败：${wr.error}。需要父 Agent 授予写权限。`);
      return reply(`已写入 ${dst}（${src}，导出 ${(r.output.match(/export /g) ?? []).length} 项）。`);
    }

    // ---------- 任务 A：TODO / FIXME 汇总（Plan + search_text 精化 + Sub Agent） ----------
    if (/todo|fixme/i.test(task) && !/摘要/.test(task)) {
      if (!has('update_plan')) return reply('这是多步任务，先制定计划。', plan([['搜索所有 TODO/FIXME', 'in_progress'], ['逐文件分析（委派子 Agent）', 'pending'], ['生成分类报告', 'pending']]));
      const searches = h.filter((x) => x.name === 'search_text');
      const search = searches.at(-1);
      if (!search) return reply('搜索 TODO 与 FIXME。', call('search_text', { pattern: 'TODO|FIXME' }));
      if (!search.ok) return reply('搜索失败，无法继续: ' + search.error);
      let hits = parseHits(search.output);
      const STRICT = /\b(TODO|FIXME)\b(\([^)]*\))?:/;
      const falsePositives = hits.filter((x) => !STRICT.test(x.text));
      if (searches.length === 1 && falsePositives.length) {
        return reply(`结果里混入了 ${falsePositives.length} 条假阳性（如 ${falsePositives.map((x) => x.text.match(/\w*todo\w*/i)?.[0]).filter(Boolean).slice(0, 2).join('、')}），用更严格的正则重新搜索。`,
          call('search_text', { pattern: '\\b(TODO|FIXME)\\b(\\([^)]*\\))?:' }));
      }
      hits = hits.filter((x) => STRICT.test(x.text));
      const files = [...new Set(hits.map((x) => x.file))];
      // 只对源码文件委派子 Agent 看上下文；文档/配置里的 TODO 直接用搜索结果
      const codeFiles = files.filter((f) => /^src\/.*\.ts$/.test(f));
      const delegated = h.filter((x) => x.name === 'delegate');
      const pending = codeFiles.filter((f) => !delegated.some((d) => d.input?.task?.includes(f)));
      if (pending.length && available.has('delegate')) {
        // 同一轮并行委派全部源码文件
        return reply(`确认 ${hits.length} 处，分布在 ${files.length} 个文件。其中 ${pending.length} 个源码文件并行委派子 Agent 读取上下文。`,
          ...pending.map((f) => call('delegate', { task: `分析文件 ${f}：读取它并列出其中所有 TODO/FIXME 行（含行号）。` })));
      }
      const written = last('write_file');
      if (!written) {
        const out = outName(task, 'todo-report.md');
        let md = `# TODO / FIXME 报告\n\n共 ${hits.length} 项，分布在 ${files.length} 个文件。\n\n`;
        for (const f of files) {
          const d = delegated.find((x) => x.input?.task?.includes(f));
          const fromSub = d?.ok ? d.output.split('\n').filter((l) => l.startsWith('- L')).join('\n') : '';
          const body = fromSub || hits.filter((x) => x.file === f).map((x) => `- L${x.line}: ${x.text}`).join('\n');
          md += `## ${f}\n\n${body}\n\n`;
        }
        return reply('子 Agent 全部返回，更新计划并生成报告。',
          plan([['搜索所有 TODO/FIXME', 'done'], ['逐文件分析（委派子 Agent）', 'done', `${delegated.length} 个子 Agent`], ['生成分类报告', 'in_progress']]),
          call('write_file', { path: out, content: md }));
      }
      if (!written.ok) return reply('写入报告失败: ' + written.error);
      return reply(`完成。严格匹配到 ${hits.length} 处 TODO/FIXME（排除了 todoList/TODOS 等假阳性），分布在 ${files.length} 个文件，${delegated.length} 个源码文件由子 Agent 并行分析，报告已写入 ${written.input.path}。`);
    }

    // ---------- 任务 F：多地区聚合（list_files + 并行 read_file + 格式归一 + 并行 calculator） ----------
    if (/地区|regions/i.test(task)) {
      if (!has('update_plan')) return reply('制定计划。', plan([['列出 data/regions 下的文件', 'in_progress'], ['并行读取并归一化金额', 'pending'], ['分地区求和与总计', 'pending'], ['写入报告', 'pending']]));
      const ls = last('list_files');
      if (!ls) return reply('先看有哪些地区文件。', call('list_files', { path: 'data/regions' }));
      if (!ls.ok) return reply('无法列出目录: ' + ls.error);
      const regionFiles = ls.output.split('\n').filter(Boolean);
      const reads = h.filter((x) => x.name === 'read_file');
      if (!reads.length) return reply(`${regionFiles.length} 个文件互不依赖，一轮并行读取。`, ...regionFiles.map((f) => call('read_file', { path: f })));
      const parsed = regionFiles.map((f) => {
        const r = reads.find((x) => x.input?.path === f);
        const region = f.replace(/^.*\//, '').replace(/\..*$/, '');
        const rows: { name: string; amount: number }[] = []; const skipped: string[] = [];
        if (r?.ok) for (const raw of r.output.split('\n')) {
          const line = raw.trim();
          if (!line || line.startsWith('#') || /^region,/.test(line)) continue;
          // 两种格式：CSV（region,product,amount，amount 可能带引号/¥/千分位，甚至未加引号的 "1,999.00"）；点线对齐的手工文本
          let name = '', amt = '';
          const csv = line.match(/^\w+,([^,]+),(.+)$/);
          const dotted = line.match(/^(.+?)\s*\.{3,}\s*(.+)$/);
          if (csv) { name = csv[1]; amt = csv[2]; } else if (dotted) { name = dotted[1]; amt = dotted[2]; } else { skipped.push(line); continue; }
          const n = Number(amt.replace(/["¥$,\s]/g, ''));
          if (Number.isNaN(n)) skipped.push(line); else rows.push({ name: name.trim(), amount: n });
        }
        return { file: f, region, ok: !!r?.ok, error: r?.error, rows, skipped };
      });
      const calcs = h.filter((x) => x.name === 'calculator');
      if (!calcs.length) return reply(`归一化完成（去掉 ¥ 与千分位、退款为负数，跳过 ${parsed.reduce((n, p) => n + p.skipped.length, 0)} 条无法解析）。分地区并行求和，再求总计。`,
        ...parsed.map((p) => call('calculator', { expression: `sum(${p.rows.map((r) => r.amount).join(', ') || '0'})` })),
        call('calculator', { expression: `sum(${parsed.flatMap((p) => p.rows.map((r) => r.amount)).join(', ')})` }));
      const val = (c: H) => c.ok ? c.output.split('=').at(-1)!.trim() : `计算失败: ${c.error}`;
      const written = last('write_file');
      if (!written) {
        const out = outName(task, 'report-regions.md');
        let md = `# 地区销售汇总\n\n| 地区 | 文件 | 有效记录 | 销售额 |\n|---|---|---|---|\n`;
        parsed.forEach((p, i) => { md += `| ${p.region} | ${p.file} | ${p.rows.length} | ${val(calcs[i])} |\n`; });
        md += `| **合计** | | ${parsed.reduce((n, p) => n + p.rows.length, 0)} | **${val(calcs.at(-1)!)}** |\n\n`;
        md += `## 处理说明\n\n- 金额去除 ¥ 与千分位分隔符；\`Refund\` 行为负数计入\n- 跳过无法解析的记录:\n` + parsed.flatMap((p) => p.skipped.map((l) => `  - ${p.file}: \`${l}\``)).join('\n') + '\n';
        return reply('写入报告。', plan([['列出 data/regions 下的文件', 'done'], ['并行读取并归一化金额', 'done'], ['分地区求和与总计', 'done', `合计 ${val(calcs.at(-1)!)}`], ['写入报告', 'in_progress']]), call('write_file', { path: out, content: md }));
      }
      return reply(`完成。${parsed.length} 个地区合计 ${val(calcs.at(-1)!)}（${parsed.map((p, i) => `${p.region} ${val(calcs[i])}`).join('，')}），报告已写入 ${written.input.path}。`);
    }

    // ---------- 任务 G：大 changelog（触发 Context 压缩）+ 并行核对文件 ----------
    if (/changelog|breaking/i.test(task)) {
      if (!has('update_plan')) return reply('制定计划。', plan([['读取 changelog', 'in_progress'], ['提取 BREAKING 条目与涉及文件', 'pending'], ['并行核对文件是否存在', 'pending'], ['写入报告', 'pending']]));
      const cl = h.find((x) => x.name === 'read_file');
      if (!cl) return reply('读取 docs/changelog.md。', call('read_file', { path: 'docs/changelog.md' }));
      if (!cl.ok) return reply('无法读取 changelog: ' + cl.error);
      const entries: { ver: string; text: string; file: string }[] = [];
      let ver = '';
      for (const line of cl.output.split('\n')) {
        const v = line.match(/^## (\d+\.\d+\.\d+)/); if (v) ver = v[1];
        const b = line.match(/^- \*\*BREAKING\*\* (.+?)（`([^`]+)`）/); if (b) entries.push({ ver, text: b[1], file: b[2] });
      }
      const files = [...new Set(entries.map((e) => e.file))];
      const checks = h.filter((x) => x.name === 'read_file').slice(1);
      if (!checks.length) return reply(`提取到 ${entries.length} 条 BREAKING，涉及 ${files.length} 个文件，一轮并行核对存在性。`, ...files.map((f) => call('read_file', { path: f, start_line: 1, end_line: 1 })));
      const status = new Map(files.map((f) => [f, checks.find((c) => c.input?.path === f)]));
      const written = last('write_file');
      if (!written) {
        const out = outName(task, 'breaking-changes.md');
        let md = `# Breaking Changes（${entries.length} 条）\n\n## 涉及文件核对\n\n| 文件 | 状态 |\n|---|---|\n`;
        for (const f of files) { const c = status.get(f); md += `| ${f} | ${c?.ok ? '✅ 存在' : `❌ ${c?.error ?? '未核对'}`} |\n`; }
        md += `\n## 条目\n\n| 版本 | 变更 | 文件 |\n|---|---|---|\n` + entries.map((e) => `| ${e.ver} | ${e.text} | ${e.file} |`).join('\n') + '\n';
        return reply('写入报告。', plan([['读取 changelog', 'done'], ['提取 BREAKING 条目与涉及文件', 'done', `${entries.length} 条`], ['并行核对文件是否存在', 'done', `${[...status.values()].filter((c) => !c?.ok).length} 个缺失`], ['写入报告', 'in_progress']]), call('write_file', { path: out, content: md }));
      }
      const missing = files.filter((f) => !status.get(f)?.ok);
      return reply(`完成。${entries.length} 条 BREAKING 变更涉及 ${files.length} 个文件，其中 ${missing.length} 个已不存在（${missing.join(', ')}），报告已写入 ${written.input.path}。`);
    }

    // ---------- 任务 H：超大日志（read_file 超限 → search_text；结果截断 → 分类型搜索） ----------
    if (/huge\.log|ERROR|日志/i.test(task)) {
      if (!has('update_plan')) return reply('制定计划。', plan([['读取日志', 'in_progress'], ['按错误类型统计', 'pending'], ['写入报告', 'pending']]));
      const rd = last('read_file');
      if (!rd) return reply('读取 data/huge.log。', call('read_file', { path: 'data/huge.log' }));
      const searches = h.filter((x) => x.name === 'search_text');
      if (!searches.length) return reply(`read_file 失败（${rd.error}）。文件太大，改用 search_text 只取 ERROR 行。`, plan([['读取日志', 'skipped', '超过 read_file 上限'], ['用 search_text 提取 ERROR 行', 'in_progress'], ['按错误类型统计', 'pending'], ['写入报告', 'pending']], 'read_file 超限，改用搜索'), call('search_text', { pattern: 'ERROR \\[\\w+\\]', path: 'data', max_results: 500 }));
      const first = JSON.parse(searches[0].output) as { total: number; truncated: boolean; matches: { text: string }[] };
      const types = [...new Set(first.matches.map((m) => m.text.match(/\[(\w+)\]/)?.[1]).filter(Boolean))] as string[];
      if (searches.length === 1) {
        if (!first.truncated) { /* 未截断，直接统计 */ }
        else return reply(`结果被截断（${first.total} 条上限），不能直接计数。发现 ${types.length} 种错误类型，改为每种类型单独搜索，一轮并行。`, ...types.map((t) => call('search_text', { pattern: `ERROR \\[${t}\\]`, path: 'data/huge.log', max_results: 500 })));
      }
      const failedSearches = searches.slice(1).filter((x) => !x.ok);
      if (failedSearches.length) return reply(`分类型搜索失败: ${failedSearches.map((x) => x.error).join('; ')}。无法完成统计。`);
      const perType = first.truncated
        ? types.map((t, i) => ({ type: t, count: (JSON.parse(searches[1 + i].output) as { total: number }).total }))
        : types.map((t) => ({ type: t, count: first.matches.filter((m) => m.text.includes(`[${t}]`)).length }));
      const calc = last('calculator');
      if (!calc) return reply('各类型计数完成，用 calculator 求总数。', call('calculator', { expression: `sum(${perType.map((p) => p.count).join(', ')})` }));
      const total = calc.output.split('=').at(-1)!.trim();
      const written = last('write_file');
      if (!written) {
        const out = outName(task, 'error-report.md');
        const md = `# 错误统计（data/huge.log）\n\n| 错误类型 | 次数 |\n|---|---|\n` + perType.sort((a, b) => b.count - a.count).map((p) => `| ${p.type} | ${p.count} |`).join('\n') + `\n| **合计** | **${total}** |\n\n> 日志文件超过 read_file 上限，统计基于 search_text 分类型计数。\n`;
        return reply('写入报告。', call('write_file', { path: out, content: md }));
      }
      return reply(`完成。共 ${total} 条 ERROR，${perType.length} 种类型（${perType.map((p) => `${p.type} ${p.count}`).join('，')}），报告已写入 ${written.input.path}。`);
    }

    // ---------- 任务 I：诱导死循环（等待永远不会就绪的锁）——模拟“固执”的弱模型 ----------
    if (/lock\.txt|READY|等待/i.test(task)) {
      const rd = last('read_file');
      if (rd?.ok && /STATUS=READY/.test(rd.output)) return reply('锁已就绪，可以继续。');
      // 无视系统提示，坚持轮询同一文件 → Agent 应先提醒、再判定死循环终止
      return reply(rd ? '还没就绪，再检查一次。' : '先检查锁状态。', call('read_file', { path: 'data/lock.txt' }));
    }

    // ---------- 任务 J：子 Agent 写权限（默认只读 → 失败 → 父 Agent 授予 allow_write 重派） ----------
    if (/摘要|summar/i.test(task)) {
      if (!has('update_plan')) return reply('制定计划。', plan([['列出 src 下的 ts 文件', 'in_progress'], ['委派子 Agent 生成摘要', 'pending'], ['汇总', 'pending']]));
      const ls = last('list_files');
      if (!ls) return reply('列出源码文件。', call('list_files', { path: 'src' }));
      const files = ls.ok ? ls.output.split('\n').filter((f) => f.endsWith('.ts')) : [];
      const dst = (f: string) => `docs/summaries/${f.replace(/^src\//, '').replace(/\//g, '-').replace(/\.ts$/, '.md')}`;
      const dels = h.filter((x) => x.name === 'delegate');
      if (!dels.length) return reply(`${files.length} 个文件。先委派一个试试。`, call('delegate', { task: `为文件 ${files[0]} 生成摘要并写入 ${dst(files[0])}` }));
      const succeeded = new Set(dels.filter((d) => d.ok && !/写入失败/.test(d.output)).map((d) => d.input.task.match(/为文件\s*(\S+)/)![1]));
      const remaining = files.filter((f) => !succeeded.has(f));
      const needWrite = dels.some((d) => /写权限|写入失败/.test(d.ok ? d.output : d.error));
      if (remaining.length && needWrite && dels.length === 1) {
        return reply('子 Agent 报告没有写权限（默认只读）。这个子任务确实需要写文件，重派时授予 allow_write，其余文件同一轮并行委派。',
          plan([['列出 src 下的 ts 文件', 'done'], ['委派子 Agent 生成摘要', 'in_progress', '首个子 Agent 因只读失败，改为授予写权限'], ['汇总', 'pending']], '子 Agent 默认只读，需显式授权'),
          ...remaining.map((f) => call('delegate', { task: `为文件 ${f} 生成摘要并写入 ${dst(f)}`, allow_write: true })));
      }
      if (remaining.length) return reply(`仍有 ${remaining.length} 个未完成: ${remaining.join(', ')}。`, ...remaining.map((f) => call('delegate', { task: `为文件 ${f} 生成摘要并写入 ${dst(f)}`, allow_write: true })));
      return reply(`完成。${files.length} 个源码文件的摘要已由子 Agent 写入 docs/summaries/（首次委派因子 Agent 默认只读失败，授予 allow_write 后重派成功；共 ${dels.length} 次委派）。`);
    }

    // ---------- 任务 K：信息不在 workspace 中（汇率）→ 明确判断无法完成 ----------
    if (/美元|USD|汇率/i.test(task)) {
      if (!has('update_plan')) return reply('制定计划。', plan([['读取销售数据', 'in_progress'], ['查找汇率', 'pending'], ['换算并写入', 'pending']]));
      const rd = last('read_file');
      if (!rd) return reply('读取 data/sales.txt。', call('read_file', { path: 'data/sales.txt' }));
      const sr = last('search_text');
      if (!sr) return reply('任务没有给出汇率，先在 workspace 里找有没有汇率配置。', call('search_text', { pattern: '汇率|exchange|USD|CNY|rate' }));
      const found = sr.ok ? (JSON.parse(sr.output).matches as { text: string }[]).filter((m) => /\d+(\.\d+)?\s*(USD|CNY|美元)/i.test(m.text)) : [];
      if (!found.length) return reply('无法完成：换算成美元需要人民币兑美元汇率，但任务没有提供，workspace 中也没有任何汇率配置（搜索 "汇率|exchange|USD|CNY|rate" 无有效结果）。我不会猜一个汇率写进报告。请提供汇率（例如 "1 USD = 7.2 CNY"）后重试；销售数据本身已读取成功，共 6 条有效记录。');
      return reply('找到汇率，但本 Mock 未实现换算分支。');
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
        const out = outName(task, 'report.md');
        let md = `# 销售报告\n\n| 产品 | 销售额 |\n|---|---|\n`;
        for (const [name, amount] of data.rows) md += `| ${name} | ${amount} |\n`;
        md += `| **合计** | **${total}** |\n`;
        if (data.invalid.length) md += `\n> 跳过 ${data.invalid.length} 条无法解析的记录:\n` + data.invalid.map((x) => `> - 第 ${x.line} 行 "${x.text}"：${x.reason}`).join('\n') + '\n';
        return reply('生成报告。', plan([['解析销售数据文件', 'done'], ['计算销售额之和', 'done', `合计 ${total}`], ['写入报告', 'in_progress']]), call('write_file', { path: out, content: md }));
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
        const out = outName(task, 'docs/check.md');
        let md = `# 文档引用核对\n\n来源: ${doc}\n\n| 文件 | 状态 | 说明 |\n|---|---|---|\n`;
        for (const r of uniq) {
          const res = reads.find((x) => x.input?.path === r)!;
          md += `| ${r} | ${res.ok ? '✅ 存在' : '❌ 异常'} | ${res.ok ? `${res.output.split('\n').length} 行` : res.error} |\n`;
        }
        if (failed.length) md += `\n## 异常文件\n\n` + failed.map((f) => `- ${f.input.path}: ${f.error}`).join('\n') + '\n';
        return reply('核对完毕，写入结果。', plan([[`读取 ${doc}`, 'done'], ['逐个读取引用文件', 'done'], ['汇总异常文件清单', 'done', `${failed.length} 个`], ['写入核对结果', 'in_progress']]), call('write_file', { path: out, content: md }));
      }
      if (!written.ok) return reply('写入失败: ' + written.error);
      return reply(`完成。核对 ${uniq.length} 个引用文件，${failed.length} 个有问题（${failed.map((f) => f.input.path).join(', ') || '无'}），结果已写入 ${written.input?.path}。`);
    }

    // ---------- 兜底 ----------
    const ls = last('list_files');
    if (!ls) return reply('我先看看 workspace 里有什么。', call('list_files', {}));
    return reply('Mock LLM 不理解这个任务，无法继续。workspace 文件如下:\n' + (ls.ok ? ls.output : ls.error));
  }

  private collectIncremental(messages: readonly Message[]): H[] {
    const key = messages[0]; // 每次 run 的首条 user 消息对象唯一且不变，作为该对话的缓存键
    let c = this.cache.get(key);
    if (!c || c.count > messages.length) { c = { count: 0, calls: new Map(), hist: [] }; this.cache.set(key, c); }
    for (let i = c.count; i < messages.length; i++) {
      const m = messages[i];
      if (m.role === 'assistant') for (const tc of m.toolCalls) c.calls.set(tc.id, tc);
      if (m.role === 'tool') for (const r of m.results) {
        const tc = c.calls.get(r.callId);
        c.hist.push({ name: r.name, input: tc?.input ?? {}, ok: r.result.ok, output: r.result.ok ? r.result.output : '', error: r.result.ok ? '' : r.result.error });
      }
    }
    c.count = messages.length;
    return c.hist;
  }
}

// ----- helpers -----
type H = { name: string; input: any; ok: boolean; output: string; error: string };
/** 从任务里取输出文件名：优先 “写入/生成 X.md”，避免误取任务中提到的输入文件（如 changelog.md） */
function outName(task: string, fallback: string): string {
  return task.match(/(?:写入|生成|输出到|保存到|到)\s*`?([\w\/.-]+\.md)/)?.[1] ?? fallback;
}
function parseHits(s: string): { file: string; line: number; text: string }[] {
  try { return JSON.parse(s).matches ?? []; } catch { return []; }
}
function estimateTokens(messages: readonly Message[]): number { return Math.round(JSON.stringify(messages).length / 3); }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function sleepAbortable(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('aborted'));
    const t = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(t); reject(new Error('aborted')); };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
