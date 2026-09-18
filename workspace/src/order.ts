import type { User } from './user.ts';

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

// TODO: 订单状态机校验（pending → paid → shipped）
export function advance(order: Order): Order {
  return order;
}
