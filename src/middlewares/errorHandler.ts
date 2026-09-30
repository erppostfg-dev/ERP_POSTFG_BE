import { NextFunction, Request, Response } from 'express';
import { ApiError } from '../utils/ApiError';

export const notFoundHandler = (req: Request, _res: Response, next: NextFunction): void => {
  next(new ApiError(404, `Route not found: ${req.method} ${req.originalUrl}`));
};

export const errorHandler = (
  err: Error,
  _req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _next: NextFunction,
): void => {
  const statusCode = err instanceof ApiError ? err.statusCode : 500;
  const message = err instanceof ApiError ? err.message : 'Internal server error';

  if (statusCode === 500) {
    console.error(err);
  }

  res.status(statusCode).json({
    success: false,
    message,
    ...(err instanceof ApiError && err.details !== undefined ? { details: err.details } : {}),
  });
};
