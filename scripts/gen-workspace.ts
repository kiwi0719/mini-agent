/**
 * 生成测试 workspace（确定性，可重复）。用法: node scripts/gen-workspace.ts [dir]
 * 设计目标：让用例不再“太简单”——
 *  - 多层目录、多种注释形式的 TODO/FIXME，以及 todoList/TODOS 这类假阳性
 *  - 多份格式不一致的数据文件（表头、货币符号、千分位、负数退款、脏行）
 *  - 超过 read_file 上限的大日志（必须改用 search_text）、接近上限的大 changelog（触发 Context 压缩）
 *  - 文档互相引用、引用不存在的文件、二进制文件
 *  - 任务所需信息根本不在 workspace 里（汇率），Agent 应判断无法完成
 *  - 永远不会就绪的锁文件（诱导死循环）
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(process.argv[2] ?? path.join(import.meta.dirname, '..', 'workspace'));
fs.rmSync(ROOT, { recursive: true, force: true });
const w = (rel: string, content: string | Buffer) => { const p = path.join(ROOT, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, content); };

// 简单的确定性伪随机
let seed = 42;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const pick = <T>(a: T[]) => a[Math.floor(rnd() * a.length)];

// ---------- 顶层 ----------
w('README.md', `# Demo Shop

这是一个用于测试 Mini Agent 的示例项目（电商后台的一小部分）。

## 模块

- \`src/user.ts\` 用户模块
- \`src/order.ts\` 订单模块
- \`src/payment.ts\` 支付模块
- \`src/utils/\` 工具函数
- \`docs/design.md\` 设计文档，\`docs/adr/\` 架构决策记录
- \`data/\` 销售数据与日志

TODO: 补充部署说明
TODO: 添加 CI 配置

注意：本项目的 TODOS 统一在 issue 跟踪，代码里的 TODO 注释仅作临时标记。
`);

w('config/app.yaml', `app:
  name: demo-shop
  port: 8080
  # TODO: 生产环境改成从环境变量读取
  db_url: postgres://localhost/demo
cache:
  enabled: false   # FIXME: 缓存开关未接入代码
`);

// ---------- src ----------
w('src/user.ts', `export interface User {
  id: number;
  name: string;
  email: string;
}

const users: User[] = [
  { id: 1, name: 'Alice', email: 'alice@example.com' },
  { id: 2, name: 'Bob', email: 'bob@example.com' },
];

// TODO: 接入真实数据库，替换内存数组
export function findUser(id: number): User | undefined {
  return users.find((u) => u.id === id);
}

// FIXME: 没有校验 email 格式
export function createUser(name: string, email: string): User {
  const user = { id: users.length + 1, name, email };
  users.push(user);
  return user;
}

// TODO(alice): 实现分页，见 docs/adr/001-storage.md
export function listUsers(): User[] {
  return users;
}
`);

w('src/order.ts', `import type { User } from './user.ts';

export interface Order {
  id: string;
  user: User;
  amount: number;
  status: 'pending' | 'paid' | 'shipped';
}

const TAX_RATE = 0.13;
const FREE_SHIPPING_THRESHOLD = 500;

// FIXME: 浮点运算精度问题，金额应使用整数分
export function totalWithTax(order: Order): number {
  return order.amount * (1 + TAX_RATE);
}

export function shippingFee(order: Order): number {
  return order.amount >= FREE_SHIPPING_THRESHOLD ? 0 : 20;
}

/* TODO: 订单状态机校验（pending → paid → shipped） */
export function advance(order: Order): Order {
  return order;
}
`);

w('src/payment.ts', `import type { Order } from './order.ts';

export type Provider = 'alipay' | 'wechat' | 'card';

const todoList: string[] = []; // 待处理的支付回调队列（不是 TODO 注释）

export async function charge(order: Order, provider: Provider): Promise<boolean> {
  // TODO: 幂等键，防止重复扣款
  todoList.push(order.id);
  return true;
}

export function refund(order: Order): number {
  // FIXME: 退款没有校验订单状态是否为 paid
  return -order.amount;
}
`);

w('src/utils/format.ts', `/** 把 "¥1,200.50" / "1200.5" / "1,200" 统一解析为数字；无法解析返回 NaN */
export function parseAmount(s: string): number {
  return Number(s.replace(/[¥$,\\s]/g, ''));
}

export function formatCNY(n: number): string {
  return '¥' + n.toFixed(2);
}
`);

w('src/utils/validate.ts', `export function isEmail(s: string): boolean {
  return /^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$/.test(s);
}

// TODO: 手机号校验支持国际区号
export function isPhone(s: string): boolean {
  return /^1\\d{10}$/.test(s);
}
`);

// ---------- docs ----------
w('docs/design.md', `# 系统设计

## 概述

系统由用户、订单、支付三个模块组成，数据暂存内存。存储与缓存决策见 ADR。

## 模块

- 用户模块：\`src/user.ts\`
- 订单模块：\`src/order.ts\`
- 支付模块：\`src/payment.ts\`
- API 文档：\`docs/api.md\`（待编写）
- 架构决策：\`docs/adr/001-storage.md\`、\`docs/adr/002-cache.md\`
- 销售数据：\`data/sales.txt\`
- 历史归档：\`data/archive.bin\`

## 待办

TODO: 补充部署架构图
TODO: 评估是否引入 Redis 缓存（见 002）

## 非功能需求

- 响应时间 P99 < 200ms
- 可用性 99.9%
`);

w('docs/adr/001-storage.md', `# ADR-001 存储选型

状态：已接受

## 决策
使用 PostgreSQL。当前代码仍是内存数组（见 \`src/user.ts\`），迁移计划见 \`docs/adr/003-migration.md\`。

## 后果
- TODO: 设计分页接口
- 关联：\`docs/adr/002-cache.md\`
`);

w('docs/adr/002-cache.md', `# ADR-002 缓存

状态：提议中

## 决策
暂不引入 Redis；先用进程内 LRU。依赖 \`docs/adr/001-storage.md\` 的表结构。

FIXME: 配置项 cache.enabled 在 \`config/app.yaml\` 中存在但代码未读取
`);

// 大 changelog（~90KB，低于 read_file 上限，但读入后会触发 Context 压缩）
const files = ['src/user.ts', 'src/order.ts', 'src/payment.ts', 'src/utils/format.ts', 'src/utils/validate.ts', 'src/legacy/cart.ts', 'src/utils/date.ts', 'config/app.yaml'];
const verbs = ['修复', '优化', '重构', '新增', '移除', '调整'];
const nouns = ['订单状态机', '用户分页', '支付回调', '金额格式化', '邮箱校验', '缓存开关', '日志级别', '错误提示', '数据导出', '权限校验'];
let changelog = `# Changelog\n\n所有显著变更记录于此。标记为 **BREAKING** 的条目为不兼容变更。\n\n`;
const breaking: { ver: string; text: string; file: string }[] = [];
for (let major = 3; major >= 1; major--) for (let minor = 9; minor >= 0; minor--) for (let patch = 4; patch >= 0; patch--) {
  const ver = `${major}.${minor}.${patch}`;
  changelog += `## ${ver} (2026-${String(1 + ((major * 10 + minor) % 12)).padStart(2, '0')}-${String(1 + patch * 5).padStart(2, '0')})\n\n`;
  const n = 3 + Math.floor(rnd() * 4);
  for (let i = 0; i < n; i++) {
    const f = pick(files);
    const isBreaking = rnd() < 0.06;
    const text = `${pick(verbs)}${pick(nouns)}${isBreaking ? '，接口签名变更' : ''}（\`${f}\`）`;
    changelog += `- ${isBreaking ? '**BREAKING** ' : ''}${text}\n`;
    if (isBreaking) breaking.push({ ver, text, file: f });
  }
  changelog += `\n${'详细说明：' + '本次发布经过完整回归测试，'.repeat(20)}\n\n`;
}
w('docs/changelog.md', changelog);

// ---------- data ----------
w('data/sales.txt', `# 产品销售额（单位：元）
Widget A, 1200
Widget B, 850.50
Gadget X, 3200
Gadget Y, 415.25
Service Plan, 999
Legacy Item, N/A
Bundle Pack, 2750
`);

w('data/regions/north.csv', `region,product,amount
north,Widget A,"¥1,200.00"
north,Widget B,¥850.50
north,Gadget X,"¥3,200.00"
north,Refund #1001,-¥200.00
`);
w('data/regions/south.csv', `region,product,amount
south,Widget A,980
south,Gadget Y,415.25
south,Service Plan,1,999.00
south,Bundle Pack,2750
`);
w('data/regions/east.txt', `# 东区（手工录入，格式不规范）
Widget A ....... 1500
Gadget X ....... 2,100.5
Service Plan ... 待确认
Refund #2002 ... -300
`);
w('data/lock.txt', `STATUS=PENDING\n# 由外部系统在数据导入完成后改为 READY（本 workspace 中永远不会发生）\n`);

// 大日志（~250KB，超过 read_file 的 200KB 上限，Agent 必须改用 search_text）
const levels = ['INFO', 'INFO', 'INFO', 'WARN', 'ERROR', 'DEBUG'];
const errTypes = ['TimeoutError', 'ValidationError', 'PaymentDeclined', 'DbConnectionLost', 'NullPointer'];
const errCount: Record<string, number> = {};
let log = '';
for (let i = 0; i < 4200; i++) {
  const lv = pick(levels);
  const ts = `2026-09-${String(1 + (i % 28)).padStart(2, '0')}T${String(i % 24).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}:00Z`;
  if (lv === 'ERROR') { const t = pick(errTypes); errCount[t] = (errCount[t] ?? 0) + 1; log += `${ts} ERROR [${t}] request=${1000 + i} ${pick(['order', 'user', 'payment'])} failed after ${Math.floor(rnd() * 900)}ms\n`; }
  else log += `${ts} ${lv} request=${1000 + i} ${pick(['GET /orders', 'POST /pay', 'GET /users', 'PUT /order/status'])} ${Math.floor(rnd() * 300)}ms\n`;
}
w('data/huge.log', log);
w('data/archive.bin', Buffer.from([0x42, 0x49, 0x4e, 0x00, 0x01, 0x02, 0x03, 0xff, 0xfe, 0x00, 0x00]));

// node_modules 噱头：搜索器应忽略
w('node_modules/fake-lib/index.js', `// TODO: this must NOT be counted\nmodule.exports = {};\n`);

fs.writeFileSync(path.join(import.meta.dirname, '.workspace-expected.json'), JSON.stringify({ generated: true, breakingChanges: breaking.length, errorCounts: errCount, hugeLogBytes: Buffer.byteLength(log), changelogBytes: Buffer.byteLength(changelog) }, null, 2));
console.log(`workspace 已生成: ${ROOT}`);
console.log(`  changelog ${Math.round(Buffer.byteLength(changelog) / 1024)}KB (BREAKING ${breaking.length} 条), huge.log ${Math.round(Buffer.byteLength(log) / 1024)}KB, ERROR 统计:`, errCount);
