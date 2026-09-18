// 把 workspace 恢复到初始状态（删除 Agent 生成的报告文件）
import fs from 'node:fs';
import path from 'node:path';
const ws = path.resolve(process.argv[2] ?? 'workspace');
for (const f of ['todo-report.md', 'report.md', 'docs/check.md']) {
  const p = path.join(ws, f);
  if (fs.existsSync(p)) { fs.rmSync(p); console.log('removed', f); }
}
