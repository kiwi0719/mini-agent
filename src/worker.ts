/**
 * Worker 线程入口：在独立线程里跑一个 Agent，事件通过 parentPort 回传主线程。
 * 主线程 terminate() 该 worker 即可硬中止（问题 11）。
 */
import { parentPort, workerData } from 'node:worker_threads';
import path from 'node:path';
import { Agent } from './agent.ts';
import { createDefaultRegistry } from './tools/index.ts';
import { createProvider } from './llm/index.ts';
import { Trace } from './trace.ts';

import type { LLMConfig } from './llm/index.ts';
const { task, provider, llm: llmCfg, maxSteps, allowWrite, workspace, traceDir } = workerData as {
  task: string; provider?: string; llm?: LLMConfig; maxSteps?: number; allowWrite?: boolean; workspace: string; traceDir: string;
};

const ac = new AbortController();
parentPort!.on('message', (m) => { if (m?.type === 'abort') ac.abort(); });
// 监听 parentPort 会让事件循环常驻；unref 后任务跑完线程自然退出，主线程才能释放并发槽位
parentPort!.unref();

try {
  const llm = createProvider(provider, llmCfg ?? {});
  const trace = new Trace({ provider: llm.name, workspace });
  parentPort!.postMessage({ type: 'meta', provider: llm.name });
  const agent = new Agent(llm, createDefaultRegistry(), workspace, {
    maxSteps, allowWrite, signal: ac.signal,
    onEvent: (e) => { trace.push(e); parentPort!.postMessage({ type: 'event', event: e }); },
  });
  const result = await agent.run(task);
  const saved = trace.save(traceDir);
  parentPort!.postMessage({ type: 'done', reason: result.reason, trace: path.basename(saved.md) });
} catch (e) {
  parentPort!.postMessage({ type: 'error', message: (e as Error).message });
}
