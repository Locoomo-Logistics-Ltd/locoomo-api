// Contract for anything the outbox poller can deliver. Each module that
// enqueues its own event type (notifications' 'email' today; logistics'
// dispatch/cancel later) registers a handler for it via
// OutboxHandlerRegistry, so the poller never has to import — or even know
// about — the modules whose side effects it runs.
//
// A handler must be safe to run more than once for the same payload: the
// poller is at-least-once (a crash after the side effect but before the row
// is marked sent means a retry). Throwing schedules a retry with backoff.
export interface OutboxHandler {
  handle(payload: Record<string, unknown>): Promise<void>;
}
