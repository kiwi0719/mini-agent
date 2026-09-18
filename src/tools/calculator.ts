import type { Tool } from '../types.ts';

/**
 * 安全的算术表达式求值（递归下降，不使用 eval）。
 * 支持 + - * / % ^ 括号、一元负号，以及函数 sum/avg/min/max/abs/round/sqrt。
 */
export function evaluate(expr: string): number {
  const src = expr.replace(/\s+/g, '').replace(/，/g, ',');
  let i = 0;
  const peek = () => src[i];
  const eat = (c: string) => { if (src[i] !== c) throw new Error(`期望 "${c}"，在位置 ${i} 得到 "${src[i] ?? 'EOF'}"`); i++; };

  function parseExpr(): number {
    let v = parseTerm();
    while (peek() === '+' || peek() === '-') { const op = src[i++]; const r = parseTerm(); v = op === '+' ? v + r : v - r; }
    return v;
  }
  function parseTerm(): number {
    let v = parseFactor();
    while (peek() === '*' || peek() === '/' || peek() === '%') {
      const op = src[i++]; const r = parseFactor();
      if (op === '*') v *= r; else if (op === '/') { if (r === 0) throw new Error('除数为零'); v /= r; } else v %= r;
    }
    return v;
  }
  function parseFactor(): number {
    const base = parseUnary();
    if (peek() === '^') { i++; return Math.pow(base, parseFactor()); }
    return base;
  }
  function parseUnary(): number {
    if (peek() === '-') { i++; return -parseUnary(); }
    if (peek() === '+') { i++; return parseUnary(); }
    return parsePrimary();
  }
  function parsePrimary(): number {
    if (peek() === '(') { i++; const v = parseExpr(); eat(')'); return v; }
    const fn = src.slice(i).match(/^([a-zA-Z_]+)\(/);
    if (fn) {
      i += fn[0].length;
      const args: number[] = [];
      if (peek() !== ')') { args.push(parseExpr()); while (peek() === ',') { i++; args.push(parseExpr()); } }
      eat(')');
      return callFn(fn[1], args);
    }
    const num = src.slice(i).match(/^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i);
    if (!num) throw new Error(`无法解析的符号，在位置 ${i}: "${src.slice(i, i + 10)}"`);
    i += num[0].length;
    return parseFloat(num[0]);
  }
  function callFn(name: string, a: number[]): number {
    switch (name.toLowerCase()) {
      case 'sum': return a.reduce((x, y) => x + y, 0);
      case 'avg': if (!a.length) throw new Error('avg 需要参数'); return a.reduce((x, y) => x + y, 0) / a.length;
      case 'min': return Math.min(...a);
      case 'max': return Math.max(...a);
      case 'abs': return Math.abs(a[0]);
      case 'sqrt': return Math.sqrt(a[0]);
      case 'round': return a.length > 1 ? Number(a[0].toFixed(a[1])) : Math.round(a[0]);
      default: throw new Error(`未知函数 ${name}`);
    }
  }

  if (!src) throw new Error('表达式为空');
  const v = parseExpr();
  if (i !== src.length) throw new Error(`表达式末尾有多余内容: "${src.slice(i)}"`);
  if (!Number.isFinite(v)) throw new Error('结果不是有限数');
  return v;
}

export const calculator: Tool = {
  name: 'calculator',
  description:
    '精确计算数学表达式。运算符: + - * / % ^ 与括号。优先级从高到低: 括号/函数 > 一元负号 > ^(幂，右结合: 2^3^2 = 2^9) > * / %(同级，左结合) > + -。% 为取余而非百分比。函数: sum(a,b,...) avg() min() max() abs() round(x, digits) sqrt()。例: "sum(1200, 850.5, 300)"、"(3+4)*2"、"round(10/3, 2)"。',
  permission: 'read',
  idempotent: true,
  inputSchema: {
    type: 'object',
    properties: { expression: { type: 'string', description: '数学表达式' } },
    required: ['expression'],
    additionalProperties: false,
  },
  async execute(input: { expression: string }) {
    try {
      const v = evaluate(input.expression);
      // 处理浮点误差
      const rounded = Math.round(v * 1e10) / 1e10;
      return { ok: true, output: `${input.expression} = ${rounded}` };
    } catch (e) {
      return { ok: false, error: `计算失败: ${(e as Error).message}` };
    }
  },
};
