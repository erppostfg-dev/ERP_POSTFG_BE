import { NextFunction, Request, Response } from 'express';
import { MulterError } from 'multer';
import { ERROR_CODES, errorMessage, ERRORS } from '../constants';
import { AppError, appError } from '../utils/AppError';

export const notFoundHandler = (req: Request, _res: Response, next: NextFunction): void => {
  next(appError(ERROR_CODES.ROUTE_NOT_FOUND, req.method, req.originalUrl));
};

// Every error is { "error": { "code", "message", "details"? } }; a 500 never shows internals.
export const errorHandler = (
  err: Error,
  _req: Request,
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

  if (!appErr) console.error(err);

  res.status(appErr?.statusCode ?? ERRORS.INTERNAL.status).json({
    error: {
      code: appErr?.code ?? ERROR_CODES.INTERNAL,
      message: appErr?.message ?? errorMessage(ERROR_CODES.INTERNAL),
      ...(appErr?.details !== undefined ? { details: appErr.details } : {}),
    },
  });
};
