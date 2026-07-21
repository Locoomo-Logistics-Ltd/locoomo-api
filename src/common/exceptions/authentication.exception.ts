import { AppException } from './app.exception';

// 401 — who are you. The filter logs these at `warn`.
export abstract class AuthenticationException extends AppException {}
