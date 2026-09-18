export function isEmail(s: string): boolean {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s);
}

// TODO: 手机号校验支持国际区号
export function isPhone(s: string): boolean {
  return /^1\d{10}$/.test(s);
}
