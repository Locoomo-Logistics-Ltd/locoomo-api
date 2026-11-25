import { BusinessException } from '../../../../common/exceptions/business.exception';

// The owner asked to make a Node private while it already has more orders
// this month than a private Node may (PRIVATE_NODE_MONTHLY_ORDER_LIMIT):
// it stays public, at least until next month.
export class PrivateNodeLimitReachedException extends BusinessException {
  readonly errorCode = 'PRIVATE_NODE_LIMIT_REACHED';
  readonly httpStatus = 409;

  constructor(orders: number, limit: number) {
    super(
      `This Node has ${orders} orders this month; a private Node can have up to ${limit}. It stays public for now.`,
    );
    this.details = { ordersThisMonth: orders, monthlyLimit: limit };
  }
}
