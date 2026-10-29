import { NextFunction, Request, Response, Router } from 'express';
import { ERROR_CODES, UNIWARE_HANDOFF, UPLOAD_ID_PATTERN } from '../../constants';
import { appError } from '../../utils/AppError';
import { requireAuth } from '../auth/auth.middleware';
import { unverifiedIds } from './po-verify.service';

/*
 * The lock on the Uniware hand-off (user, 2026-10-22: "keep it blocked until verified"). Mounted on /po-review BEFORE
 * the existing review routes (routes/index.ts), so those routes stay exactly as they were: for the three hand-off
 * calls it refuses POs not yet verified (PO_NOT_VERIFIED, 409), else passes the request on unchanged.
 *   GET  /po-review/:uploadId/uniware-csv · POST /po-review/uniware-csv · POST /po-review/uniware-uploaded (not undo)
 * Each channel has its own ON / OFF switch (Users & Roles -> Settings; PO_VERIFY_REQUIRED in .env is the default): a PO
 * of a channel that is OFF is never blocked. Removing this router (and po-verify) removes the step entirely.
 */

const gate = Router();

const check = (idsOf: (req: Request) => string[]) => async (req: Request, _res: Response, next: NextFunction) => {
  try {
    const ids = idsOf(req).filter((id) => UPLOAD_ID_PATTERN.test(id));
    // Bad or missing ids: the hand-off route itself answers with its usual error.
    if (!ids.length) return next();
    const blocked = await unverifiedIds(ids);
    if (blocked.length) throw appError(ERROR_CODES.PO_NOT_VERIFIED, blocked.join(', '));
    next();
  } catch (err) {
    next(err);
  }
};

const bodyIds = (req: Request): string[] => {
  const v = (req.body as Record<string, unknown> | undefined)?.[UNIWARE_HANDOFF.BODY_IDS];
  return Array.isArray(v) ? v.map(String) : [];
};

gate.get(UNIWARE_HANDOFF.CSV_ONE, requireAuth, check((req) => [req.params.uploadId]));
gate.post(UNIWARE_HANDOFF.CSV_MANY, requireAuth, check(bodyIds));
// Undo of an upload mark is never blocked.
gate.post(UNIWARE_HANDOFF.MARK_UPLOADED, requireAuth, check((req) =>
  (req.body as Record<string, unknown> | undefined)?.[UNIWARE_HANDOFF.BODY_UNDO] === true ? [] : bodyIds(req)));

export default gate;
