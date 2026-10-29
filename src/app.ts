import cookieParser from 'cookie-parser';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { env } from './config/env';
import { errorHandler, notFoundHandler } from './middlewares/errorHandler';
import { requestLog } from './middlewares/request-log';
import { activityLog } from './modules/auth/auth.middleware';
import routes from './routes';

const app = express();

// First: request id + log context + one log line per request (CloudWatch, 2026-10-19).
app.use(requestLog);

app.use(helmet());
// Only the frontend may call the API from a browser, with its session cookie.
// ETag / X-File-Size: the in-transit table viewer keeps files in the browser by ETag (readable cross-origin too)
app.use(cors({ origin: env.auth.frontendOrigin, credentials: true, exposedHeaders: ['ETag', 'X-File-Size', 'Content-Disposition'] }));
app.use(cookieParser());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(activityLog);

app.use(env.apiPrefix, routes);

app.use(notFoundHandler);
app.use(errorHandler);

export default app;
