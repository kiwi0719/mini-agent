import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { Agent } from './agent.ts';
import { createDefaultRegistry } from './tools/index.ts';
import { createProvider } from './llm/index.ts';
import { Trace } from './trace.ts';

const ROOT = path.resolve(import.meta.dirname, '..'); // 项目根目录，与启动 cwd 无关
const PORT = Number(process.env.PORT ?? 3000);
const WORKSPACE = path.resolve(process.env.WORKSPACE ?? path.join(ROOT, 'workspace'));
const TRACE_DIR = path.join(ROOT, 'traces');
const html = path.join(ROOT, 'web/index.html');

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');

  if (req.method === 'GET' && url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return fs.createReadStream(html).pipe(res);
  }

  if (req.method === 'GET' && url.pathname === '/api/info') {
    return json(res, { providers: ['mock', 'anthropic', 'openai'], defaultProvider: process.env.LLM_PROVIDER ?? 'mock', workspace: WORKSPACE, tools: createDefaultRegistry().all().map((t) => ({ name: t.name, description: t.description, permission: t.permission, deferred: !!t.deferred })) });
  }

  if (req.method === 'GET' && url.pathname === '/api/workspace') {
    const files: { path: string; content: string | null }[] = [];
    const walk = (d: string) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else files.push({ path: path.relative(WORKSPACE, p), content: null }); } };
    walk(WORKSPACE);
    return json(res, files.sort((a, b) => a.path.localeCompare(b.path)));
  }

  if (req.method === 'GET' && url.pathname === '/api/file') {
    const rel = url.searchParams.get('path') ?? '';
    const abs = path.resolve(WORKSPACE, rel);
    if (!abs.startsWith(WORKSPACE + path.sep)) return json(res, { error: 'forbidden' }, 403);
    try { const buf = fs.readFileSync(abs); return json(res, { path: rel, binary: buf.subarray(0, 8000).includes(0), content: buf.subarray(0, 8000).includes(0) ? null : buf.toString('utf8') }); }
    catch { return json(res, { error: 'not found' }, 404); }
  }

  if (req.method === 'GET' && url.pathname === '/api/traces') {
    const list = fs.existsSync(TRACE_DIR) ? fs.readdirSync(TRACE_DIR).filter((f) => f.endsWith('.json')).sort().reverse() : [];
    return json(res, list);
  }

  // SSE：运行 Agent，实时推送事件
  if (req.method === 'POST' && url.pathname === '/api/run') {
    let body = '';
    for await (const chunk of req) body += chunk;
    let payload: { task?: string; provider?: string; maxSteps?: number; allowWrite?: boolean };
    try { payload = JSON.parse(body || '{}'); } catch { return json(res, { error: 'bad json' }, 400); }
    if (!payload.task?.trim()) return json(res, { error: 'task required' }, 400);

    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

    let llm;
    try { llm = createProvider(payload.provider); } catch (e) { send('error', { message: (e as Error).message }); return res.end(); }
    const trace = new Trace({ provider: llm.name, workspace: WORKSPACE });
    const agent = new Agent(llm, createDefaultRegistry(), WORKSPACE, {
      maxSteps: payload.maxSteps ?? 15,
      allowWrite: payload.allowWrite ?? true,
      onEvent: (e) => { trace.push(e); send('agent', e); },
    });
    send('meta', { provider: llm.name });
    try {
      await agent.run(payload.task);
      const saved = trace.save(TRACE_DIR);
      send('done', { trace: path.basename(saved.md) });
    } catch (e) {
      send('error', { message: (e as Error).message });
    }
    res.end();
    return;
  }

  res.writeHead(404); res.end('not found');
});

function json(res: http.ServerResponse, data: unknown, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

server.listen(PORT, () => console.log(`Mini Agent Web UI → http://localhost:${PORT}  (workspace: ${WORKSPACE})`));
