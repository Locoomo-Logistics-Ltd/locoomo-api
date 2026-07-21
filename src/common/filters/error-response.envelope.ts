export interface ErrorResponseEnvelope {
  success: false;
  error: {
    code: string;
    message: string;
    correlationId: string;
    details?: unknown;
  };
}
