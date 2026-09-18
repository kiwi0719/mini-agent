import { ToolRegistry } from './registry.ts';
import { readFile, writeFile, listFiles, searchText } from './fs-tools.ts';
import { calculator } from './calculator.ts';
import { csvParse, fileInfo, currentTime } from './extra-tools.ts';
import { updatePlan, searchTools, delegate } from './agent-tools.ts';

export function createDefaultRegistry(): ToolRegistry {
  return new ToolRegistry()
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
}

export { ToolRegistry };
