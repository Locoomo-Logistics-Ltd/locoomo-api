// Cross-module entry point for subscribing to delivery events — handoffs
// implements the listener, but the module boundary rule keeps it out of
// logistics' domain/.
export type {
  DeliveryEventListener,
  DeliveryEventNotice,
} from '../domain/delivery-event-notice';
