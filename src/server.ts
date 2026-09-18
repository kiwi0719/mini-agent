import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createDefaultRegistry } from './tools/index.ts';
import { JobQueue } from './job-queue.ts';

const ROOT = path.resolve(import.meta.dirname, '..'); // 项目根目录，与启动 cwd 无关
const PORT = Number(process.env.PORT ?? 3000);
const WORKSPACE = path.resolve(process.env.WORKSPACE ?? path.join(ROOT, 'workspace'));
const TRACE_DIR = path.join(ROOT, 'traces');
const html = path.join(ROOT, 'web/index.html');
const CONCURRENCY = Number(process.env.AGENT_WORKERS ?? 2);

const queue = new JobQueue(CONCURRENCY, new URL('./worker.ts', import.meta.url));

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');

  if (req.method === 'GET' && url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return fs.createReadStream(html).pipe(res);
  }

  if (req.method === 'GET' && url.pathname === '/api/info') {
    return json(res, { providers: ['mock', 'anthropic', 'openai'], defaultProvider: process.env.LLM_PROVIDER ?? 'mock', workspace: WORKSPACE, concurrency: CONCURRENCY, tools: createDefaultRegistry().all().map((t) => ({ name: t.name, description: t.description, permission: t.permission, deferred: !!t.deferred })) });
  }

  if (req.method === 'GET' && url.pathname === '/api/jobs') return json(res, queue.snapshot());

  if (req.method === 'POST' && url.pathname.startsWith('/api/jobs/') && url.pathname.endsWith('/abort')) {
    const id = url.pathname.split('/')[3];
    return json(res, { ok: queue.abort(id) });
  }

  if (req.method === 'GET' && url.pathname === '/api/workspace') {
    const files: { path: string }[] = [];
    const walk = (d: string) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else files.push({ path: path.relative(WORKSPACE, p) }); } };
    walk(WORKSPACE);
    return json(res, files.sort((a, b) => a.path.localeCompare(b.path)));
  }

  if (req.method === 'GET' && url.pathname === '/api/file') {
    const rel = url.searchParams.get('path') ?? '';
    const abs = path.resolve(WORKSPACE, rel);
    if (!abs.startsWith(WORKSPACE + path.sep)) return json(res, { error: 'forbidden' }, 403);
    try { const buf = fs.readFileSync(abs); const bin = buf.subarray(0, 8000).includes(0); return json(res, { path: rel, binary: bin, content: bin ? null : buf.toString('utf8') }); }
    catch { return json(res, { error: 'not found' }, 404); }
  }

  if (req.method === 'GET' && url.pathname === '/api/traces') {
    const list = fs.existsSync(TRACE_DIR) ? fs.readdirSync(TRACE_DIR).filter((f) => f.endsWith('.json')).sort().reverse() : [];
    return json(res, list);
  }

  // SSE：提交任务到队列，实时推送排队位置 / Agent 事件；客户端断开即中止任务
  if (req.method === 'POST' && url.pathname === '/api/run') {
    let body = '';
    for await (const chunk of req) body += chunk;
    let payload: { task?: string; provider?: string; maxSteps?: number; allowWrite?: boolean };
    try { payload = JSON.parse(body || '{}'); } catch { return json(res, { error: 'bad json' }, 400); }
    if (!payload.task?.trim()) return json(res, { error: 'task required' }, 400);

    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    const send = (event: string, data: unknown) => { if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };

    const job = queue.submit({ task: payload.task, provider: payload.provider, maxSteps: payload.maxSteps, allowWrite: payload.allowWrite ?? true, workspace: WORKSPACE, traceDir: TRACE_DIR });
    send('job', { id: job.id, status: job.status, position: queue.position(job.id) });

    job.bus.on('position', (i: number) => send('job', { id: job.id, status: 'queued', position: i }));
    job.bus.on('status', (s: string) => send('job', { id: job.id, status: s }));
    job.bus.on('message', (m: any) => {
      if (m.type === 'event') send('agent', m.event);
      else if (m.type === 'meta') send('meta', { provider: m.provider });
      else if (m.type === 'done') { send('done', { trace: m.trace, reason: m.reason }); res.end(); }
      else if (m.type === 'error') { send('error', { message: m.message }); res.end(); }
    });
    job.bus.on('status', (s: string) => { if (s === 'aborted' && !res.writableEnded) { send('error', { message: '任务已中止' }); res.end(); } });

    // 问题 11：客户端断开 → 立即中止（排队的移除，运行中的优雅中止 + 超时硬杀）
    // 注意要监听 res 而不是 req：现代 Node 里 req 'close' 表示请求体接收完毕，res 'close' 才是连接断开
    res.on('close', () => { if (!res.writableEnded) queue.abort(job.id); });
    return;
  }

  res.writeHead(404); res.end('not found');
});

function json(res: http.ServerResponse, data: unknown, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

server.listen(PORT, () => console.log(`Mini Agent Web UI → http://localhost:${PORT}  (workspace: ${WORKSPACE}, workers: ${CONCURRENCY})`));
