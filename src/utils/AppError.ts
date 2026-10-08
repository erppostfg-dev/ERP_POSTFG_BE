import { ErrorArgs, ErrorCode, ERRORS, errorMessage } from '../constants/errors';

/**
 * The one error class of the app. Its code, message and HTTP status come from constants/errors.ts.
 * The API turns it into { error: { code, message, details } } (middlewares/errorHandler.ts).
 */
export class AppError extends Error {
  readonly statusCode: number;

  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
    this.statusCode = ERRORS[code].status;
  }

  /** The same error with details for the response (e.g. the list of invalid fields). */
  withDetails(details: unknown): AppError {
    return new AppError(this.code, this.message, details);
  }
}

/** An AppError for a code from constants/errors.ts, e.g. appError(ERROR_CODES.UNKNOWN_SENDER, from). */
export const appError = <C extends ErrorCode>(code: C, ...args: ErrorArgs<C>): AppError =>
  new AppError(code, errorMessage(code, ...args));
