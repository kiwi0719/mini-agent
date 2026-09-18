/**
 * 测试日志生成脚本（题目要求提交生成方法）。
 * 用法: node scripts/gen-logs.ts [lines=10000] [out=workspace/logs/app.log] [seed=42]
 *
 * 生成内容：8 个业务模块、≥300 个 traceId，剧本按权重抽取：
 *   正常 70% · 慢请求 10% · timeout 6% · database error 6% · network error 5% · 异常格式 3%
 * 并在 10:08–10:11 之间集中投放 database error，让趋势分析有可观察的突增。
 */
import fs from 'node:fs';
import path from 'node:path';

const LINES = Number(process.argv[2] ?? 10000);
const OUT = path.resolve(process.argv[3] ?? path.join(import.meta.dirname, '../workspace/logs/app.log'));
let seed = Number(process.argv[4] ?? 42);
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const ri = (a: number, b: number) => a + Math.floor(rnd() * (b - a + 1));
const pick = <T>(xs: T[]) => xs[Math.floor(rnd() * xs.length)];

const MODULES = ['Gateway', 'UserService', 'OrderService', 'PaymentService', 'InventoryService', 'Database', 'Cache', 'Notification'];
const ENTRY = ['UserService', 'OrderService', 'PaymentService', 'InventoryService'];
const DOWNSTREAM: Record<string, string[]> = {
  UserService: ['Database', 'Cache'], OrderService: ['Database', 'InventoryService', 'Cache'], PaymentService: ['Database', 'Gateway'], InventoryService: ['Database', 'Cache', 'Notification'],
};
const NET_ERRORS = ['connection_reset', 'dns_failure', 'connection_refused', 'no_route_to_host'];
const DB_ERRORS = ['database_timeout', 'connection_pool_exhausted', 'deadlock_detected'];

let t = Date.parse('2026-08-10T10:00:00.000Z');
const ts = (ms: number) => new Date(ms).toISOString().replace('T', ' ').replace('Z', '');
const line = (time: number, level: string, mod: string, trace: string, msg: string) => `${ts(time)} ${level.padEnd(5)} [${mod}] [traceId=${trace}] ${msg}`;

const out: string[] = [];
let traceNo = 0;
const scenarios: [string, number][] = [['normal', 70], ['slow', 10], ['timeout', 6], ['db', 6], ['net', 5], ['malformed', 3]];
const chooseScenario = (time: number) => {
  // 10:08–10:11 之间 db 错误概率大幅提高（模拟一次数据库故障）
  const inIncident = time >= Date.parse('2026-08-10T10:08:00Z') && time < Date.parse('2026-08-10T10:11:00Z');
  const table = inIncident ? scenarios.map(([k, w]) => [k, k === 'db' ? 45 : k === 'normal' ? 35 : w] as [string, number]) : scenarios;
  const total = table.reduce((a, [, w]) => a + w, 0); let r = rnd() * total;
  for (const [k, w] of table) { r -= w; if (r <= 0) return k; }
  return 'normal';
};

while (out.length < LINES) {
  t += ri(50, 900);
  const trace = `t${String(++traceNo).padStart(5, '0')}`;
  const entry = pick(ENTRY);
  const userId = ri(10000, 10999);
  const sc = chooseScenario(t);
  let cur = t;
  const emit = (level: string, mod: string, msg: string, dt = ri(1, 20)) => { cur += dt; out.push(line(cur, level, mod, trace, msg)); };

  if (sc === 'malformed') {
    // 异常格式：缺 traceId / 缺模块 / 时间戳错 / 堆栈行 / 被截断 / 空行
    const kind = ri(0, 5);
    if (kind === 0) out.push(`${ts(cur)} INFO  [${entry}] request start userId=${userId}`);                          // 缺 traceId
    else if (kind === 1) out.push(`${ts(cur)} WARN  [traceId=${trace}] cache miss key=user:${userId}`);                // 缺模块
    else if (kind === 2) out.push(`2026/08/10 10:xx ERROR [${entry}] [traceId=${trace}] unexpected error=NullPointerException`); // 时间戳错
    else if (kind === 3) { out.push(`${ts(cur)} ERROR [${entry}] [traceId=${trace}] unhandled exception error=NullPointerException`); out.push(`\tat com.shop.${entry.toLowerCase()}.Handler.handle(Handler.java:${ri(10, 300)})`); out.push(`\tat com.shop.core.Dispatcher.dispatch(Dispatcher.java:42)`); }
    else if (kind === 4) out.push(`${ts(cur)} INFO  [${entry}] [traceId=${trace}] load user succ`);                    // 截断
    else out.push('');
    continue;
  }

  emit('INFO', entry, `request start userId=${userId}`, 0);
  const downs = DOWNSTREAM[entry];
  const nSteps = ri(2, 4);
  let total = 0; let failed = false; let failCode = '';
  for (let i = 0; i < nSteps && !failed; i++) {
    const d = pick(downs);
    let cost = ri(5, 150);
    const lastStep = i === nSteps - 1;
    if (sc === 'slow' && lastStep) { cost = ri(500, 3000); if (d === 'Database') emit('WARN', 'Database', `slow query cost=${cost}ms sql=select_order_by_user`, cost); else emit('WARN', d, `slow call cost=${cost}ms`, cost); }
    else if (sc === 'db' && lastStep) { cost = ri(700, 2500); emit('WARN', 'Database', `slow query cost=${cost}ms sql=update_inventory`, cost); failCode = pick(DB_ERRORS); emit('ERROR', entry, `query failed error=${failCode} retries=2`); failed = true; }
    else if (sc === 'timeout' && lastStep) { cost = 3000; emit('ERROR', d, `call timeout after ${cost}ms target=${d.toLowerCase()}-svc`, cost); failCode = 'timeout'; emit('ERROR', entry, `request failed error=timeout upstream=${d}`); failed = true; }
    else if (sc === 'net' && lastStep) { failCode = pick(NET_ERRORS); emit('ERROR', d, `network error=${failCode} host=10.0.${ri(1, 9)}.${ri(2, 250)}:${pick([5432, 6379, 8080])}`, ri(20, 200)); emit('ERROR', entry, `request failed error=${failCode}`); failed = true; }
    else { const verb = d === 'Database' ? 'query' : d === 'Cache' ? (rnd() < 0.2 ? 'cache miss' : 'cache hit') : 'call'; emit('INFO', d, `${verb} ${d === 'Notification' ? 'send' : 'ok'} cost=${cost}ms`, cost); }
    total += cost;
  }
  if (failed) { const status = failCode === 'timeout' ? 504 : failCode.startsWith('database') || DB_ERRORS.includes(failCode) ? 500 : 502; emit('ERROR', 'Gateway', `request failed status=${status} totalCost=${total + ri(5, 30)}ms`); }
  else { emit('INFO', entry, `request end totalCost=${total + ri(2, 15)}ms`); if (rnd() < 0.15) emit('INFO', 'Gateway', `response status=200 totalCost=${total + ri(10, 40)}ms`); }
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, out.slice(0, LINES).join('\n') + '\n');
console.log(`已生成 ${Math.min(out.length, LINES)} 行 → ${OUT}（traceId ${traceNo} 个，模块 ${MODULES.length} 个，seed=${process.argv[4] ?? 42}）`);
