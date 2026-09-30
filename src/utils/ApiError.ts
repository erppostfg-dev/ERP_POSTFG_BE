export class ApiError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
    public readonly details?: unknown,
    public readonly code: string = defaultCode(statusCode),
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

function defaultCode(statusCode: number): string {
  switch (statusCode) {
    case 400:
      return 'BAD_REQUEST';
    case 401:
      return 'UNAUTHENTICATED';
    case 403:
      return 'FORBIDDEN';
    case 404:
      return 'NOT_FOUND';
    case 409:
      return 'CONFLICT';
    default:
      return statusCode >= 500 ? 'INTERNAL' : 'ERROR';
  }
}
