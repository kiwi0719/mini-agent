/**
 * 离线 Trace 审计：检查一次运行里的数值是否都有来源。
 *
 * 为什么放在循环外：把这类检查做进 Agent 循环（写入前拦截）代价不在 CPU，而在误报——
 * 千分位、日期、条目计数都会被判成"无来源"，每次误报都要多一轮模型调用去澄清，
 * 正确的任务反而被拖慢甚至带偏。放在任务结束之后做，对运行性能零影响，也不会误伤，
 * 代价是它只报告不阻止。它回答的问题是"这次运行的结论可不可信"，不是"要不要放行"。
 *
 * 来源的定义（这是整个脚本的关键）：
 *   ✔ 用户任务描述里的数字
 *   ✔ 成功的工具**结果**里的数字
 *   ✘ 模型写出的**数据**（calculator 的表达式、write_file 的正文、最终答案）—— 编造的数字
 *     正是从这里进入流水线的。gpt-4o-mini 编汇率就是把 7.15 塞进 calculator 表达式，
 *     于是结果里出现了一个"有来源"的总额，但那个总额的来源本身是无来源的。
 *     只看最终答案查不出来，必须查表达式。
 *
 * 审计范围只覆盖"数据"，不覆盖"控制"：`tail: 100`、`window: "60m"`、`max_results: 500`
 * 这些是查询参数，不是对世界的事实断言，报出来只会淹没真问题（第一版没分开，23 份 Trace 里
 * 误报了 14 份，全是这类）。因此下面显式声明每个工具的哪些字段承载事实内容；
 * 新增会产出文字的工具时要在这里补一行。
 *
 * 用法:
 *   node scripts/audit-trace.ts <trace.json>
 *   node scripts/audit-trace.ts examples/real-model/*\/trace.json
 *   node scripts/audit-trace.ts --quiet examples/...   # 只输出有问题的
 */
import fs from 'node:fs';
import path from 'node:path';

type Ev = Record<string, any>;

/**
 * 抽数前先抹掉结构性数字，否则它们会淹没真问题（实测第一版就是这样）。
 * 只用于"被检查的文本"，不用于"来源"——见 learn/inspect 处的说明。
 *  - ISO 时间戳 / 时间：`2026-09-18T21:41:48.741Z` 会被抽出 48.741
 *  - Markdown 小节号：`### 4.1 xxx` 会被抽出 4.1
 *  - 有序列表序号：`3. xxx`
 *  - IPv4：`10.0.2.12` 会被抽出 2.12
 */
function stripStructural(text: string): string {
  return text
    .replace(/\d{4}-\d{2}-\d{2}[T ][\d:.]+Z?/g, ' ')     // 时间戳
    .replace(/\b\d{1,2}:\d{2}(:\d{2}(\.\d+)?)?\b/g, ' ')  // 时刻
    .replace(/^#{1,6}\s*[\d.]+/gm, ' ')                   // 小节号
    .replace(/^\s*\d+\.\s/gm, ' ')                       // 列表序号
    .replace(/\b\d{1,3}(\.\d{1,3}){3}\b/g, ' ');          // IPv4（10.0.2.12 会被抽成 2.12）
}

/**
 * 抽取文本里的数值，归一化成可比较的键。
 * 用绝对值比较：负号常与货币符号分离（`-¥200.00` 里 `-` 后面不是数字），
 * 否则同一个金额在来源和引用处会被当成两个不同的数。编造的数字极少只差一个符号，
 * 因此按绝对值比是安全的。
 */
function numbers(text: string, strip: boolean): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of (strip ? stripStructural(text) : text).matchAll(/\d[\d,]*(?:\.\d+)?/g)) {
    const raw = m[0];
    const n = Number(raw.replace(/,/g, ''));
    if (!Number.isFinite(n)) continue;
    out.set(canon(n), raw);
  }
  return out;
}
const canon = (n: number) => String(Math.abs(n) < 1e-9 ? 0 : Number(Math.abs(n).toFixed(6)));

/**
 * 噪声过滤：这些几乎总是结构性数字而不是事实断言，报出来只会淹没真问题。
 *  - 0..31 的整数：行号、条目计数、序号、日期的日
 *  - 四位整数 1900..2100：年份
 *  已知会误报的情况：百分比换算（内容写 13%，来源是 0.13）、模型自己做的四舍五入
 *  （calculator 返回 1316.7482…，报告写 1316.75 —— 这个其实算真阳性，是模型没用工具算的值）
 */
function isNoise(n: number): boolean {
  if (Number.isInteger(n) && n >= 0 && n <= 31) return true;
  if (Number.isInteger(n) && n >= 1900 && n <= 2100) return true;
  return false;
}

/** 承载"事实内容"的字段。其余参数（路径、行数、窗口、上限、id、计划步骤）属于控制，不审计。 */
const AUDITED_FIELDS: Record<string, string[]> = {
  calculator: ['expression'],     // 参与运算的值
  write_file: ['content'],        // 交付物正文
  apply_fix: ['confirmed_by'],    // 写操作的确认信息
};

interface Finding { where: string; value: string; context: string }

export function auditTrace(events: Ev[]): { findings: Finding[]; checked: number; sources: number } {
  const known = new Map<string, string>();      // 已知来源里的数值
  const findings: Finding[] = [];
  let checked = 0;

  // 来源侧不做结构性剥离：宁可多认一些来源，也不要把合法值（例如 changelog 里
  // `## 3.9.3` 这种标题里的版本号）从来源池里删掉，否则正文引用它时会被误报。
  const learn = (text: string) => { for (const [k, v] of numbers(text, false)) known.set(k, v); };
  const inspect = (text: string, where: string) => {
    for (const [k, raw] of numbers(text, true)) {
      const n = Number(k);
      if (isNoise(n) || known.has(k)) continue;
      checked++;
      const i = text.indexOf(raw);
      findings.push({ where, value: raw, context: text.slice(Math.max(0, i - 40), i + raw.length + 40).replace(/\s+/g, ' ').trim() });
      known.set(k, raw);   // 同一个数只报一次
    }
  };

  for (const e of events) {
    switch (e.type) {
      case 'user':
        learn(e.task);                                   // 任务描述是合法来源
        break;
      case 'tool_call': {
        const fields = AUDITED_FIELDS[e.call?.name];
        if (!fields) break;                       // 控制类工具整体跳过
        for (const f of fields) {
          const v = e.call?.input?.[f];
          if (typeof v === 'string' && v) inspect(v, `step ${e.step} · ${e.call.name}.${f}`);
        }
        break;
      }
      case 'tool_result':
        if (e.result?.ok) learn(e.result.output ?? '');   // 成功的结果是合法来源
        break;
      case 'final':
        inspect(e.answer ?? '', '最终答案');
        break;
    }
  }
  return { findings, checked, sources: known.size };
}

// ---------------- CLI ----------------
const args = process.argv.slice(2);
const quiet = args.includes('--quiet');
const files = args.filter((a) => !a.startsWith('--'));
if (!files.length) { console.error('用法: node scripts/audit-trace.ts <trace.json ...> [--quiet]'); process.exit(1); }

let dirty = 0;
for (const f of files) {
  let events: Ev[];
  try { events = JSON.parse(fs.readFileSync(f, 'utf8')).events; }
  catch (e) { console.error(`✖ ${f}: 无法读取 (${(e as Error).message})`); continue; }
  const { findings, sources } = auditTrace(events);
  const name = path.relative(process.cwd(), f);
  if (!findings.length) { if (!quiet) console.log(`✔ ${name} — 全部数值可溯源（来源池 ${sources} 个数值）`); continue; }
  dirty++;
  console.log(`⚠ ${name} — ${findings.length} 个数值没有来源:`);
  for (const x of findings) console.log(`    ${x.value}  ← ${x.where}\n      …${x.context}…`);
}
if (files.length > 1) console.log(`\n${files.length} 份 Trace，${dirty} 份存在无来源数值。`);
process.exit(0);   // 审计工具只报告，不作为 CI 门禁
