// Cross-module entry point for tracking-code parsing — handoffs and tracking
// need it, but the module boundary rule keeps them out of orders' domain/.
export { normalizeTrackingCode } from '../domain/tracking-code';
