import fs from 'node:fs/promises';
import path from 'node:path';
import type { Tool } from '../types.ts';
import { resolveInWorkspace, toRel } from './sandbox.ts';

const MAX_READ_BYTES = 200 * 1024;
const IGNORED_DIRS = new Set(['node_modules', '.git', 'dist']);

function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

async function* walk(dir: string): AsyncGenerator<string> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    if (IGNORED_DIRS.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(full);
    else if (e.isFile()) yield full;
  }
}

export const readFile: Tool = {
  name: 'read_file',
  description:
    '读取 workspace 内某个文本文件的内容。路径相对于 workspace 根目录，例如 "data/sales.txt"。可选 start_line/end_line 读取部分内容（从 1 开始）。',
  permission: 'read',
  idempotent: true,
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '相对 workspace 的文件路径' },
      start_line: { type: 'integer', minimum: 1 },
      end_line: { type: 'integer', minimum: 1 },
    },
    required: ['path'],
    additionalProperties: false,
  },
  async execute(input: { path: string; start_line?: number; end_line?: number }, ctx) {
    const abs = resolveInWorkspace(ctx.workspace, input.path);
    let stat;
    try {
      stat = await fs.stat(abs);
    } catch {
      return { ok: false, error: `文件不存在: ${input.path}` };
    }
    if (stat.isDirectory()) return { ok: false, error: `${input.path} 是目录，不是文件。请用 list_files 查看目录内容。` };
    if (stat.size > MAX_READ_BYTES) return { ok: false, error: `文件过大 (${stat.size} bytes)，上限 ${MAX_READ_BYTES}` };
    const buf = await fs.readFile(abs);
    if (looksBinary(buf)) return { ok: false, error: `${input.path} 是二进制文件，无法作为文本读取` };
    let lines = buf.toString('utf8').split('\n');
    if (input.start_line || input.end_line) {
      const s = (input.start_line ?? 1) - 1;
      const e = input.end_line ?? lines.length;
      lines = lines.slice(s, e);
    }
    return { ok: true, output: lines.join('\n') };
  },
};

export const writeFile: Tool = {
  name: 'write_file',
  description: '把内容写入 workspace 内的文件（覆盖写入，自动创建目录）。路径相对于 workspace 根目录。',
  permission: 'write',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '相对 workspace 的文件路径' },
      content: { type: 'string', description: '要写入的完整文本内容' },
    },
    required: ['path', 'content'],
    additionalProperties: false,
  },
  async execute(input: { path: string; content: string }, ctx) {
    const abs = resolveInWorkspace(ctx.workspace, input.path);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, input.content, 'utf8');
    return { ok: true, output: `已写入 ${input.path} (${Buffer.byteLength(input.content)} bytes)` };
  },
};

export const listFiles: Tool = {
  name: 'list_files',
  description: '递归列出 workspace 内某个目录下的所有文件（相对路径）。不传 path 则列出整个 workspace。',
  permission: 'read',
  idempotent: true,
  inputSchema: {
    type: 'object',
    properties: { path: { type: 'string', description: '相对目录路径，默认 "."' } },
    additionalProperties: false,
  },
  async execute(input: { path?: string }, ctx) {
    const abs = resolveInWorkspace(ctx.workspace, input.path ?? '.');
    try {
      const st = await fs.stat(abs);
      if (!st.isDirectory()) return { ok: false, error: `${input.path} 不是目录` };
    } catch {
      return { ok: false, error: `目录不存在: ${input.path}` };
    }
    const out: string[] = [];
    for await (const f of walk(abs)) out.push(toRel(ctx.workspace, f));
    return { ok: true, output: out.sort().join('\n') || '(空目录)' };
  },
};

export const searchText: Tool = {
  name: 'search_text',
  description:
    '在 workspace 内搜索文本（支持正则，如 "TODO|FIXME"）。返回 JSON: {total, truncated, files_scanned, matches:[{file,line,text}]}。path 可以是目录（递归）或单个文件；file_pattern 按扩展名过滤（如 "*.ts"）。适合读取超过 read_file 上限的大文件中的特定行。',
  permission: 'read',
  idempotent: true,
  inputSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: '正则或关键字' },
      path: { type: 'string', description: '限定搜索目录，默认整个 workspace' },
      file_pattern: { type: 'string', description: '文件名 glob，仅支持 *.ext 形式' },
      case_sensitive: { type: 'boolean', default: false },
      max_results: { type: 'integer', minimum: 1, maximum: 500, default: 200 },
    },
    required: ['pattern'],
    additionalProperties: false,
  },
  async execute(input: { pattern: string; path?: string; file_pattern?: string; case_sensitive?: boolean; max_results?: number }, ctx) {
    let re: RegExp;
    try {
      re = new RegExp(input.pattern, input.case_sensitive ? '' : 'i');
    } catch (e) {
      return { ok: false, error: `非法正则 "${input.pattern}": ${(e as Error).message}` };
    }
    const abs = resolveInWorkspace(ctx.workspace, input.path ?? '.');
    let isFile = false;
    try {
      isFile = (await fs.stat(abs)).isFile();
    } catch {
      return { ok: false, error: `路径不存在: ${input.path}` };
    }
    const ext = input.file_pattern?.match(/^\*\.(\w+)$/)?.[1];
    const max = input.max_results ?? 200;
    const hits: { file: string; line: number; text: string }[] = [];
    let scanned = 0;
    // path 可以是目录（递归）也可以是单个文件
    const targets = isFile ? (async function* () { yield abs; })() : walk(abs);
    for await (const f of targets) {
      if (ext && !f.endsWith('.' + ext)) continue;
      const buf = await fs.readFile(f);
      if (looksBinary(buf)) continue;
      scanned++;
      const rel = toRel(ctx.workspace, f);
      const lines = buf.toString('utf8').split('\n');
      for (let i = 0; i < lines.length && hits.length < max; i++) {
        if (re.test(lines[i])) hits.push({ file: rel, line: i + 1, text: lines[i].trim() });
      }
      if (hits.length >= max) break;
    }
    return {
      ok: true,
      output: JSON.stringify({ total: hits.length, truncated: hits.length >= max, files_scanned: scanned, matches: hits }, null, 1),
    };
  },
};
