// Poll interval, batch size and concurrency are env-configurable
// (OUTBOX_POLL_INTERVAL_MS / OUTBOX_BATCH_SIZE / OUTBOX_CONCURRENCY).
export const OUTBOX_MAX_ATTEMPTS = 5;
// Back-to-back full batches one poll tick may process before yielding to
// the next tick (bounds a single tick's runtime during a backlog).
export const OUTBOX_MAX_DRAIN_ROUNDS = 20;
// How long a claimed row stays invisible to other pollers. Claiming pushes
// nextAttemptAt this far ahead; a normal outcome overwrites it (sent, or a
// backoff retry), so it only matters if the process dies mid-handler — the
// row then becomes due again once the lease lapses. Must comfortably exceed
// the slowest handler (outbound HTTP calls are capped well below this).
export const OUTBOX_CLAIM_LEASE_MS = 5 * 60_000;

const BASE_BACKOFF_MS = 30_000; // 30s
const MAX_BACKOFF_MS = 15 * 60_000; // 15min

// Exponential backoff, capped — attempt 1 fails -> retry in ~30s, attempt 2
// -> ~1min, attempt 3 -> ~2min, ... capped at 15min so a long SMTP outage
// doesn't push retries out to absurd delays.
export function computeBackoffMs(attempts: number): number {
  return Math.min(BASE_BACKOFF_MS * 2 ** (attempts - 1), MAX_BACKOFF_MS);
}
