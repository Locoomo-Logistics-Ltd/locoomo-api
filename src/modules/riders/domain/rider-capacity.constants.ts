// Max concurrent deliveries a Rider can hold — physical carrying-capacity
// bound, not an administrative one. Enforced by RiderCapacityService under
// a locking transaction, same reasoning as Node.capacity (decision #6).
export const MAX_ACTIVE_ORDERS_PER_RIDER = 3;
