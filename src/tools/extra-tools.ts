import fs from 'node:fs/promises';
import type { Tool } from '../types.ts';
import { resolveInWorkspace } from './sandbox.ts';

/** 以下工具为 deferred（延迟加载），默认不出现在 LLM 的工具列表里，需要通过 search_tools 发现并激活。 */

export const csvParse: Tool = {
  name: 'csv_parse',
  description: '解析 CSV / 分隔符文本文件为结构化 JSON 行数组。自动跳过注释行(#)与空行，报告无法解析为数字的脏数据行。适合处理销售数据、表格数据。',
  permission: 'read',
  idempotent: true,
  deferred: true,
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '相对 workspace 的文件路径' },
      delimiter: { type: 'string', description: '分隔符，默认 ","' },
      numeric_columns: { type: 'array', items: { type: 'integer' }, description: '需要解析为数字的列下标（0 开始）' },
    },
    required: ['path'],
    additionalProperties: false,
  },
  async execute(input: { path: string; delimiter?: string; numeric_columns?: number[] }, ctx) {
    const abs = resolveInWorkspace(ctx.workspace, input.path);
    let text: string;
    try { text = await fs.readFile(abs, 'utf8'); } catch { return { ok: false, error: `文件不存在: ${input.path}` }; }
    const delim = input.delimiter ?? ',';
    const rows: unknown[][] = [];
    const invalid: { line: number; text: string; reason: string }[] = [];
    text.split('\n').forEach((raw, idx) => {
      const line = raw.trim();
      if (!line || line.startsWith('#')) return;
      const cells: unknown[] = line.split(delim).map((c) => c.trim());
      for (const col of input.numeric_columns ?? []) {
        const n = Number(cells[col]);
        if (cells[col] === undefined || cells[col] === '' || Number.isNaN(n)) {
          invalid.push({ line: idx + 1, text: line, reason: `第 ${col} 列 "${cells[col]}" 不是数字` });
          return;
        }
        cells[col] = n;
      }
      rows.push(cells);
    });
    return { ok: true, output: JSON.stringify({ rows, invalid, row_count: rows.length }, null, 1) };
  },
};

export const fileInfo: Tool = {
  name: 'file_info',
  description: '获取文件元信息：大小、行数、是否二进制、修改时间。',
  permission: 'read',
  idempotent: true,
  deferred: true,
  inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false },
  async execute(input: { path: string }, ctx) {
    const abs = resolveInWorkspace(ctx.workspace, input.path);
    try {
      const st = await fs.stat(abs);
      const buf = await fs.readFile(abs);
      const binary = buf.subarray(0, 8000).includes(0);
      return { ok: true, output: JSON.stringify({ path: input.path, bytes: st.size, lines: binary ? null : buf.toString('utf8').split('\n').length, binary, mtime: st.mtime.toISOString() }) };
    } catch { return { ok: false, error: `文件不存在: ${input.path}` }; }
  },
};

export const currentTime: Tool = {
  name: 'current_time',
  description: '返回当前日期时间（ISO 8601），用于在报告中标注生成时间。',
  permission: 'read',
  idempotent: true,
  deferred: true,
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  async execute() { return { ok: true, output: new Date().toISOString() }; },
};
