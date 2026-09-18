import path from 'node:path';

/** 把相对路径解析到 workspace 内；任何越界都抛错 */
export function resolveInWorkspace(workspace: string, p: string): string {
  const root = path.resolve(workspace);
  const cleaned = p.replace(/^workspace[\\/]/, ''); // 模型常写成 workspace/xxx
  const abs = path.resolve(root, cleaned);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new Error(`拒绝访问 workspace 之外的路径: ${p}`);
  }
  return abs;
}

export function toRel(workspace: string, abs: string): string {
  return path.relative(path.resolve(workspace), abs).split(path.sep).join('/');
}
