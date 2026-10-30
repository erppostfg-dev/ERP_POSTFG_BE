import { Router } from 'express';
import { ACCESS_LEVEL, CHANNEL_PULLS, ERROR_CODES, PAGE } from '../constants';
import { requireAuth, requirePage } from '../modules/auth/auth.middleware';
import { channelPull, connectorOrThrow, hasRobot, listChannelPulls, listPullItems, robotRunOf } from '../modules/channel-api/channel-pulls.service';
import { setRobotSchedule, startRobotRun } from '../modules/channel-api/flipkart/consignments.service';
import { processNow, rescheduleConnector } from '../modules/channel-api/scheduler';
import { savePollSchedule } from '../modules/channel-api/poll-schedule';
import { appError } from '../utils/AppError';

/*
 * Channel Pulls page (2026-10-30; the page key of Amazon Inbound, PAGE.AMAZON_INBOUND, so nobody's access changes).
 * Every channel pulled by API or robot (constants SOURCE_SYSTEM keys: amazon_spapi, flipkart_seller_hub).
 *   GET   /channel-pulls                     every channel: set up, PO intake ON / OFF, last process run, robot + schedule, counts
 *   GET   /channel-pulls/:key/items          the robot's recent fetches (newest first) with the PO each became
 *   GET   /channel-pulls/:key/robot          the robot's last run with its log lines
 * Editor:
 *   POST  /channel-pulls/:key/robot          Run robot now (in the background; 202) - 409 running / login missing
 *   POST  /channel-pulls/:key/process        Process now (in the background; 202): the fetched / changed POs through the chain
 *   PATCH /channel-pulls/:key/schedule       { robotEveryHours: 1-24 | null } robot: its runs (null = Run now only);
 *                                            API: how often the server pulls (null = its default, e.g. Amazon every 2 h)
 */

const router = Router();
const viewer = [requireAuth, requirePage(PAGE.AMAZON_INBOUND, ACCESS_LEVEL.VIEWER)];
const editor = [requireAuth, requirePage(PAGE.AMAZON_INBOUND, ACCESS_LEVEL.EDITOR)];
const by = (req: { auth?: { user: { name: string | null; email: string } } }) => req.auth?.user.name || req.auth?.user.email || 'someone';

router.get(CHANNEL_PULLS.ROUTES.LIST, ...viewer, async (_req, res, next) => {
  try {
    res.json({ data: await listChannelPulls() });
  } catch (err) { next(err); }
});

router.get(CHANNEL_PULLS.ROUTES.ITEMS, ...viewer, async (req, res, next) => {
  try {
    res.json({ data: await listPullItems(String(req.params.key)) });
  } catch (err) { next(err); }
});

router.get(CHANNEL_PULLS.ROUTES.ROBOT, ...viewer, async (req, res, next) => {
  try {
    res.json({ data: await robotRunOf(String(req.params.key)) });
  } catch (err) { next(err); }
});

router.post(CHANNEL_PULLS.ROUTES.ROBOT, ...editor, async (req, res, next) => {
  try {
    const key = String(req.params.key);
    connectorOrThrow(key);
    if (!hasRobot(key)) throw appError(ERROR_CODES.CHANNEL_PULL_NO_ROBOT, key);
    // started here (its checks throw now); the run itself goes on after the answer
    void startRobotRun(`run now (${by(req)})`).catch(() => undefined);
    res.status(202).json({ data: await channelPull(key) });
  } catch (err) { next(err); }
});

router.post(CHANNEL_PULLS.ROUTES.PROCESS, ...editor, async (req, res, next) => {
  try {
    const c = connectorOrThrow(String(req.params.key));
    const started = processNow(c);
    res.status(202).json({ data: { started, pull: await channelPull(c.key) } });
  } catch (err) { next(err); }
});

router.patch(CHANNEL_PULLS.ROUTES.SCHEDULE, ...editor, async (req, res, next) => {
  try {
    const key = String(req.params.key);
    const c = connectorOrThrow(key);
    const v = ((req.body ?? {}) as Record<string, unknown>)[CHANNEL_PULLS.BODY.EVERY_HOURS];
    if (v !== null && !(Number.isInteger(v) && (v as number) >= 1 && (v as number) <= CHANNEL_PULLS.MAX_EVERY_HOURS)) {
      throw appError(ERROR_CODES.VALIDATION_FAILED).withDetails([{
        field: CHANNEL_PULLS.BODY.EVERY_HOURS, code: ERROR_CODES.FIELD_NOT_INT_RANGE, message: `${CHANNEL_PULLS.BODY.EVERY_HOURS}: a whole number 1-${CHANNEL_PULLS.MAX_EVERY_HOURS}, or null for Run now only`,
      }]);
    }
    // robot channels: the robot's runs; API channels: how often the server pulls (null = its default)
    if (hasRobot(key)) await setRobotSchedule(v as number | null, by(req));
    else {
      await savePollSchedule(key, v as number | null, by(req));
      await rescheduleConnector(c);
    }
    res.json({ data: await channelPull(key) });
  } catch (err) { next(err); }
});

export default router;
