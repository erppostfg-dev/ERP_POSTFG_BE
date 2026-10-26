import { NextFunction, Request, Response, Router } from 'express';
import { ACCESS_LEVEL, ERROR_CODES, PAGE, PO_INTAKE } from '../constants';
import { USER_ADMIN_ROLES } from '../constants/users';
import { requireAuth, requirePage } from '../modules/auth/auth.middleware';
import { kickRelease } from '../modules/po-intake-control/intake-release.service';
import { IntakeChannel, intakeStateOf, listIntake, setUniversal, updateIntake } from '../modules/po-intake-control/intake-settings.service';
import { rewindTo } from '../modules/channel-api/runner';
import { runChannelNow } from '../modules/channel-api/scheduler';
import { backfillSince } from '../modules/email-intake/label-router.service';
import { runJob } from '../utils/log-call';
import { logError } from '../utils/classify-error';
import { LOG_SOURCE } from '../constants/logging';
import { appError } from '../utils/AppError';

/*
 * PO intake per channel (user, 2026-10-23; constants/intake.ts), Users & Roles -> Settings -> PO intake. Admin /
 * developer only, like the rest of Users & Roles:
 *   GET   /admin/po-intake             { universal: { processFrom … }, channels: [on, limit, process from, today, held] }
 *   PATCH /admin/po-intake/universal   { processFrom: ISO | null } -> set on EVERY channel (overwrites their own)
 *   PATCH /admin/po-intake/:channel    { enabled?, dailyLimit?: number | null, processFrom?: ISO | null }
 * After a change: held POs go on (one by one). One-time catch-up, for THAT channel only, when it is switched ON or
 * its start moves earlier while ON: email -> its labelled Gmail emails from the start until now that POST_FG lacks
 * (background); API (Amazon) -> its check point back to the start + one run now. OFF channels: nothing comes in.
 */

const router = Router();

const requireUserAdmin = (req: Request, _res: Response, next: NextFunction) => {
  if (!req.auth?.roles.some((r) => (USER_ADMIN_ROLES as readonly string[]).includes(r))) {
    return next(appError(ERROR_CODES.NOT_A_USER_ADMIN, USER_ADMIN_ROLES.join(' / ')));
  }
  next();
};
const admin = [requireAuth, requirePage(PAGE.ADMIN, ACCESS_LEVEL.EDITOR), requireUserAdmin];

/** processFrom from the body: undefined = not sent, null = cleared, a Date; anything else -> problem. */
const readProcessFrom = (b: Record<string, unknown>, problems: { field: string; code: string; message: string }[]): Date | null | undefined => {
  const v = b[PO_INTAKE.BODY.PROCESS_FROM];
  if (v === undefined || v === null) return v as undefined | null;
  if (typeof v === 'string' && !Number.isNaN(Date.parse(v))) return new Date(v);
  problems.push({ field: PO_INTAKE.BODY.PROCESS_FROM, code: ERROR_CODES.FIELD_NOT_ISO_DATE, message: 'processFrom: a date-time (ISO) or null' });
  return undefined;
};

/** The one-time catch-up of one channel from its start (background; Gmail catch-ups run one after another). */
const catchUp = (c: Pick<IntakeChannel, 'channel' | 'source'>, from: Date) => {
  if (c.source === 'email') {
    void runJob('intake-backfill', () => backfillSince(from, c.channel), { channel: c.channel })
      .catch((err) => logError(LOG_SOURCE.GMAIL, `[intake] ${c.channel}: catch-up from its start failed (switch it off and on to try again)`, err));
    return;
  }
  void rewindTo(c.channel, from)
    .then(() => runChannelNow(c.channel))
    .catch((err) => logError(LOG_SOURCE.AMAZON, `[intake] ${c.channel}: catch-up from its start failed (the next run tries again)`, err));
};

/** Catch-up needed: ON now, and it was OFF before or its start moved earlier. */
const needsCatchUp = (before: { enabled: boolean; processFrom: Date | null } | null, after: { enabled: boolean; processFrom: Date | null }) =>
  !!after.enabled && !!after.processFrom && (!before?.enabled || !before.processFrom || after.processFrom < before.processFrom);

router.patch(PO_INTAKE.ROUTES.UNIVERSAL, ...admin, async (req, res, next) => {
  try {
    const problems: { field: string; code: string; message: string }[] = [];
    const from = readProcessFrom((req.body ?? {}) as Record<string, unknown>, problems);
    if (problems.length || from === undefined) throw appError(ERROR_CODES.VALIDATION_FAILED).withDetails(problems.length ? problems : [{ field: PO_INTAKE.BODY.PROCESS_FROM, code: ERROR_CODES.FIELD_REQUIRED, message: 'processFrom: required (ISO date-time or null)' }]);
    const before = (await listIntake()).channels;
    const out = await setUniversal(from, { id: req.auth!.user.id, email: req.auth!.user.email });
    for (const c of out.channels) {
      const was = before.find((x) => x.channel === c.channel);
      const toDate = (v: string | null | undefined) => (v ? new Date(v) : null);
      if (needsCatchUp(was ? { enabled: was.enabled, processFrom: toDate(was.processFrom) } : null, { enabled: c.enabled, processFrom: toDate(c.processFrom) })) catchUp(c, new Date(c.processFrom!));
    }
    kickRelease();
    res.json({ data: out });
  } catch (err) {
    next(err);
  }
});

router.get(PO_INTAKE.ROUTES.LIST, ...admin, async (_req, res, next) => {
  try {
    res.json({ data: await listIntake() });
  } catch (err) {
    next(err);
  }
});

router.patch(PO_INTAKE.ROUTES.ONE, ...admin, async (req, res, next) => {
  try {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const enabled = b[PO_INTAKE.BODY.ENABLED];
    const limit = b[PO_INTAKE.BODY.DAILY_LIMIT];
    const problems: { field: string; code: string; message: string }[] = [];
    if (enabled !== undefined && typeof enabled !== 'boolean') problems.push({ field: PO_INTAKE.BODY.ENABLED, code: ERROR_CODES.FIELD_REQUIRED, message: 'enabled: true or false' });
    if (limit !== undefined && limit !== null && !(Number.isInteger(limit) && (limit as number) >= 0 && (limit as number) <= PO_INTAKE.MAX_DAILY_LIMIT)) {
      problems.push({ field: PO_INTAKE.BODY.DAILY_LIMIT, code: ERROR_CODES.FIELD_NOT_INT_RANGE, message: `dailyLimit: a whole number 0-${PO_INTAKE.MAX_DAILY_LIMIT}, or null for no limit` });
    }
    const processFrom = readProcessFrom(b, problems);
    if (problems.length) throw appError(ERROR_CODES.VALIDATION_FAILED).withDetails(problems);
    const before = await intakeStateOf(req.params.channel);
    const out = await updateIntake(
      req.params.channel,
      { enabled: enabled as boolean | undefined, dailyLimit: limit as number | null | undefined, processFrom },
      { id: req.auth!.user.id, email: req.auth!.user.email },
    );
    // Switched on, or its start moved earlier while on: that channel's POs from its start until now, once.
    if (needsCatchUp(before, { enabled: out.enabled, processFrom: out.processFrom ? new Date(out.processFrom) : null })) catchUp(out, new Date(out.processFrom!));
    // Switched on or more room: its held POs go on now, one by one.
    kickRelease();
    res.json({ data: out });
  } catch (err) {
    next(err);
  }
});

export default router;
