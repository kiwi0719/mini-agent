import fs from 'node:fs';
import path from 'node:path';
import type { AgentEvent } from './types.ts';

/** 记录 User → Decision → ToolCall → ToolResult → … → Final，可导出 JSON 与 Markdown */
export class Trace {
  readonly events: AgentEvent[] = [];
  readonly startedAt = Date.now();

  readonly meta: { provider: string; workspace: string };
  constructor(meta: { provider: string; workspace: string }) { this.meta = meta; }

  push(e: AgentEvent) { this.events.push(e); }

  toJSON() { return { meta: this.meta, startedAt: this.startedAt, events: this.events }; }

  toMarkdown(): string {
    const lines: string[] = [`# Agent Trace`, ``, `- provider: ${this.meta.provider}`, `- workspace: ${this.meta.workspace}`, `- time: ${new Date(this.startedAt).toISOString()}`, ``];
    for (const e of this.events) {
      const tag = e.depth > 0 ? ` [${e.agent}]` : '';
      switch (e.type) {
        case 'delta': break; // 流式增量不单独记录，decision 中已有完整文本
        case 'user': lines.push(e.depth > 0 ? `### 🤖 Sub Agent ${e.agent} 接到任务` : `## 👤 User`, '', '```', e.task, '```', ''); break;
        case 'plan': lines.push(`### 📋 Plan${tag} (step ${e.step})`, '', ...e.plan.map((p) => `- [${p.status === 'done' ? 'x' : ' '}] ${p.id}. ${p.title} — ${p.status}${p.note ? ` (${p.note})` : ''}`), ''); break;
        case 'tools_activated': lines.push(`> 🔍 Tool Search 激活: ${e.names.join(', ')}`, ''); break;
        case 'decision':
          lines.push(`## 🧠 Agent Decision${tag} (step ${e.step})`, '', e.text || '_(无文字说明)_', '');
          if (e.toolCalls.length) lines.push(`→ 决定调用 ${e.toolCalls.length} 个工具: ${e.toolCalls.map((c) => c.name).join(', ')}`, '');
          lines.push(`_LLM ${e.durationMs}ms · tokens in ${e.usage.inputTokens} / out ${e.usage.outputTokens}_`, '');
          break;
        case 'tool_call': lines.push(`### 🔧 Tool Call${tag}: \`${e.call.name}\``, '', '```json', JSON.stringify(e.call.input, null, 2), '```', ''); break;
        case 'tool_result': {
          const body = e.result.ok ? e.result.output : e.result.error;
          lines.push(`### ${e.result.ok ? '✅' : '❌'} Tool Result${tag}: \`${e.name}\` (${e.durationMs}ms)`, '', '```', truncate(body, 1500), '```', '');
          break;
        }
        case 'notice': lines.push(`> ⚠️ ${e.message}`, ''); break;
        case 'final': lines.push(e.depth > 0 ? `### 🤖 Sub Agent ${e.agent} 结束 (${e.reason}, ${e.steps} steps)` : `## 🏁 Final Answer (${e.reason}, ${e.steps} steps, tokens in ${e.usage.inputTokens} / out ${e.usage.outputTokens})`, '', e.answer, ''); break;
      }
    }
    return lines.join('\n');
  }

  save(dir: string, name = `trace-${new Date(this.startedAt).toISOString().replace(/[:.]/g, '-')}`) {
    fs.mkdirSync(dir, { recursive: true });
    const json = path.join(dir, `${name}.json`);
    const md = path.join(dir, `${name}.md`);
    fs.writeFileSync(json, JSON.stringify(this.toJSON(), null, 2));
    fs.writeFileSync(md, this.toMarkdown());
    return { json, md };
  }
}

function truncate(s: string, n: number) { return s.length > n ? s.slice(0, n) + `\n…[截断 ${s.length - n} 字符]` : s; }
