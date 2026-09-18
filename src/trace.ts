import fs from 'node:fs';
import path from 'node:path';
import type { AgentEvent } from './types.ts';

/** 子 Agent 树节点：一个 Agent 的全部事件 + 它派生出的子 Agent */
export interface TraceNode {
  agent: string;
  depth: number;
  parentCallId?: string;
  events: AgentEvent[];
  children: TraceNode[];
}

/** 记录 User → Decision → ToolCall → ToolResult → … → Final，可导出 JSON / Markdown / 按 Agent 分组的树 */
export class Trace {
  readonly events: AgentEvent[] = [];
  readonly startedAt = Date.now();
  readonly meta: { provider: string; workspace: string };

  constructor(meta: { provider: string; workspace: string }) { this.meta = meta; }

  push(e: AgentEvent) { this.events.push(e); }

  /** 线性事件流按 agent 分组并还原成父子树（问题 3：程序化分析不用自己按 agent 拆） */
  toTree(): TraceNode {
    const nodes = new Map<string, TraceNode>();
    for (const e of this.events) {
      let n = nodes.get(e.agent);
      if (!n) { n = { agent: e.agent, depth: e.depth, parentCallId: e.parentCallId, events: [], children: [] }; nodes.set(e.agent, n); }
      n.events.push(e);
    }
    for (const e of this.events) {
      if (e.parent && e.type === 'user') nodes.get(e.parent)?.children.push(nodes.get(e.agent)!);
    }
    return nodes.get('main') ?? [...nodes.values()].find((n) => n.depth === 0) ?? { agent: 'main', depth: 0, events: [], children: [] };
  }

  toJSON() { return { meta: this.meta, startedAt: this.startedAt, events: this.events, tree: this.toTree() }; }

  toMarkdown(): string {
    const lines: string[] = [`# Agent Trace`, ``, `- provider: ${this.meta.provider}`, `- workspace: ${this.meta.workspace}`, `- time: ${new Date(this.startedAt).toISOString()}`, ``];
    this.renderNode(this.toTree(), lines);
    return lines.join('\n');
  }

  /** 子 Agent 的事件嵌套渲染在派生它的 delegate 调用之后，而不是与父级事件按时间交错 */
  private renderNode(node: TraceNode, lines: string[]) {
    const tag = node.depth > 0 ? ` [${node.agent}]` : '';
    for (const e of node.events) {
      switch (e.type) {
        case 'delta': break;
        case 'user': lines.push(node.depth > 0 ? `### 🤖 Sub Agent ${node.agent} 接到任务` : `## 👤 User`, '', '```', e.task, '```', ''); break;
        case 'plan': lines.push(`### 📋 Plan${tag} (step ${e.step})`, '', ...e.plan.map((p) => `- [${p.status === 'done' ? 'x' : ' '}] ${p.id}. ${p.title} — ${p.status}${p.note ? ` (${p.note})` : ''}`), ''); break;
        case 'tools_activated': lines.push(`> 🔍 Tool Search 激活: ${e.names.join(', ')}`, ''); break;
        case 'compressed': lines.push(`> 🗜 Context 压缩: 节省 ${e.savedChars} 字符，当前 ${e.sizeChars} 字符`, ''); break;
        case 'decision':
          lines.push(`## 🧠 Agent Decision${tag} (step ${e.step})`, '', e.text || '_(无文字说明)_', '');
          if (e.toolCalls.length) lines.push(`→ 决定调用 ${e.toolCalls.length} 个工具: ${e.toolCalls.map((c) => c.name).join(', ')}`, '');
          lines.push(`_LLM ${e.durationMs}ms · tokens in ${e.usage.inputTokens} / out ${e.usage.outputTokens}_`, '');
          break;
        case 'tool_call': {
          lines.push(`### 🔧 Tool Call${tag}: \`${e.call.name}\``, '', '```json', JSON.stringify(e.call.input, null, 2), '```', '');
          const child = node.children.find((c) => c.parentCallId === e.call.id);
          if (child) {
            lines.push(`<details><summary>🤖 Sub Agent <b>${child.agent}</b>（${child.events.filter((x) => x.type === 'decision').length} steps）</summary>`, '');
            this.renderNode(child, lines);
            lines.push('</details>', '');
          }
          break;
        }
        case 'tool_result': {
          const body = e.result.ok ? e.result.output : e.result.error;
          lines.push(`### ${e.result.ok ? '✅' : '❌'} Tool Result${tag}: \`${e.name}\` (${e.durationMs}ms)`, '', '```', truncate(body, 1500), '```', '');
          break;
        }
        case 'notice': lines.push(`> ⚠️ ${e.message}`, ''); break;
        case 'final': lines.push(node.depth > 0 ? `### 🤖 Sub Agent ${node.agent} 结束 (${e.reason}, ${e.steps} steps)` : `## 🏁 Final Answer (${e.reason}, ${e.steps} steps, tokens in ${e.usage.inputTokens} / out ${e.usage.outputTokens})`, '', e.answer, ''); break;
      }
    }
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
