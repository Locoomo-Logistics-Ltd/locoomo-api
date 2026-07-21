import { AppException } from './app.exception';

// Unexpected failures — a bug, or a dependency behaving unexpectedly.
// The filter logs these at `error` with full context and NEVER returns
// `message` to the client (it may contain internal/driver detail) — the
// client always gets a generic message instead.
export abstract class InfrastructureException extends AppException {}
