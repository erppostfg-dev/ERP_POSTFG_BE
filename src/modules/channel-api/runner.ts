import fs from 'fs/promises';
import path from 'path';
import { AppDataSource } from '../../config/data-source';
import { env } from '../../config/env';
import { CHANNEL_API, FILES, FOLDERS, PROVIDERS, UPLOAD_STATUS } from '../../constants';
import { ChannelApiSync, PoUpload } from '../../entities';
import { syncEmailToS3 } from '../email-intake/s3-mirror.service';
import { runChainFor, takeSlot } from '../po-pipeline/pipeline.service';
import { MasterDataReader } from '../po-validation/master-data';
import { validatePo } from '../po-validation/validate-po';
import { ChannelConnector, ExternalPo, ExternalRef } from './connector';

/*
 * One run of a channel API connector (2026-10-16), shared by every channel:
 *   1. which POs changed since the check point (minus an overlap), plus the ids that failed last time;
 *   2. per PO: skip (cancelled / closed), wait (not ready yet, e.g. WORKING), exists (already a po_uploads row that is
 *      not failed: never taken twice), else ready;
 *   3. dry run (check): fetch its lines and say whether it would pass or go to review, writing nothing;
 *      apply: write storage/emails/channel-api/<date>_<id>/ (metadata.json, api-raw.json, processed.json), copy it to
 *      S3, then the SAME chain as an email PO (po_uploads + issues -> PO tables + sale order + Uniware CSV);
 *   4. the check point moves only after the run listed successfully; a PO that failed is retried next run by its id.
 * One bad PO never stops the others. PIPELINE_LIMIT counts API POs too.
 */

export type Decision = 'ready' | 'waiting' | 'skipped' | 'exists';

export interface RunItem {
  externalId: string;
  status: string;
  label: string;
  decision: Decision;
  lines?: number;
  /** Dry run: what validation would say. */
  wouldPass?: boolean;
  reasons?: string[];
  /** Apply: what the chain did. */
  result?: string;
  saleOrder?: string;
  error?: string;
}

export interface RunOptions {
  apply: boolean;
  /** Only these ids (the pull command); no check point change. */
  ids?: string[];
  /** Window start (else the check point); for the check command's --days. */
  since?: Date;
  /** At most this many POs processed (apply). */
  max?: number;
  /** Save the check point (the scheduler). */
  saveCheckpoint?: boolean;
}

const syncRepo = () => AppDataSource.getRepository(ChannelApiSync);

export const syncStateOf = async (c: ChannelConnector): Promise<ChannelApiSync> =>
  (await syncRepo().findOneBy({ connector: c.key })) ?? syncRepo().create({ connector: c.key, failures: 0 });

const decide = async (c: ChannelConnector, ref: ExternalRef): Promise<Decision> => {
  if (c.isSkipped(ref.status)) return 'skipped';
  if (!c.isReady(ref.status)) return 'waiting';
  const row = await AppDataSource.getRepository(PoUpload).findOneBy({ sourceSystem: c.key, externalId: ref.externalId });
  return row && row.status !== UPLOAD_STATUS.FAILED ? 'exists' : 'ready';
};

const folderOf = (po: ExternalPo) =>
  path.resolve(env.storage.emailDir, FOLDERS.CHANNEL_API, `${po.createdAt}_${po.externalId.replace(/[^A-Za-z0-9._-]+/g, '_')}`);

/** Writes the PO as an email-like folder, copies it to S3 and runs the chain. */
const ingest = async (c: ChannelConnector, po: ExternalPo, master: Awaited<ReturnType<MasterDataReader['forChannel']>>) => {
  const folder = folderOf(po);
  await fs.mkdir(folder, { recursive: true });
  const metaFile = path.join(folder, FILES.METADATA);
  const old = JSON.parse(await fs.readFile(metaFile, 'utf8').catch(() => '{}')) as Record<string, unknown>;
  const meta = {
    ...old, // keeps s3Folder from an earlier try
    messageId: `${c.key}:${po.externalId}`,
    provider: PROVIDERS.CHANNEL_API,
    channel: c.channel,
    poNumber: po.poNumber,
    sourceSystem: c.key,
    externalId: po.externalId,
    externalStatus: po.status,
    subject: po.label,
    receivedAt: `${po.createdAt}T00:00:00.000Z`,
    storedAt: new Date().toISOString(),
  };
  await fs.writeFile(metaFile, `${JSON.stringify(meta, null, 2)}\n`);
  await fs.writeFile(path.join(folder, FILES.API_RAW), `${JSON.stringify(po.rawFull, null, 2)}\n`);
  await fs.writeFile(path.join(folder, FILES.PROCESSED), `${JSON.stringify(c.toProcessed(po, master), null, 2)}\n`);
  await syncEmailToS3(folder); // before the chain: the review screen reads processed.json from S3
  return runChainFor(folder);
};

export const runConnector = async (c: ChannelConnector, opts: RunOptions): Promise<{ items: RunItem[]; until: Date; since: Date }> => {
  const state = await syncStateOf(c);
  const until = new Date(Date.now() - CHANNEL_API.SETTLE_MS);
  const since = opts.since ?? (state.syncedUntil ? new Date(state.syncedUntil.getTime() - CHANNEL_API.OVERLAP_MS) : new Date(until.getTime() - CHANNEL_API.FIRST_LOOKBACK_MS));
  const retryIds = ((state.lastResult?.retryIds as string[] | undefined) ?? []).filter(Boolean);

  const refs = opts.ids ? await c.listByIds(opts.ids) : await c.listChanged(since, until);
  if (!opts.ids && retryIds.length) {
    for (const r of await c.listByIds(retryIds)) if (!refs.some((x) => x.externalId === r.externalId)) refs.push(r);
  }

  // The channel's list can repeat a PO (Amazon did, 2026-10-16): each id once per run.
  const unique = [...new Map(refs.map((r) => [r.externalId, r])).values()];
  refs.length = 0;
  refs.push(...unique);

  const reader = new MasterDataReader(AppDataSource);
  const master = await reader.forChannel(c.channel);
  const items: RunItem[] = [];
  const failed: string[] = [];
  let done = 0;
  for (const ref of refs) {
    const item: RunItem = { externalId: ref.externalId, status: ref.status, label: ref.label, decision: await decide(c, ref) };
    items.push(item);
    if (item.decision !== 'ready') continue;
    try {
      const po = await c.fetch(ref);
      const processed = c.toProcessed(po, master);
      item.lines = processed.line_items.length;
      if (!opts.apply) {
        const v = await validatePo(processed, master);
        item.wouldPass = v.issues.length === 0 && !!v.location;
        item.reasons = [...new Set(v.issues.map((i) => i.message))].slice(0, 6);
        continue;
      }
      if (opts.max !== undefined && done >= opts.max) { item.result = 'not taken (max reached)'; continue; }
      if (!takeSlot()) { item.result = 'not taken (PIPELINE_LIMIT reached)'; failed.push(ref.externalId); continue; }
      done++;
      const out = await ingest(c, po, master);
      const r = out.find((x) => x.poNumber === po.poNumber);
      item.result = r?.status ?? 'unknown';
      item.saleOrder = r?.saleOrder;
      if (r?.error) { item.error = r.error; failed.push(ref.externalId); }
    } catch (err) {
      item.error = (err instanceof Error ? err.message : String(err)).slice(0, CHANNEL_API.ERROR_MAX);
      failed.push(ref.externalId);
    }
  }

  if (opts.saveCheckpoint) {
    const count = (d: Decision) => items.filter((i) => i.decision === d).length;
    await syncRepo().save({
      ...state,
      syncedUntil: until,
      lastRunAt: new Date(),
      lastSuccessAt: new Date(),
      failures: 0,
      lastError: failed.length ? `${failed.length} PO(s) failed, retried next run` : null,
      lastResult: { seen: items.length, ready: count('ready'), waiting: count('waiting'), skipped: count('skipped'), exists: count('exists'), failed: failed.length, retryIds: failed },
    });
  }
  return { items, until, since };
};

/** A run that failed as a whole (the channel's API down, login refused): counted for the back-off; check point kept. */
export const recordRunFailure = async (c: ChannelConnector, err: unknown): Promise<number> => {
  const state = await syncStateOf(c);
  const failures = (state.failures ?? 0) + 1;
  await syncRepo().save({ ...state, lastRunAt: new Date(), failures, lastError: (err instanceof Error ? err.message : String(err)).slice(0, CHANNEL_API.ERROR_MAX) });
  return failures;
};
