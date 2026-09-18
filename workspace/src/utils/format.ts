/** 把 "¥1,200.50" / "1200.5" / "1,200" 统一解析为数字；无法解析返回 NaN */
export function parseAmount(s: string): number {
  return Number(s.replace(/[¥$,\s]/g, ''));
}

export function formatCNY(n: number): string {
  return '¥' + n.toFixed(2);
}
