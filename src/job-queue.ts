import { Worker } from 'node:worker_threads';
import { EventEmitter } from 'node:events';

import type { LLMConfig } from './llm/index.ts';

export interface JobInput { task: string; provider?: string; llm?: LLMConfig; maxSteps?: number; allowWrite?: boolean; workspace: string; traceDir: string }
export type JobStatus = 'queued' | 'running' | 'done' | 'error' | 'aborted';

export interface Job {
  id: string;
  input: JobInput;
  status: JobStatus;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  /** 每个 job 一个 emitter：'message'(来自 worker) / 'status' */
  bus: EventEmitter;
  worker?: Worker;
}

/**
 * 任务队列 + Worker 线程池（问题 10）。
 * - 最多 concurrency 个 Agent 同时运行，各在独立线程；超出的排队，FIFO。
 * - abort(id)：排队中直接移除；运行中 先发 abort 消息让 Agent 优雅停止，
 *   grace 时间内没退出则 worker.terminate() 硬杀（问题 11）。
 */
export class JobQueue {
  private jobs = new Map<string, Job>();
  private pending: string[] = [];
  private running = new Set<string>();
  private seq = 0;

  private readonly concurrency: number;
  private readonly workerUrl: URL;
  private readonly graceMs: number;

  constructor(concurrency: number, workerUrl: URL, graceMs = 3000) {
    this.concurrency = concurrency;
    this.workerUrl = workerUrl;
    this.graceMs = graceMs;
  }

  submit(input: JobInput): Job {
    const job: Job = { id: `job-${++this.seq}-${Date.now().toString(36)}`, input, status: 'queued', createdAt: Date.now(), bus: new EventEmitter() };
    this.jobs.set(job.id, job);
    this.pending.push(job.id);
    queueMicrotask(() => this.pump());
    return job;
  }

  get(id: string) { return this.jobs.get(id); }

  position(id: string) { return this.pending.indexOf(id); }

  snapshot() {
    return {
      concurrency: this.concurrency,
      running: [...this.running].map((id) => this.brief(id)),
      queued: this.pending.map((id) => this.brief(id)),
    };
  }

  abort(id: string) {
    const job = this.jobs.get(id);
    if (!job) return false;
    if (job.status === 'queued') { this.pending = this.pending.filter((x) => x !== id); this.setStatus(job, 'aborted'); return true; }
    if (job.status === 'running' && job.worker) {
      job.worker.postMessage({ type: 'abort' });
      const w = job.worker;
      setTimeout(() => { if (job.status === 'running') w.terminate(); }, this.graceMs).unref();
      return true;
    }
    return false;
  }

  private brief(id: string) { const j = this.jobs.get(id)!; return { id, status: j.status, task: j.input.task.slice(0, 80), createdAt: j.createdAt, startedAt: j.startedAt }; }

  private setStatus(job: Job, s: JobStatus) { job.status = s; if (s !== 'running' && s !== 'queued') job.endedAt = Date.now(); job.bus.emit('status', s); }

  private pump() {
    while (this.running.size < this.concurrency && this.pending.length) {
      const id = this.pending.shift()!;
      const job = this.jobs.get(id)!;
      this.start(job);
    }
    // 排队位置变化通知
    this.pending.forEach((id, i) => this.jobs.get(id)!.bus.emit('position', i));
  }

  private start(job: Job) {
    this.running.add(job.id);
    job.startedAt = Date.now();
    this.setStatus(job, 'running');
    const w = new Worker(this.workerUrl, { workerData: job.input });
    job.worker = w;
    w.on('message', (m) => {
      job.bus.emit('message', m);
      if (m.type === 'done' || m.type === 'error') {
        this.setStatus(job, m.type);
        // 兜底：即使 worker 因某种原因没自行退出，也强制结束以释放槽位
        setTimeout(() => w.terminate(), 1000).unref();
      }
    });
    w.on('error', (e: Error) => { job.bus.emit('message', { type: 'error', message: e.message }); this.setStatus(job, 'error'); });
    w.on('exit', (code) => {
      if (job.status === 'running') this.setStatus(job, code === 0 ? 'done' : 'aborted');
      this.running.delete(job.id);
      job.worker = undefined;
      this.pump();
      // 结束的 job 保留 10 分钟供查询
      setTimeout(() => this.jobs.delete(job.id), 10 * 60_000).unref();
    });
  }
}
