import { ToolRegistry } from './registry.ts';
import { readFile, writeFile, listFiles, searchText } from './fs-tools.ts';
import { calculator } from './calculator.ts';
import { csvParse, fileInfo, currentTime } from './extra-tools.ts';
import { updatePlan, searchTools, delegate } from './agent-tools.ts';
import { logTools } from './log-tools.ts';
import { k8sTools } from './k8s-tools.ts';

export function createDefaultRegistry(): ToolRegistry {
  const r = new ToolRegistry()
    // 核心工具（始终对 LLM 可见）
    .register(readFile)
    .register(writeFile)
    .register(listFiles)
    .register(searchText)
    .register(calculator)
    // Agent 级工具
    .register(updatePlan)
    .register(searchTools)
    .register(delegate)
    // 延迟加载工具（需 search_tools 激活）
    .register(csvParse)
    .register(fileInfo)
    .register(currentTime);
  // 日志分析工具（5 个）与 K8s 故障诊断工具（5 个必选 + 5 个加分项），直接注册、始终可见
  for (const t of [...logTools, ...k8sTools]) r.register(t);
  return r;
}

export { ToolRegistry };
