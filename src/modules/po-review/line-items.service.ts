import { In } from 'typeorm';
import { AppDataSource } from '../../config/data-source';
import { ERROR_CODES, LINE_ITEMS, PO_VERIFY_STATE, UPLOAD_STATUS } from '../../constants';
import { DetailsPurchaseOrder, MasterPurchaseOrder, PoUpload } from '../../entities';
import { appError } from '../../utils/AppError';
import { readS3Json } from '../email-intake/s3-mirror.service';
import { verifyStates } from '../po-verify/po-verify.service';
import { Num, ProcessedLine, ProcessedPo } from '../po-processing/common/processed-po';

/*
 * Line items download (user, 2026-10-26): every line of the ticked processed POs, one row per line, for the screen to
 * save as CSV or Excel. Reads only (nothing is marked, the Uniware hand-off is untouched).
 *   DB: details_purchase_orders (what was saved: our SKU, qty, GMV, PO value) + the PO header + its verification.
 *   S3: the JSON the PO was saved from (master.document: corrected.json after a review, else processed.json) for what
 *       the DB does not keep (EAN, channel MRP, landing rate, unit cost, HSN, GST, free qty...). Joined on position:
 *       srNo N = line_items[N - 1] (po-save poRows numbers the validated lines, one per PO line, in order).
 * A PO whose JSON cannot be read still gives its DB lines (S3 columns empty, s3Missing = true), so one bad file never
 * blocks the download.
 */

export interface LineItemRow {
  uploadId: string;
  poNumber: string | null;
  poDate: string | null;
  channel: string | null;
  location: string | null;
  facility: string | null;
  saleOrderCode: string | null;
  processedAt: string | null;
  srNo: string | null;
  lineNo: Num | null;
  pepSkuCode: string | null;
  channelSkuCode: string | null;
  ean: string | null;
  skuName: string | null;
  description: string | null;
  brand: string | null;
  hsn: string | null;
  qty: number | null;
  freeQty: Num | null;
  channelMrp: Num | null;
  /** Our MRP and rate as saved: GMV / qty and PO value / charged qty. */
  ourMrp: number | null;
  ourRate: number | null;
  landingRate: Num | null;
  unitCost: Num | null;
  gstPercent: Num | null;
  lineTotal: Num | null;
  margin: Num | null;
  gmv: number | null;
  poValue: number | null;
  /** True only when the PO was verified (Verify & approve); false otherwise (user, 2026-10-26: just True / False). */
  isVerified: boolean;
  s3Missing: boolean;
}

const round2 = (x: number) => Math.round(x * 100) / 100;
const per = (total: number | null, units: number): number | null => (total === null || !units ? null : round2(total / units));
const numOrNull = (v: Num | undefined): number => (typeof v === 'number' ? v : Number(v) || 0);

/** Runs fn over items, at most `limit` at a time, results in the same order. */
const inBatches = async <T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> => {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
};

const readPo = async (url: string | null): Promise<ProcessedPo | undefined> => {
  if (!url) return undefined;
  try {
    return await readS3Json<ProcessedPo>(url);
  } catch {
    return undefined;
  }
};

/** The line rows of the given processed POs, in the order asked, each PO's lines by srNo. */
export const lineItems = async (ids: string[]): Promise<LineItemRow[]> => {
  if (!ids.length) throw appError(ERROR_CODES.UPLOAD_IDS_REQUIRED);
  if (ids.length > LINE_ITEMS.MAX_IDS) throw appError(ERROR_CODES.LINE_ITEMS_TOO_MANY, LINE_ITEMS.MAX_IDS);

  const uploads = await AppDataSource.getRepository(PoUpload).findBy({ id: In(ids) });
  const ok = uploads.filter((u) => u.status === UPLOAD_STATUS.COMPLETED && u.poUid);
  const bad = ids.filter((id) => !ok.some((u) => String(u.id) === id));
  if (bad.length) throw appError(ERROR_CODES.LINE_ITEMS_NOT_PROCESSED, bad.join(', '));

  const poUids = ok.map((u) => u.poUid!);
  const [masters, details] = await Promise.all([
    AppDataSource.getRepository(MasterPurchaseOrder).findBy({ uid: In(poUids) }),
    AppDataSource.getRepository(DetailsPurchaseOrder).findBy({ shipmentOrderId: In(poUids) }),
  ]);
  const masterOf = new Map(masters.map((m) => [String(m.uid), m]));
  const linesOf = new Map<string, DetailsPurchaseOrder[]>();
  for (const d of details) linesOf.set(String(d.shipmentOrderId), [...(linesOf.get(String(d.shipmentOrderId)) ?? []), d]);

  const ordered = ids.map((id) => ok.find((u) => String(u.id) === id)!);
  const verify = new Map((await verifyStates(ids)).items.map((v) => [v.uploadId, v.state === PO_VERIFY_STATE.VERIFIED]));
  // The PO's own JSON from S3, a few at a time (the slow part).
  const files = await inBatches(ordered, LINE_ITEMS.S3_PARALLEL, (u) => {
    const m = masterOf.get(String(u.poUid));
    const processed = u.ocrResult?.processed_json;
    return readPo(m?.document ?? (typeof processed === 'string' ? processed : null));
  });

  return ordered.flatMap((u, i) => {
    const m = masterOf.get(String(u.poUid));
    const po = files[i];
    const lines = (linesOf.get(String(u.poUid)) ?? []).sort((a, b) => Number(a.srNo) - Number(b.srNo));
    return lines.map((d): LineItemRow => {
      const l: ProcessedLine | undefined = po?.line_items?.[Number(d.srNo) - 1];
      const qty = d.qty ?? 0;
      return {
        uploadId: String(u.id),
        poNumber: m?.poNumber ?? u.poNumber,
        poDate: m?.poDate ?? null,
        channel: m?.channel ?? u.channel,
        location: m?.location ?? null,
        facility: m?.facility ?? null,
        saleOrderCode: m?.orderNo1 ?? null,
        processedAt: u.completedAt ? u.completedAt.toISOString() : null,
        srNo: d.srNo,
        lineNo: l?.line_no ?? null,
        pepSkuCode: d.skuCode,
        channelSkuCode: d.channelSkuCode ?? l?.channel_sku_code ?? null,
        ean: l?.ean ?? null,
        skuName: d.skuName,
        description: l?.description ?? null,
        brand: d.brandName,
        hsn: l?.hsn ?? null,
        qty: d.qty,
        freeQty: l?.free_qty ?? null,
        channelMrp: l?.channel_mrp ?? null,
        ourMrp: per(d.gmv, qty),
        ourRate: per(d.poValue, qty - numOrNull(l?.free_qty)),
        landingRate: l?.landing_rate ?? null,
        unitCost: l?.unit_cost ?? null,
        gstPercent: l?.gst ?? null,
        lineTotal: l?.line_total ?? null,
        margin: l?.margin ?? null,
        gmv: d.gmv,
        poValue: d.poValue,
        isVerified: verify.get(String(u.id)) ?? false,
        s3Missing: !po,
      };
    });
  });
};
