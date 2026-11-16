import { NextFunction, Request, Response } from 'express';
import { Readable } from 'stream';

/** Streams a bulk order document (portal + team routes): inline, its own type, never sniffed. */
export const sendDocument = (open: (req: Request) => Promise<{ body: Readable; contentType: string; name: string; length?: number }>) =>
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const file = await open(req);
      res.setHeader('Content-Type', file.contentType);
      if (file.length !== undefined) res.setHeader('Content-Length', String(file.length));
      res.setHeader('Content-Disposition', `inline; filename="${file.name.replace(/["\r\n]/g, '')}"`);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cache-Control', 'private, max-age=300');
      file.body.on('error', next);
      file.body.pipe(res);
    } catch (err) {
      next(err);
    }
  };
