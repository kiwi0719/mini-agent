import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { threadId } from 'node:worker_threads';

/**
 * 写目标冲突守卫。
 *
 * 解决的问题：队列里多个任务并发运行（各自在独立 worker 线程），若写同名文件会互相覆盖，
 * 而队列本身只限并发数、不做文件级隔离。
 *
 * 设计取舍：
 *  - **事前预约优于事后检测**：`update_plan` 可声明本次计划要写哪些文件（`writes`），在制定计划时
 *    就一次性预约。此时还没干活，冲突的代价最低（换个文件名即可），也避免了跑到最后一步才失败。
 *  - **只拦写，不碰读**：只有 `permission: 'write'` 的工具会走这里，只读工具的并行路径完全不受影响。
 *  - **O(1) 且几乎无开销**：进程内 Map 走快路径；跨线程/跨进程才落到锁文件，每次 1-2 次 syscall。
 *    没有轮询、没有定时器、没有后台线程。
 *  - **不做安全隔离**：这是防"并发互相覆盖"的协作式机制，不是权限边界。绕过它很容易（直接写文件），
 *    但它要防的是同一套工具的并发任务互踩，不是防恶意调用。权限边界由 `permission` + 沙箱负责。
 *
 * 资源键是任意字符串：文件用绝对路径，集群资源用 `k8s://<ns>/<name>` 这类逻辑键，
 * 因此非文件类的写操作（如 apply_fix 改 Pod 状态）也能纳入同一套冲突检查。
 */

const LOCK_DIR = path.join(os.tmpdir(), 'mini-agent-locks');
/** 超过这个时间的锁视为残留（进程崩溃未释放），可被抢占 */
const STALE_MS = 10 * 60_000;

export interface Conflict { target: string; owner: string; ageMs: number }
export type AcquireResult = { ok: true } | { ok: false; conflicts: Conflict[] };

/** 本进程（本线程）持有的锁：target → owner。跨线程要看锁文件 */
const held = new Map<string, string>();

function lockPath(target: string): string {
  return path.join(LOCK_DIR, createHash('sha1').update(target).digest('hex') + '.lock');
}

function readLock(file: string): { owner: string; ts: number; target: string } | null {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/**
 * 预约一批写目标。全有或全无：只要有一个冲突就全部回滚，避免留下半套锁。
 * 同一 owner 重复预约是幂等的（父 Agent 与它的子 Agent 共享 owner，不会自锁）。
 */
export function acquire(targets: readonly string[], owner: string): AcquireResult {
  const uniq = [...new Set(targets)];
  const conflicts: Conflict[] = [];
  const gained: string[] = [];

  for (const t of uniq) {
    // 快路径：本线程已持有
    const mine = held.get(t);
    if (mine === owner) continue;
    if (mine && mine !== owner) { conflicts.push({ target: t, owner: mine, ageMs: 0 }); continue; }

    const file = lockPath(t);
    const payload = JSON.stringify({ owner, pid: process.pid, threadId, target: t, ts: Date.now() });
    try {
      fs.mkdirSync(LOCK_DIR, { recursive: true });
      fs.writeFileSync(file, payload, { flag: 'wx' });   // wx = 原子创建，已存在则抛 EEXIST
      held.set(t, owner);
      gained.push(t);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') { conflicts.push({ target: t, owner: '(锁不可用)', ageMs: 0 }); continue; }
      const cur = readLock(file);
      const age = cur ? Date.now() - cur.ts : Infinity;
      if (!cur || cur.owner === owner || age > STALE_MS) {
        // 无法解析 / 本来就是自己的 / 已残留 → 接管
        try { fs.writeFileSync(file, payload); held.set(t, owner); gained.push(t); } catch { conflicts.push({ target: t, owner: cur?.owner ?? '(未知)', ageMs: age }); }
      } else {
        conflicts.push({ target: t, owner: cur.owner, ageMs: age });
      }
    }
  }

  if (conflicts.length) { release(gained, owner); return { ok: false, conflicts }; }
  return { ok: true };
}

export function release(targets: readonly string[], owner: string): void {
  for (const t of [...new Set(targets)]) {
    if (held.get(t) !== owner) continue;
    held.delete(t);
    try {
      const file = lockPath(t);
      const cur = readLock(file);
      if (!cur || cur.owner === owner) fs.rmSync(file, { force: true });
    } catch { /* 释放失败不影响主流程，残留锁会因 STALE_MS 被回收 */ }
  }
}

/** 任务结束时释放该 owner 的全部预约 */
export function releaseAll(owner: string): void {
  release([...held.entries()].filter(([, o]) => o === owner).map(([t]) => t), owner);
}

/** 当前 owner 已预约的目标（用于提示模型"计划里已预算过"） */
export function reservedBy(owner: string): string[] {
  return [...held.entries()].filter(([, o]) => o === owner).map(([t]) => t);
}

export function describeConflicts(conflicts: readonly Conflict[]): string {
  return conflicts.map((c) => `"${c.target}" 正被另一个任务(${c.owner})占用${Number.isFinite(c.ageMs) ? `，已持有 ${Math.round(c.ageMs / 1000)}s` : ''}`).join('；');
}

/**
 * 生成在本机唯一的 owner 标识。
 * 必须带自增序号：同一线程里并发跑两个根 Agent 时，它们的 id 都是 'main'，
 * 只用 pid+threadId+id 会让两个无关任务互相认作自己人，冲突检查直接失效。
 */
let ownerSeq = 0;
export function makeOwner(agentId: string): string {
  return `${process.pid}.${threadId}.${++ownerSeq}.${agentId}`;
}
