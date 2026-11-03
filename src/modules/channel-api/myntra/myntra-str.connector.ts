import { env } from '../../../config/env';
import { MYNTRA_STR, SOURCE_SYSTEM } from '../../../constants';
import { ChannelPullItem } from '../../../entities';
import { ChannelConnector } from '../connector';
import type { StrItemData } from './str.service';
import { strToProcessed } from './str.parse';

/*
 * Myntra STRs on Channel Pulls (2026-11-03). Step 1 (built): the STR email starts the robot, which keeps each STR's CSV +
 * processed.json in S3 (str.service.ts). Step 2 (later, user: "the checks later"): this connector hands the stored STRs
 * to the shared runner like Flipkart's consignments (po_uploads -> validation -> sale order). Until then it lists
 * nothing, so neither the server's timer nor Process now makes a PO from an STR (MYNTRA_STR.PROCESSING = false).
 */

export const myntraStrConnector: ChannelConnector = {
  key: SOURCE_SYSTEM.MYNTRA_STR,
  channel: MYNTRA_STR.CHANNEL,
  label: 'Myntra STRs (from the "Request to Raise STRs" email)',
  pollMinutes: () => MYNTRA_STR.POLL_MINUTES,
  // the robot's login (the In-transit Myntra keys)
  configured: () => !!(env.intransit.myntra.user && env.intransit.myntra.password),
  isReady: () => MYNTRA_STR.PROCESSING,
  isSkipped: () => false,
  listChanged: () => Promise.resolve([]),
  listByIds: () => Promise.resolve([]),
  fetch: () => Promise.reject(new Error('Myntra STRs are not processed into POs yet (step 2)')),
  toProcessed(po) {
    const r = po.raw as ChannelPullItem;
    const d = r.data as unknown as StrItemData;
    return strToProcessed({ str: r.externalId, date: r.createdOn ?? '', destination: d.destination, group: d.group, priority: d.priority }, po.files?.[0]?.text ?? '').po;
  },
};
