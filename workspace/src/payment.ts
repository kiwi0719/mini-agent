import type { Order } from './order.ts';

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
