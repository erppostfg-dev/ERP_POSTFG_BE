import fs from 'fs/promises';
import path from 'path';
import { AppDataSource } from '../../config/data-source';
import { env } from '../../config/env';
import { CHANNEL_API, FILES, FOLDERS, IST_OFFSET_MS, PROVIDERS, UPLOAD_STATUS } from '../../constants';
import { ChannelApiSync, PoUpload } from '../../entities';
import { syncEmailToS3 } from '../email-intake/s3-mirror.service';
import { runChainFor, takeSlot } from '../po-pipeline/pipeline.service';
import { emailValues } from '../po-pipeline/po-uploads.service';
import { intakeGate, processFromOf, shouldHold } from '../po-intake-control/intake-settings.service';
import { MasterDataReader } from '../po-validation/master-data';
import { validatePo } from '../po-validation/validate-po';
import { ChannelConnector, ExternalPo, ExternalRef } from './connector';
import { CONNECTORS } from './registry';

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

/** Writes the PO as an email-like folder (metadata, api-raw, processed.json) and copies it to S3. */
const writeFolder = async (c: ChannelConnector, po: ExternalPo, master: Awaited<ReturnType<MasterDataReader['forChannel']>>): Promise<string> => {
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
  return folder;
};

/** Writes the PO's folder and runs the chain. */
const ingest = async (c: ChannelConnector, po: ExternalPo, master: Awaited<ReturnType<MasterDataReader['forChannel']>>) =>
  runChainFor(await writeFolder(c, po, master));

/** PO intake OFF / over today's limit (2026-10-23): the folder is written and S3 has it, the row waits as "held". */
const hold = async (c: ChannelConnector, po: ExternalPo, master: Awaited<ReturnType<MasterDataReader['forChannel']>>) => {
  const folder = await writeFolder(c, po, master);
  const repo = AppDataSource.getRepository(PoUpload);
  await repo.save(repo.create({ ...(await emailValues(folder, master?.channel.displayName ?? null)), poNumber: po.poNumber, status: UPLOAD_STATUS.HELD }));
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
    // PO intake OFF (2026-10-23): not even fetched; switching on rewinds the check point to its start (rewindTo).
    if (opts.apply && (await intakeGate(c.channel, null)) === 'off') { item.result = 'off'; continue; }
    try {
      const po = await c.fetch(ref);
      // Before the channel's "process from" day (2026-10-23): not taken (tracking still sees it).
      const from = await processFromOf(c.channel);
      if (from && po.createdAt < new Date(from.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10)) { item.result = 'before start'; continue; }
      const processed = c.toProcessed(po, master);
      item.lines = processed.line_items.length;
      if (!opts.apply) {
        const v = await validatePo(processed, master);
        item.wouldPass = v.issues.length === 0 && !!v.location;
        item.reasons = [...new Set(v.issues.map((i) => i.message))].slice(0, 6);
        continue;
      }
      if (opts.max !== undefined && done >= opts.max) { item.result = 'not taken (max reached)'; continue; }
      if (await shouldHold(c.channel)) { await hold(c, po, master); item.result = UPLOAD_STATUS.HELD; continue; }
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
    // Rewound while this run was going (a channel switched on): keep the rewound point, the next run reads from it.
    const now = await syncStateOf(c);
    const rewound = !!now.syncedUntil && (!state.syncedUntil || now.syncedUntil < state.syncedUntil);
    await syncRepo().save({
      ...state,
      syncedUntil: rewound ? now.syncedUntil : until,
      lastRunAt: new Date(),
      lastSuccessAt: new Date(),
      failures: 0,
      lastError: failed.length ? `${failed.length} PO(s) failed, retried next run` : null,
      lastResult: { seen: items.length, ready: count('ready'), waiting: count('waiting'), skipped: count('skipped'), exists: count('exists'), failed: failed.length, retryIds: failed },
    });
  }
  return { items, until, since };
};

/**
 * PO intake (2026-10-23): a channel switched on, or its start moved earlier -> its connectors read again from `to`
 * on the next run (only ever moved back, never forward).
 */
export const rewindTo = async (channel: string, to: Date): Promise<void> => {
  for (const c of CONNECTORS.filter((x) => x.channel === channel)) {
    const state = await syncStateOf(c);
    if (!state.syncedUntil || state.syncedUntil > to) await syncRepo().save({ ...state, syncedUntil: to });
  }
};

/** A run that failed as a whole (the channel's API down, login refused): counted for the back-off; check point kept. */
export const recordRunFailure = async (c: ChannelConnector, err: unknown): Promise<number> => {
  const state = await syncStateOf(c);
  const failures = (state.failures ?? 0) + 1;
  await syncRepo().save({ ...state, lastRunAt: new Date(), failures, lastError: (err instanceof Error ? err.message : String(err)).slice(0, CHANNEL_API.ERROR_MAX) });
  return failures;
};
