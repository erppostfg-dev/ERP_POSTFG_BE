import { In, IsNull } from 'typeorm';
import { AppDataSource } from '../../../config/data-source';
import { env } from '../../../config/env';
import { MYNTRA_STR, SOURCE_SYSTEM } from '../../../constants';
import { ChannelPullItem } from '../../../entities';
import { readS3Text, s3UrlOfKey } from '../../email-intake/s3-mirror.service';
import { ChannelConnector, ExternalPo, ExternalRef } from '../connector';
import type { StrItemData } from './str.types';
import { strToProcessed } from './str.parse';

/*
 * Myntra STRs -> POs (step 2, 2026-11-03). The robot (str.service.ts) keeps each STR's CSV + processed.json in S3 and
 * marks its channel_pull_items row `stored`; this connector hands the stored, not yet taken ones to the shared runner,
 * like Flipkart's consignments: PO intake switch / start / daily limit, never taken twice, the same chain (validation ->
 * PO + sale order + Uniware CSV, or In Review), in the same S3 folder. Checks (user): SKU, MRP, location (+ its Uniware
 * channel vs the user's sheet) and the rest; NO price / total check: the sale order takes our master rate (margin 0.85)
 * and our GST (OUR_PRICE_ONLY_CHANNELS), Myntra's prices stay information on the PO.
 */

const repo = () => AppDataSource.getRepository(ChannelPullItem);
const S = SOURCE_SYSTEM.MYNTRA_STR;

const refOf = (r: ChannelPullItem): ExternalRef => ({ externalId: r.externalId, status: r.status ?? '', label: r.label, raw: r });

export const myntraStrConnector: ChannelConnector = {
  key: S,
  channel: MYNTRA_STR.CHANNEL,
  label: 'Myntra STRs (from the "Request to Raise STRs" email)',
  pollMinutes: () => MYNTRA_STR.POLL_MINUTES,
  // the robot's login (the In-transit Myntra keys)
  configured: () => !!(env.intransit.myntra.user && env.intransit.myntra.password),
  // stored in S3 = ready; waiting / failed never become a PO
  isReady: (status) => MYNTRA_STR.PROCESSING && status === MYNTRA_STR.STATUS.STORED,
  isSkipped: (status) => status === MYNTRA_STR.STATUS.FAILED,

  // stored in the window, plus any stored one not taken yet (one the PO intake held back stays listed until taken)
  async listChanged(since, until) {
    if (!MYNTRA_STR.PROCESSING) return [];
    const rows = await repo().createQueryBuilder('p')
      .where('p.sourceSystem = :s AND p.status = :stored', { s: S, stored: MYNTRA_STR.STATUS.STORED })
      .andWhere('((p.fetchedAt >= :since AND p.fetchedAt < :until) OR p.takenAt IS NULL)', { since, until })
      .orderBy('p.id', 'ASC')
      .getMany();
    return rows.map(refOf);
  },

  async listByIds(ids) {
    if (!ids.length) return [];
    return (await repo().findBy({ sourceSystem: S, externalId: In(ids) })).map(refOf);
  },

  /** The STR's CSV as the robot stored it in S3 (never kept on the server). */
  async fetch(ref): Promise<ExternalPo> {
    const r = ref.raw as ChannelPullItem;
    const data = r.data as unknown as StrItemData;
    const file = MYNTRA_STR.CSV_FILE(r.externalId);
    const csv = data.s3Folder ? await readS3Text(s3UrlOfKey(`${data.s3Folder}/${file}`)) : undefined;
    if (csv === undefined) throw new Error(`${r.externalId}: its CSV is not in S3 (${data.s3Folder ?? 'no folder'}); the robot fetches it again`);
    return {
      ...ref,
      poNumber: r.externalId,
      createdAt: r.createdOn ?? r.fetchedAt.toISOString().slice(0, 10),
      rawFull: { str: r.externalId, order: data.order, group: data.group, priority: data.priority, destination: data.destination, email: data.email, summary: data.summary },
      files: [{ name: file, text: csv }],
    };
  },

  /** Not listed as new again once the runner took it (made a PO, held, or already one). */
  async markTaken(externalIds) {
    if (!externalIds.length) return;
    await repo().update({ sourceSystem: S, externalId: In(externalIds), takenAt: IsNull() }, { takenAt: new Date() });
  },

  toProcessed(po) {
    const r = po.raw as ChannelPullItem;
    const d = r.data as unknown as StrItemData;
    return strToProcessed({ str: r.externalId, date: r.createdOn ?? '', destination: d.destination, group: d.group, priority: d.priority }, po.files?.[0]?.text ?? '').po;
  },
};
