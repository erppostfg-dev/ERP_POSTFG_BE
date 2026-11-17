import { BULK_ORDER_TYPE, BULK_SALE } from './bulk-orders';

/*
 * PO group (2026-11-16, user; PEPIMS + dev -> prod migration): what kind of order a master_purchase_orders row is.
 * Only POST_FG's own channels are final, so PEPIMS's other "channel" names (one-off buyers, marketing, packaging
 * suppliers) are saved under one of our channels and keep their original name in partyName:
 *   Channel            our sales channels (Blinkit, Amazon, ...)
 *   D2C                McaffeineB2C, HYP_Website
 *   Marketing          channel Bulk Marketing (Bulk Orders + the user's PEPIMS list)
 *   Institutional      channel Bulk Institutional (Bulk Orders + the user's PEPIMS list)
 *   Internal Transfer  our warehouses as the channel (GGN_WAREHOUSE, MUM_WAREHOUSE2, KOL_WAREHOUSE)
 *   Others             channel "Others" (switched off): every other PEPIMS name
 * New rows get it from their channel (poGroupOf); the migration PepimsMigration filled the rows that existed.
 */
export const PO_GROUP = {
  CHANNEL: 'Channel',
  D2C: 'D2C',
  MARKETING: 'Marketing',
  INSTITUTIONAL: 'Institutional',
  INTERNAL_TRANSFER: 'Internal Transfer',
  OTHERS: 'Others',
} as const;
export type PoGroup = (typeof PO_GROUP)[keyof typeof PO_GROUP];
/** In the order the screen lists them. */
export const PO_GROUPS: readonly PoGroup[] = Object.values(PO_GROUP);

/** master_purchase_orders.importedFrom: where an imported PO came from (null = made by POST_FG). */
export const PO_IMPORTED_FROM = { PEPIMS: 'pepims' } as const;
export type PoImportedFrom = (typeof PO_IMPORTED_FROM)[keyof typeof PO_IMPORTED_FROM];

/** The channel of group Others (migration PepimsMigration, switched OFF, fixed id next to the bulk channels). */
export const OTHERS_CHANNEL = { ID: 9103, SLUG: 'others', NAME: 'Others' } as const;

/** master_channels rows that exist only for the PO's channel FK: the Masters pages and forms leave them out. */
export const FK_ONLY_CHANNEL_IDS: readonly number[] = [...BULK_SALE.CHANNEL_IDS, OTHERS_CHANNEL.ID];

/** Channel names of the D2C and Internal Transfer groups (PEPIMS's spelling = our master_channels display names). */
export const D2C_GROUP_CHANNELS: readonly string[] = ['McaffeineB2C', 'HYP_Website'];
export const INTERNAL_TRANSFER_CHANNELS: readonly string[] = ['GGN_WAREHOUSE', 'MUM_WAREHOUSE2', 'KOL_WAREHOUSE'];

const key = (v: string | null | undefined): string => (v ?? '').trim().toLowerCase();
const GROUP_OF_CHANNEL = new Map<string, PoGroup>([
  [key(BULK_SALE.CHANNEL[BULK_ORDER_TYPE.MARKETING]), PO_GROUP.MARKETING],
  [key(BULK_SALE.CHANNEL[BULK_ORDER_TYPE.INSTITUTIONAL]), PO_GROUP.INSTITUTIONAL],
  [key(OTHERS_CHANNEL.NAME), PO_GROUP.OTHERS],
  ...D2C_GROUP_CHANNELS.map((c): [string, PoGroup] => [key(c), PO_GROUP.D2C]),
  ...INTERNAL_TRANSFER_CHANNELS.map((c): [string, PoGroup] => [key(c), PO_GROUP.INTERNAL_TRANSFER]),
]);

/** The group a PO of this channel belongs to (any other channel = Channel). */
export const poGroupOf = (channel: string | null | undefined): PoGroup => GROUP_OF_CHANNEL.get(key(channel)) ?? PO_GROUP.CHANNEL;
