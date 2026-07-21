import { AppException } from './app.exception';

// 403 — you can't do that. The filter logs these at `warn`.
export abstract class AuthorizationException extends AppException {}
