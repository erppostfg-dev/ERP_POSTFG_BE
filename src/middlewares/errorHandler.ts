import { NextFunction, Request, Response } from 'express';
import { MulterError } from 'multer';
import { ApiError } from '../utils/ApiError';

export const notFoundHandler = (req: Request, _res: Response, next: NextFunction): void => {
  next(new ApiError(404, `Route not found: ${req.method} ${req.originalUrl}`));
};

// Every error is { "error": { "code", "message", "details"? } }; a 500 never shows internals.
export const errorHandler = (
  err: Error,
  _req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _next: NextFunction,
): void => {
  const apiError =
    err instanceof ApiError
      ? err
      : err instanceof MulterError
        ? new ApiError(400, `Upload rejected: ${err.message}`, { field: err.field }, 'BAD_REQUEST')
        : undefined;

  if (!apiError) console.error(err);

  const statusCode = apiError?.statusCode ?? 500;
  res.status(statusCode).json({
    error: {
      code: apiError?.code ?? 'INTERNAL',
      message: apiError?.message ?? 'Internal server error',
      ...(apiError?.details !== undefined ? { details: apiError.details } : {}),
    },
  });
};
