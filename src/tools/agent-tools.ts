import type { PlanStep, Tool } from '../types.ts';

/** Plan：模型显式维护一个可修订的步骤列表（支持动态调整） */
export const updatePlan: Tool = {
  name: 'update_plan',
  description:
    '创建或修订执行计划。多步任务开始前先制定计划；每完成一步或遇到失败需要改变策略时，重新提交完整的计划列表（可增删步骤、更新状态与备注）。status: pending | in_progress | done | blocked | skipped。',
  permission: 'read',
  inputSchema: {
    type: 'object',
    properties: {
      steps: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
          properties: {
            id: { type: 'integer' },
            title: { type: 'string' },
            status: { type: 'string', enum: ['pending', 'in_progress', 'done', 'blocked', 'skipped'] },
            note: { type: 'string' },
          },
          required: ['id', 'title', 'status'],
          additionalProperties: false,
        },
      },
      reason: { type: 'string', description: '为什么调整计划（首次制定可省略）' },
    },
    required: ['steps'],
    additionalProperties: false,
  },
  async execute(input: { steps: PlanStep[]; reason?: string }, ctx) {
    if (!ctx.runtime) return { ok: false, error: 'update_plan 需要 Agent 运行时' };
    ctx.runtime.setPlan(input.steps);
    const done = input.steps.filter((s) => s.status === 'done').length;
    return { ok: true, output: `计划已更新（${done}/${input.steps.length} 完成）${input.reason ? `，原因: ${input.reason}` : ''}` };
  },
};

/** Tool Search：发现并激活 deferred 工具 */
export const searchTools: Tool = {
  name: 'search_tools',
  description: '按关键词搜索当前未加载的扩展工具（例如 "csv 解析"、"文件信息"、"时间"），匹配到的工具会被激活并在下一轮可用。关键词没命中时会返回全部扩展工具目录供你挑选，再用准确名称调用一次即可激活。当现有工具不够用时先调用它。',
  permission: 'read',
  idempotent: true,
  inputSchema: {
    type: 'object',
    properties: { query: { type: 'string', description: '关键词，可多个' } },
    required: ['query'],
    additionalProperties: false,
  },
  async execute(input: { query: string }, ctx) {
    if (!ctx.runtime) return { ok: false, error: 'search_tools 需要 Agent 运行时' };
    const found = ctx.runtime.searchTools(input.query);
    if (!found.length) {
      // 关键词未命中 → 回退：把全部未激活的扩展工具目录交给模型自己挑（见 DESIGN.md §6.3）
      const catalog = ctx.runtime.listDeferredTools().filter((t) => !t.activated);
      if (!catalog.length) return { ok: true, output: `没有匹配 "${input.query}" 的工具，且所有扩展工具都已激活。` };
      return {
        ok: true,
        output: `关键词 "${input.query}" 没有直接命中。以下是全部可用的扩展工具目录，若其中有合适的，请用它的准确名称再次调用 search_tools 激活:\n` +
          catalog.map((t) => `- ${t.name}: ${t.description}`).join('\n'),
      };
    }
    const activated = ctx.runtime.activateTools(found.map((f) => f.name));
    return {
      ok: true,
      output: `找到并激活 ${activated.length} 个工具，下一轮即可调用:\n` + found.map((f) => `- ${f.name}: ${f.description}`).join('\n'),
    };
  },
};

/** Sub Agent：把一个独立子任务委派给子 Agent，返回其最终答案 */
export const delegate: Tool = {
  name: 'delegate',
  description:
    '把一个独立、边界清晰的子任务委派给子 Agent 执行（它拥有同样的文件工具与独立上下文，默认只读），返回子 Agent 的最终答案。同一轮发出的多个 delegate 会并行执行。适合可重复的分析（例如“逐个文件分析”），子任务描述必须自包含。',
  permission: 'read',
  inputSchema: {
    type: 'object',
    properties: {
      task: { type: 'string', description: '自包含的子任务描述' },
      allow_write: { type: 'boolean', description: '是否允许子 Agent 写文件，默认 false（只读）。仅在子任务确实需要产出文件时开启' },
    },
    required: ['task'],
    additionalProperties: false,
  },
  async execute(input: { task: string; allow_write?: boolean }, ctx) {
    if (!ctx.runtime) return { ok: false, error: 'delegate 需要 Agent 运行时' };
    const r = await ctx.runtime.delegate(input.task, ctx.callId ?? '', { allowWrite: input.allow_write });
    if (r.reason !== 'completed') return { ok: false, error: `子 Agent 未能完成 (${r.reason}, ${r.steps} steps): ${r.answer}` };
    return { ok: true, output: `[子 Agent 用 ${r.steps} 步完成]\n${r.answer}` };
  },
};
