// Base for every exception the app throws deliberately. errorCode is the
// stable, machine-readable contract clients branch on — httpStatus/message
// can be reworded without breaking a client, errorCode can't.
export abstract class AppException extends Error {
  abstract readonly errorCode: string;
  abstract readonly httpStatus: number;
  // Optional structured data returned to the client as `error.details`
  // (e.g. which onboarding sections are missing). Never put internal state
  // here — it is sent as-is. Ignored for InfrastructureException.
  details?: unknown;

  protected constructor(
    message: string,
    readonly context?: Record<string, unknown>,
  ) {
    super(message);
    this.name = new.target.name;
  }
}
