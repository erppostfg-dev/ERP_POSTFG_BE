import { In, IsNull } from 'typeorm';
import { AppDataSource } from '../../../config/data-source';
import { env } from '../../../config/env';
import { FLIPKART, SOURCE_SYSTEM } from '../../../constants';
import { ChannelPullItem } from '../../../entities';
import { ChannelConnector, ExternalPo, ExternalRef } from '../connector';
import { ConsignmentData, consignmentToProcessed } from './consignments.parse';

/*
 * Flipkart scheduled consignments (2026-10-30). The robot run (consignments.service.ts) fetches them from Seller Hub into
 * channel_pull_items; this connector only reads that table, so the shared runner treats them like Amazon's shipments:
 * PO intake switch / start date / daily limit, never taken twice, S3 channel-api/FY.../<month>/flipkart/<id>/ (with the
 * consignment's own CSV), the same chain. A consignment the Bulk Consignment File did not list yet (no status) waits for
 * the next robot run; a cancelled one is never taken.
 */

const repo = () => AppDataSource.getRepository(ChannelPullItem);

const refOf = (r: ChannelPullItem): ExternalRef => ({
  externalId: r.externalId,
  status: r.status ?? '',
  label: r.label,
  raw: r,
});

export const flipkartConnector: ChannelConnector = {
  key: SOURCE_SYSTEM.FLIPKART_SELLER_HUB,
  channel: FLIPKART.CHANNEL,
  label: 'Flipkart Seller Hub (scheduled consignments)',
  pollMinutes: () => env.channelApi.flipkart.pollMinutes || FLIPKART.POLL_MINUTES,
  // the robot's login (the In-transit Seller Hub keys); without it nothing is ever fetched
  configured: () => !!(env.intransit.flipkart.sellerHub.user && env.intransit.flipkart.sellerHub.password),
  // scheduled = a PO + sale order at once; only a consignment with no status yet (not in the bulk file) waits
  isReady: (status) => status !== '',
  isSkipped: (status) => FLIPKART.SKIP_STATUS.test(status),

  // fetched in the window, plus any not taken yet (one the PO intake held back stays listed until taken)
  async listChanged(since, until) {
    const rows = await repo().createQueryBuilder('p')
      .where('p.sourceSystem = :s', { s: SOURCE_SYSTEM.FLIPKART_SELLER_HUB })
      .andWhere('((p.fetchedAt >= :since AND p.fetchedAt < :until) OR p.takenAt IS NULL)', { since, until })
      .orderBy('p.id', 'ASC')
      .getMany();
    return rows.map(refOf);
  },

  async listByIds(ids) {
    if (!ids.length) return [];
    return (await repo().findBy({ sourceSystem: SOURCE_SYSTEM.FLIPKART_SELLER_HUB, externalId: In(ids) })).map(refOf);
  },

  async fetch(ref): Promise<ExternalPo> {
    const r = ref.raw as ChannelPullItem;
    const data = r.data as unknown as ConsignmentData;
    return {
      ...ref,
      poNumber: r.externalId,
      createdAt: r.createdOn ?? r.fetchedAt.toISOString().slice(0, 10),
      rawFull: { row: data.row, header: data.header },
      // the consignment's file as Flipkart gave it, next to api-raw.json in its folder (and S3)
      files: [{ name: FLIPKART.CSV_FILE(r.externalId), text: data.csv }],
    };
  },

  /** Not listed as new again once the runner took it (made a PO, held, or already one). */
  async markTaken(externalIds) {
    if (!externalIds.length) return;
    await repo().update({ sourceSystem: SOURCE_SYSTEM.FLIPKART_SELLER_HUB, externalId: In(externalIds), takenAt: IsNull() }, { takenAt: new Date() });
  },

  toProcessed(po) {
    const r = po.raw as ChannelPullItem;
    return consignmentToProcessed(r.externalId, r.data as unknown as ConsignmentData, po.createdAt);
  },
};

