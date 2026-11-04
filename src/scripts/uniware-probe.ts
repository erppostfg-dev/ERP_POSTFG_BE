/*
 * D2C Internal Transfers, Phase 0 (2026-11-03): READ-ONLY probe of the Uniware REST calls the transfer feature needs.
 * Tries each candidate path, prints status + the top-level shape, and saves every raw answer to --out (never the repo).
 * Nothing is created, changed or cancelled: only get / search calls.
 *
 *   npx ts-node --transpile-only src/scripts/uniware-probe.ts --out <dir>
 */
import fs from 'fs';
import path from 'path';
import { env } from '../config/env';
import { UniwareApi, uniwareCatalog } from '../modules/intransit/sources/uniware';

const arg = (k: string): string | undefined => {
  const i = process.argv.indexOf(k);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

// Sample PEPIMS transfers (Shipment_Status of 22 Oct 2026): SO at the dispatch facility, inward PO at the receiver.
const S = {
  soDispatched: { code: '20270902460', facility: 'mCaff_Gurgaon3' }, // GGN_WAREHOUSE|21Oct2026|Int15, Dispatched
  soRts: { code: '20270902302', facility: 'MUM_WAREHOUSE2' }, // mCaff_Hyderabad3|15Oct2026|31, RTS
  displayCode: 'GGN_WAREHOUSE|21Oct2026|Int15',
  ipo: { code: 'MGGN1/2627/API/0051', facility: 'GGN_WAREHOUSE' },
  ipo2: { code: 'MHYD3/2627/API/0010', facility: 'mCaff_Hyderabad3' },
  sku: 'MCaf41',
};

const iso = (d: Date) => d.toISOString();
const now = new Date();
const ago = new Date(now.getTime() - 30 * 86400_000);

type Probe = { name: string; path: string; body: unknown; facility?: string };
const probes: Probe[] = [
  // SO get / search
  { name: 'so-get', path: '/services/rest/v1/oms/saleorder/get', body: { code: S.soDispatched.code }, facility: S.soDispatched.facility },
  { name: 'so-get-camel', path: '/services/rest/v1/oms/saleOrder/get', body: { code: S.soDispatched.code }, facility: S.soDispatched.facility },
  { name: 'so-get-rts', path: '/services/rest/v1/oms/saleorder/get', body: { code: S.soRts.code }, facility: S.soRts.facility },
  { name: 'so-search-display', path: '/services/rest/v1/oms/saleOrder/search', body: { displayOrderCode: S.displayCode, fromDate: iso(ago), toDate: iso(now) } },
  { name: 'so-search-display-lc', path: '/services/rest/v1/oms/saleorder/search', body: { displayOrderCode: S.displayCode, fromDate: iso(ago), toDate: iso(now) } },
  // stock
  { name: 'inventory-snapshot', path: '/services/rest/v1/inventory/inventorySnapshot/get', body: { itemTypeSKUs: [S.sku] }, facility: 'GGN_WAREHOUSE' },
  // vendors / customers
  { name: 'vendor-search', path: '/services/rest/v1/purchase/vendor/search', body: {} },
  { name: 'vendor-get-list', path: '/services/rest/v1/purchase/vendor/getVendors', body: {} },
  { name: 'customer-search', path: '/services/rest/v1/customer/search', body: {} },
  { name: 'customer-search-oms', path: '/services/rest/v1/oms/customer/search', body: {} },
  // purchase order + GRN at the receiving facility
  { name: 'po-get', path: '/services/rest/v1/purchase/purchaseOrder/get', body: { purchaseOrderCode: S.ipo.code }, facility: S.ipo.facility },
  { name: 'po-get-2', path: '/services/rest/v1/purchase/purchaseOrder/get', body: { purchaseOrderCode: S.ipo2.code }, facility: S.ipo2.facility },
  { name: 'po-search', path: '/services/rest/v1/purchase/purchaseOrder/getPurchaseOrders', body: { fromDate: iso(ago), toDate: iso(now) }, facility: S.ipo.facility },
  { name: 'grn-list', path: '/services/rest/v1/purchase/inflowReceipt/getInflowReceipts', body: { purchaseOrderCode: S.ipo.code }, facility: S.ipo.facility },
];

// Round 2: other spellings / parameters for the calls round 1 did not find.
const probes2: Probe[] = [
  { name: 'so-search-nodate', path: '/services/rest/v1/oms/saleOrder/search', body: { displayOrderCode: S.displayCode } },
  { name: 'so-search-channel', path: '/services/rest/v1/oms/saleOrder/search', body: { displayOrderCode: S.displayCode, channel: 'MWH_INTERNAL_TRANSFER', fromDate: iso(ago), toDate: iso(now) } },
  { name: 'so-search-updated', path: '/services/rest/v1/oms/saleOrder/search', body: { channel: 'D2C_TRANSFER_MCAFF', updatedSinceInMinutes: 1440 } },
  { name: 'inventory-snapshot-2', path: '/services/rest/v1/inventory/inventorySnapshot/get', body: { itemTypeSKUs: ['mcaf278'] }, facility: 'MUM_WAREHOUSE2' },
  { name: 'vendor-get-facility', path: '/services/rest/v1/purchase/vendor/getVendors', body: {}, facility: 'GGN_WAREHOUSE' },
  { name: 'customer-get', path: '/services/rest/v1/customer/getCustomers', body: {} },
  { name: 'customer-search-fac', path: '/services/rest/v1/oms/customer/getCustomers', body: {}, facility: 'MUM_WAREHOUSE2' },
  { name: 'po-list', path: '/services/rest/v1/purchase/purchaseOrder/getPurchaseOrders', body: {}, facility: S.ipo.facility },
  { name: 'po-details', path: '/services/rest/v1/purchase/purchaseOrder/getPurchaseOrderDetails', body: { purchaseOrderCode: S.ipo.code }, facility: S.ipo.facility },
  { name: 'po-details-2', path: '/services/rest/v1/purchase/getPurchaseOrderDetails', body: { purchaseOrderCode: S.ipo.code }, facility: S.ipo.facility },
  { name: 'grn-get', path: '/services/rest/v1/purchase/inflowReceipt/getInflowReceipt', body: { code: 'G8221' }, facility: S.ipo.facility },
  { name: 'grn-get-2', path: '/services/rest/v1/purchase/inflowReceipt/get', body: { inflowReceiptCode: 'G8221' }, facility: S.ipo.facility },
  { name: 'pkg-details', path: '/services/rest/v1/oms/shippingPackage/getShippingPackageDetails', body: { shippingPackageCode: 'MW/2627/SP50429' }, facility: 'MUM_WAREHOUSE2' },
  { name: 'invoice-details', path: '/services/rest/v1/invoice/details/get', body: { shippingPackageCode: 'MW/2627/SP50429' }, facility: 'MUM_WAREHOUSE2' },
];

const shape =(v: unknown, depth = 0): unknown => {
  if (Array.isArray(v)) return v.length ? [`${v.length} x`, shape(v[0], depth + 1)] : [];
  if (v && typeof v === 'object') {
    if (depth > 2) return '{…}';
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).slice(0, 40).map(([k, x]) => [k, shape(x, depth + 1)]));
  }
  return typeof v;
};

const main = async (): Promise<void> => {
  const out = arg('--out');
  if (!out) throw new Error('--out <dir> is required (outside the repo)');
  fs.mkdirSync(out, { recursive: true });
  const api: UniwareApi = uniwareCatalog(env.intransit.uniware);
  for (const p of arg('--round') === '2' ? probes2 : probes) {
    try {
      const body = await api.post<Record<string, unknown>>(p.path, p.body, p.facility);
      fs.writeFileSync(path.join(out, `${p.name}.json`), JSON.stringify(body, null, 2));
      console.log(`OK    ${p.name.padEnd(22)} ${JSON.stringify(shape(body)).slice(0, 600)}`);
    } catch (e) {
      const msg = (e instanceof Error ? e.message : String(e)).replace(/bearer \S+/gi, 'bearer ***').slice(0, 300);
      fs.writeFileSync(path.join(out, `${p.name}.error.txt`), msg);
      console.log(`FAIL  ${p.name.padEnd(22)} ${msg}`);
    }
  }
};

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
