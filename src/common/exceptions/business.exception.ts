import { AppException } from './app.exception';

// Expected domain-rule failures — normal program flow, not bugs.
// The filter logs these at `warn`, and `message` is always safe to show as-is.
export abstract class BusinessException extends AppException {}
