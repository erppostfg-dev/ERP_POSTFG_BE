import { In } from 'typeorm';
import { AppDataSource } from '../../config/data-source';
import { ChannelName, ISSUE_ACTION, ISSUE_STATUS, REVIEW_RECHECK, SYSTEM_ACTOR, UPLOAD_STATUS } from '../../constants';
import { LOG_SOURCE } from '../../constants/logging';
import { PoIssue, PoIssueAction, PoUpload } from '../../entities';
import { AppError } from '../../utils/AppError';
import { logError } from '../../utils/classify-error';
import { log } from '../../utils/logger';
import { readS3Json } from '../email-intake/s3-mirror.service';
import { issueKey } from '../po-pipeline/po-uploads.service';
import { ProcessedPo } from '../po-processing/common/processed-po';
import { ChannelMasterData, MasterDataReader } from '../po-validation/master-data';
import { validatePo } from '../po-validation/validate-po';
import { completeAfterRecheck } from './po-review-actions.service';
import { bumpReview } from './po-review.live';

/*
 * Re-check of POs in review after a master fix (user, 2026-10-22; constants/po-review REVIEW_RECHECK). For every PO in
 * review (optionally only some channels):
 *   1. validation again: processed.json from S3 against today's master (nothing local);
 *   2. its open issues of a master-fixable type (SKU / location / MRP / price / total) that validation no longer finds
 *      are closed: approved by "system", remark "Fixed in master, re-checked automatically", an issue action row;
 *   3. nothing open left and validation clean -> saved like an approved PO (completeAfterRecheck: sale order + CSV);
 *      something left -> it stays in review with only that.
 * Never touched: POs waiting for approval / rejected / completed (only status needs_review is read) and issues that
 * need a person (expired, FOC / revised, duplicate, OCR, qty, a Verify remark). One bad PO never stops the others.
 */

export interface RecheckResult {
  checked: number;
  /** Issues closed because the master now fixes them. */
  issuesClosed: number;
  /** POs that passed and were saved (sale order + CSV). */
  completed: { uploadId: string; poNumber: string | null; saleOrder: string }[];
  /** POs that had some issues closed but still need a person. */
  partly: number;
  failed: number;
}

export const recheckInReview = async (opts: { channels?: string[]; trigger: string } = { trigger: REVIEW_RECHECK.TRIGGER.TIMER }): Promise<RecheckResult> => {
  const out: RecheckResult = { checked: 0, issuesClosed: 0, completed: [], partly: 0, failed: 0 };
  const where = { status: UPLOAD_STATUS.NEEDS_REVIEW, ...(opts.channels?.length ? { channel: In(opts.channels) } : {}) };
  const uploads = await AppDataSource.getRepository(PoUpload).find({ where, order: { id: 'ASC' } });
  if (!uploads.length) return out;

  const reader = new MasterDataReader(AppDataSource);
  const masters = new Map<string, ChannelMasterData | null>();
  const issues = AppDataSource.getRepository(PoIssue);
  const actions = AppDataSource.getRepository(PoIssueAction);

  for (const u of uploads) {
    out.checked++;
    try {
      const url = u.ocrResult?.processed_json;
      const po = typeof url === 'string' ? await readS3Json<ProcessedPo>(url) : undefined;
      if (!po) continue;
      if (!masters.has(po.channel_name)) masters.set(po.channel_name, await reader.forChannel(po.channel_name as ChannelName));
      const master = masters.get(po.channel_name) ?? null;
      // A channel this server does not know (older code on another machine sharing the DB, 2026-10-27: dev EC2 closed
      // new Nykaa POs' SKU issues as "fixed"): never touched here, its issues stay as they are.
      if (!master) {
        log.info(LOG_SOURCE.APP, `[recheck] upload ${u.id}: channel "${po.channel_name}" not known by this server, skipped`);
        continue;
      }
      const v = await validatePo(po, master);
      const stillFound = new Set(v.issues.map((i) => issueKey(i.type, i.lineNo, i.field)));

      const open = await issues.findBy({ uploadId: u.id, status: ISSUE_STATUS.OPEN });
      const fixed = open.filter((i) => REVIEW_RECHECK.FIXABLE.includes(i.issueType) && !stillFound.has(issueKey(i.issueType, i.lineNo, i.fieldName)));
      const now = new Date();
      for (const i of fixed) {
        await issues.save({ ...i, status: ISSUE_STATUS.APPROVED, resolvedBy: SYSTEM_ACTOR, resolvedAt: now, remark: REVIEW_RECHECK.REMARK });
        await actions.save(actions.create({ issueId: i.id, action: ISSUE_ACTION.APPROVED, actionBy: SYSTEM_ACTOR, remark: REVIEW_RECHECK.REMARK, beforeValue: i.originalValues }));
      }
      out.issuesClosed += fixed.length;

      const left = open.length - fixed.length;
      if (left === 0 && v.issues.length === 0 && v.location && fixed.length) {
        try {
          const r = await completeAfterRecheck(String(u.id), REVIEW_RECHECK.REMARK);
          out.completed.push({ uploadId: String(u.id), poNumber: u.poNumber, saleOrder: r.saleOrderCode });
        } catch (err) {
          // Something new turned up in the meantime: it stays in review, as it is.
          if (!(err instanceof AppError) || err.statusCode >= 500) throw err;
          out.partly++;
        }
      } else if (fixed.length) out.partly++;
    } catch (err) {
      out.failed++;
      logError(LOG_SOURCE.APP, `[recheck] upload ${u.id} could not be re-checked (stays in review)`, err);
    }
  }
  if (out.issuesClosed || out.completed.length) bumpReview();
  log.info(
    LOG_SOURCE.APP,
    `[recheck] ${opts.trigger}: ${out.checked} in review checked, ${out.issuesClosed} issue(s) fixed in master, ${out.completed.length} PO(s) passed${out.completed.length ? ` (${out.completed.map((c) => `${c.poNumber} ${c.saleOrder}`).join(', ')})` : ''}, ${out.partly} partly, ${out.failed} failed`,
  );
  return out;
};
