import { NextFunction, Request, Response } from 'express';
import { MulterError } from 'multer';
import { ERROR_CODES, errorMessage, ERRORS } from '../constants';
import { AppError, appError } from '../utils/AppError';
import { classifyError } from '../utils/classify-error';
import { LOG_SOURCE } from '../constants/logging';
import { logFailure } from '../utils/logger';
import { currentRequestId } from './request-log';

export const notFoundHandler = (req: Request, _res: Response, next: NextFunction): void => {
  next(appError(ERROR_CODES.ROUTE_NOT_FOUND, req.method, req.originalUrl));
};

// Every error is { "error": { "code", "message", "details"?, "requestId" } }; a 500 never shows internals.
// requestId (also the X-Request-Id header) finds the request's log lines in CloudWatch (2026-10-19).
// An unexpected error is logged here with its source and reason (a DB error as DB_<FAILURE>, others as APP_<FAILURE>);
// every error code also goes on the request's own line (middlewares/request-log.ts) via res.locals.
export const errorHandler = (
  err: Error,
  req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _next: NextFunction,
): void => {
  const appErr =
    err instanceof AppError
      ? err
      : err instanceof MulterError
        ? appError(ERROR_CODES.UPLOAD_REJECTED, err.message).withDetails({ field: err.field })
        : undefined;

  if (!appErr) {
    // QueryFailedError / mysql2 errors carry a driver code -> it is a database problem; anything else is our code.
    const fromDb = err.name === 'QueryFailedError' || typeof (err as { sqlMessage?: unknown }).sqlMessage === 'string';
    const source = fromDb ? LOG_SOURCE.DB : LOG_SOURCE.APP;
    const f = classifyError(source, err);
    logFailure(source, f.kind, `${req.method} ${req.originalUrl.split('?')[0]} failed`, { errorCode: f.errorCode, error: f.error, stack: err.stack });
  }
  res.locals.errorCode = appErr?.code ?? ERROR_CODES.INTERNAL;
  res.locals.errorMessage = appErr?.message ?? err.message;

  res.status(appErr?.statusCode ?? ERRORS.INTERNAL.status).json({
    error: {
      code: appErr?.code ?? ERROR_CODES.INTERNAL,
      message: appErr?.message ?? errorMessage(ERROR_CODES.INTERNAL),
      ...(appErr?.details !== undefined ? { details: appErr.details } : {}),
      requestId: currentRequestId() ?? req.requestId,
    },
  });
};
