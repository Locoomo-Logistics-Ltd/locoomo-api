// Base for every exception the app throws deliberately. errorCode is the
// stable, machine-readable contract clients branch on — httpStatus/message
// can be reworded without breaking a client, errorCode can't.
export abstract class AppException extends Error {
  abstract readonly errorCode: string;
  abstract readonly httpStatus: number;

  protected constructor(
    message: string,
    readonly context?: Record<string, unknown>,
  ) {
    super(message);
    this.name = new.target.name;
  }
}
