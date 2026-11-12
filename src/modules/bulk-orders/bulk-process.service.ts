import { Brackets } from 'typeorm';
import { AppDataSource } from '../../config/data-source';
import {
  BULK_BODY as F,
  BULK_EVENT,
  BULK_ORDER_STATUS,
  BULK_SALE,
  BULK_DOCS,
  BulkOrderType,
  ERROR_CODES,
  errorMessage,
  PIPELINE_STEP,
  PO_ACTIVE_STATUS,
  PO_VERIFY_ACTION,
  saleOrderCode,
  SHIPMENT_LOG_ACTION,
  SHIPMENT_LOG_SOURCE,
  UNIWARE_CSV,
  UPLOAD_OCR_STATUS,
  UPLOAD_SOURCE,
  UPLOAD_STATUS,
  VALIDATION_STATUS,
} from '../../constants';
import { CACHE_NS } from '../../constants/cache';
import { LOG_SOURCE } from '../../constants/logging';
import {
  BulkCustomer, BulkOrder, BulkOrderLine, DetailsPurchaseOrder, MasterFacility, MasterPurchaseOrder, MasterSku, PoUpload, PoVerification, ShipmentLog,
} from '../../entities';
import { appError } from '../../utils/AppError';
import { log } from '../../utils/logger';
import { forgetCache } from '../cache/cache.service';
import { s3UrlOfKey, writeS3Text } from '../email-intake/s3-mirror.service';
import { cachedPepSkus } from '../masters/masters.cache';
import { flushChanges } from '../po-overview/po-overview.live';
import { csvOf, poRows, takeSerial } from '../po-pipeline/po-save.service';
import { ProcessedPo } from '../po-processing/common/processed-po';
import { bumpReview } from '../po-review/po-review.live';
import { punchCodeOf, todayIst, ValidatedLine, ValidationResult } from '../po-validation/validate-po';
import { addEvent, Checker, isId, teamBulkOrder } from './bulk-orders.service';

/*
 * Bulk Orders step 3b (2026-11-12, user; constants/bulk-orders.ts BULK_SALE): our team (PO review EDITOR) turns an
 * APPROVED order into a sale order in POST_FG.
 *   GET  process-options: active warehouses + customers saved earlier that match this order (GSTIN, or name + billing
 *        pincode) with their Uniware channel / customer code.
 *   POST process { facilityCode, uniwareChannel, customerCode }: ONE transaction (order row locked, so two clicks never
 *        make two sale orders): erp_ code (the same counter as every PO) + master / details_purchase_orders (as the
 *        chain fills them) + a po_uploads row (source bulk, completed: Processed tab, Uniware hand-off; NO Verify step,
 *        user: typed by hand, no OCR; the CSV is unlocked at once) + the
 *        customer book + order -> processing + timeline; the S3 files (order.json = the "PO file", processed.json, the
 *        Uniware CSV) are written last inside it, so a failure leaves nothing half-made.
 *   Optional "Send back" (Verify panel; po-verify sendBack -> bulkSendBack), to undo a wrong one: that sale order cancelled (Inactive, kept), the upload
 *        rejected (kept), the order approved again with the sale order cleared (kept on the timeline) to be processed again.
 * Payment is shown but NEVER blocks (user). Selling Price = the approved unit price (MRP less discount %, with GST).
 */

export interface ProcessActor { id: number; email: string }

const normName = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

const loadOrder = async (id: string): Promise<BulkOrder> => {
  const o = isId(id) ? await AppDataSource.getRepository(BulkOrder).findOneBy({ id }) : null;
  if (!o) throw appError(ERROR_CODES.BULK_ORDER_NOT_FOUND, String(id));
  return o;
};

const customerOut = (c: BulkCustomer, matchedBy: 'gstin' | 'name') => ({
  id: String(c.id), name: c.name, gstin: c.gstin,
  address: { line: c.addressLine, city: c.city, state: c.state, pincode: c.pincode },
  uniwareChannel: c.uniwareChannel, customerCode: c.customerCode, usedCount: c.usedCount, lastUsedAt: c.updatedAt, matchedBy,
});

/** Saved customers that match the order: same GSTIN first, then same name + billing pincode; most used first. 1 query. */
const matchesFor = async (o: BulkOrder) => {
  if (!o.institutionName) return [];
  const qb = AppDataSource.getRepository(BulkCustomer).createQueryBuilder('c').where(new Brackets((w) => {
    if (o.gstin) w.where('c.gstin = :gstin', { gstin: o.gstin });
    if (o.billingPincode) w.orWhere('c.pincode = :pin', { pin: o.billingPincode });
  }));
  if (!o.gstin && !o.billingPincode) return [];
  const found = await qb.orderBy('c.usedCount', 'DESC').addOrderBy('c.updatedAt', 'DESC').take(50).getMany();
  const name = normName(o.institutionName);
  const byGstin = found.filter((c) => o.gstin && c.gstin === o.gstin);
  const byName = found.filter((c) => !byGstin.includes(c) && normName(c.name) === name);
  return [...byGstin.map((c) => customerOut(c, 'gstin')), ...byName.map((c) => customerOut(c, 'name'))].slice(0, BULK_SALE.CUSTOMERS_MAX);
};

/**
 * What the Process panel needs: active warehouses + matching saved customers. Each warehouse carries parentCode = its
 * main (mother) warehouse's code, null for a main one (or a child whose main is not active): the panel lists the main
 * warehouses and folds their children under them.
 */
export const bulkProcessOptions = async (id: string) => {
  const o = await loadOrder(id);
  const facilities = await AppDataSource.getRepository(MasterFacility).find({
    select: { id: true, code: true, name: true, parentFacilityId: true }, where: { isActive: true }, order: { code: 'ASC' }, take: BULK_SALE.FACILITIES_MAX,
  });
  const codeOf = new Map(facilities.map((f) => [f.id, f.code]));
  return {
    facilities: facilities.map((f) => ({ code: f.code, name: f.name, parentCode: (f.parentFacilityId !== null && codeOf.get(f.parentFacilityId)) || null })),
    customers: await matchesFor(o),
  };
};

/** One address as a line of text. */
const addressText = (line: string | null, city: string | null, state: string | null, pin: string | null): string =>
  [line, city, state, pin].filter(Boolean).join(', ');

/** The order as the "PO file" of the sale order (order.json): what was approved, by whom, for whom. */
const orderJson = (o: BulkOrder, lines: BulkOrderLine[], code: string, f: { facilityCode: string; uniwareChannel: string; customerCode: string }) => ({
  poNumber: o.poNumber, orderId: String(o.id), type: o.orderType, saleOrderCode: code,
  institution: { name: o.institutionName, gstin: o.gstin, email: o.contactEmail, billingAddress: addressText(o.billingAddressLine, o.billingCity, o.billingState, o.billingPincode) },
  orderedBy: o.orderedBy, receiver: { name: o.receiverName, phone: o.receiverPhone },
  deliveryAddress: addressText(o.addressLine, o.city, o.state, o.pincode), neededBy: o.neededBy, priority: o.priority, note: o.note,
  approved: { at: o.decidedAt, note: o.decisionNote }, payment: o.paymentStatus,
  uniware: f,
  lines: lines.map((l) => ({ lineNo: l.lineNo, pepCode: l.pepCode, name: l.productName, mrp: l.mrp, discountPct: l.discountPct, unitPrice: l.unitPrice, qty: l.qty, lineTotal: l.lineTotal })),
  totals: { lines: o.lineCount, units: o.totalUnits, mrp: o.totalMrp, value: o.totalValue },
});

/** processed.json in the common format, so the Verify panel / file viewer read it like any PO (price = landing_rate with GST). */
const processedJson = (o: BulkOrder, lines: BulkOrderLine[], orderUrl: string, poDate: string, now: Date): ProcessedPo => ({
  'subject line if email': '',
  channel_name: BULK_SALE.CHANNEL_NAME[o.orderType as BulkOrderType],
  input_type: 'bulk_order',
  ref_file_urls: [orderUrl],
  po_number: o.poNumber,
  po_date: poDate,
  type_delivery_facility: '',
  delivery_facility_code: o.institutionName ?? o.receiverName,
  'shipping address': addressText(o.addressLine, o.city, o.state, o.pincode),
  delivery_pincode: o.pincode,
  total_line_items: lines.length,
  total_qty: lines.reduce((s, l) => s + l.qty, 0),
  po_value: o.totalValue,
  expected_date: o.neededBy,
  appointment_date: '',
  expiry_date: '',
  delivery_gstin: o.gstin ?? '',
  vendor_gstin: '',
  cart_discount: 0,
  net_amount: o.totalValue,
  po_type: o.orderType,
  revised: false,
  revision_of: '',
  line_items: lines.map((l) => ({
    line_no: l.lineNo, pep_sku_code: l.pepCode, listing_sku_code: '', channel_sku_code: l.pepCode, ean: '', description: l.productName ?? '',
    qty: l.qty, free_qty: '', pep_mrp: l.mrp, channel_mrp: l.mrp, landing_rate: l.unitPrice, unit_cost: '', line_total: l.lineTotal,
    margin: '', hsn: '', gst: '', unmapped: { discount_pct: String(l.discountPct) },
  })),
  unmapped: { bulk_order_id: String(o.id), receiver: `${o.receiverName} ${o.receiverPhone}`, billing_address: addressText(o.billingAddressLine, o.billingCity, o.billingState, o.billingPincode) },
  field_sources: {},
  cross_checks: [],
  warnings: [],
  processed_at: now.toISOString(),
});

/** The approved lines as a validated PO (so poRows / csvOf build the rows and CSV exactly as for every channel). */
const asValidated = (
  o: BulkOrder, lines: BulkOrderLine[], skus: Map<string, MasterSku>, f: { facilityCode: string; facilityId: number; uniwareChannel: string; customerCode: string },
): ValidationResult => ({
  channel: BULK_SALE.CHANNEL_NAME[o.orderType as BulkOrderType] as ValidationResult['channel'],
  channelDisplayName: BULK_SALE.CHANNEL[o.orderType as BulkOrderType],
  poNumber: o.poNumber,
  status: VALIDATION_STATUS.VALID,
  issues: [],
  location: { locationId: '', locationCode: '', customerCode: f.customerCode, facilityCode: f.facilityCode, facilityId: f.facilityId, uniwareChannel: f.uniwareChannel, matchedBy: 'reviewer' },
  lines: lines.map((l): ValidatedLine => {
    const sku = skus.get(l.pepCode.toUpperCase());
    return {
      lineNo: l.lineNo, channelSkuCode: l.pepCode, pepCode: l.pepCode, punchCode: punchCodeOf(l.pepCode, sku, skus), skuName: l.productName ?? '',
      brandName: sku?.brandName ?? '', qty: l.qty, chargedQty: l.qty, ourMrp: l.mrp, poMrp: l.mrp, ourRate: l.unitPrice, masterRate: l.unitPrice,
      masterMrp: l.mrp, priceFrom: '', mrpFrom: '', channelSkuId: '', poUnitPrice: l.unitPrice, poLineValue: l.lineTotal,
    };
  }),
  totals: { poValue: o.totalValue, ourValue: o.totalValue, difference: 0 },
  validatedAt: new Date().toISOString(),
});

/**
 * Creates the sale order of an approved order (PO review EDITOR; route checks). 400 every wrong field / unknown warehouse,
 * 409 not approved (also a second click) / type not processable yet.
 */
export const processBulkOrder = async (actor: ProcessActor, id: string, body: Record<string, unknown>) => {
  const c = new Checker();
  const facilityCode = c.text(body[F.FACILITY], F.FACILITY, BULK_SALE.CODE_MAX);
  const uniwareChannel = c.text(body[F.UNIWARE_CHANNEL], F.UNIWARE_CHANNEL, BULK_SALE.CODE_MAX);
  const customerCode = c.text(body[F.CUSTOMER_CODE], F.CUSTOMER_CODE, BULK_SALE.CODE_MAX);
  c.fail();
  const first = await loadOrder(id);
  if (!BULK_SALE.TYPES.includes(first.orderType as BulkOrderType)) throw appError(ERROR_CODES.BULK_PROCESS_TYPE_LATER, first.orderType);
  if (first.status !== BULK_ORDER_STATUS.APPROVED) throw appError(ERROR_CODES.BULK_ORDER_NOT_APPROVED, first.poNumber, first.status);
  // the warehouse exactly as the facility master spells it (case matters: main vs child warehouse)
  const facility = await AppDataSource.getRepository(MasterFacility).findOne({ select: { id: true, code: true, isActive: true }, where: { code: facilityCode } });
  if (!facility || !facility.isActive) {
    c.add(F.FACILITY, `${facilityCode} is not an active warehouse in the facility master`);
    c.fail();
  }
  const lines = await AppDataSource.getRepository(BulkOrderLine).find({ where: { orderId: String(first.id) }, order: { lineNo: 'ASC' } });
  const skus = new Map((await cachedPepSkus()).map((s) => [s.pepCode.toUpperCase(), s]));

  const now = new Date();
  const today = todayIst(now);
  let code = '';
  await AppDataSource.transaction(async (m) => {
    const o = await m.getRepository(BulkOrder).findOne({ where: { id: String(first.id) }, lock: { mode: 'pessimistic_write' } });
    if (!o || o.status !== BULK_ORDER_STATUS.APPROVED) throw appError(ERROR_CODES.BULK_ORDER_NOT_APPROVED, first.poNumber, o?.status ?? 'gone');
    const n = o.saleOrderCount + 1;
    // The saved PO's number: the order's own, then INST-2026-0001-2 ... after a send back (the cancelled one is kept,
    // and channel + PO number is unique on master_purchase_orders).
    const soPo = BULK_SALE.SALE_PO(o.poNumber, n);
    const sale: BulkOrder = { ...o, poNumber: soPo };
    const folder = `${BULK_DOCS.S3_FOLDER}/${o.poNumber}/${BULK_SALE.S3_SUB(n)}`;
    const orderUrl = s3UrlOfKey(`${folder}/${BULK_SALE.ORDER_FILE}`);
    const processedUrl = s3UrlOfKey(`${folder}/processed.json`);
    const csvUrl = s3UrlOfKey(`${folder}/${UNIWARE_CSV.FILE_NAME(soPo, today)}`);
    const poDate = todayIst(o.createdAt);
    const f = { facilityCode: facility!.code, facilityId: facility!.id, uniwareChannel, customerCode };

    code = saleOrderCode(today, await takeSerial(m, today));
    const v = asValidated(sale, lines, skus, f);
    const rows = poRows(v, { today, now, poDate, expiryDate: null, document: processedUrl });
    const masterRepo = m.getRepository(MasterPurchaseOrder);
    // no channel location (bulk orders have their own address): location / locationId stay empty
    const master = await masterRepo.save(masterRepo.create({ ...rows.master, location: null, locationId: null, orderNo1: code }));
    const poUid = String(master.uid);
    const details = m.getRepository(DetailsPurchaseOrder);
    await details.save(rows.details.map((d) => details.create({ ...d, shipmentOrderId: master.uid })));
    await m.getRepository(ShipmentLog).insert({ shipmentUid: poUid, userId: actor.id, action: SHIPMENT_LOG_ACTION.CREATED, source: SHIPMENT_LOG_SOURCE.REVIEW, remark: code });

    // customer book: the same GSTIN, else the same name + billing pincode -> updated; else a new row
    const customers = m.getRepository(BulkCustomer);
    const name = o.institutionName ?? o.receiverName;
    const pin = o.billingPincode ?? o.pincode;
    const same = (o.gstin ? await customers.findOne({ where: { gstin: o.gstin }, order: { usedCount: 'DESC' } }) : null)
      ?? (await customers.find({ where: { pincode: pin } })).find((x) => normName(x.name) === normName(name)) ?? null;
    const cust = {
      name, gstin: o.gstin, addressLine: o.billingAddressLine ?? o.addressLine, city: o.billingCity ?? o.city, state: o.billingState ?? o.state, pincode: pin,
      phone: o.receiverPhone, email: o.contactEmail, uniwareChannel, customerCode, lastOrderId: String(o.id), updatedBy: actor.id, updatedAt: now,
    };
    let customerId: string;
    if (same) {
      await customers.update({ id: same.id }, { ...cust, usedCount: same.usedCount + 1 });
      customerId = String(same.id);
    } else {
      const res = await customers.insert({ ...cust, usedCount: 1, createdBy: actor.id });
      customerId = String(res.identifiers[0].id);
    }

    const ups = m.getRepository(PoUpload);
    const up = await ups.insert({
      source: UPLOAD_SOURCE.BULK, channel: v.channelDisplayName, fileName: BULK_SALE.ORDER_FILE, fileUrl: orderUrl, fileType: 'json',
      emailSubject: `${name} · ${o.receiverName}`.slice(0, 500), emailReceivedAt: o.createdAt,
      sourceSystem: BULK_SALE.SOURCE_SYSTEM, externalId: soPo, uploadedBy: actor.email,
      ocrStatus: UPLOAD_OCR_STATUS.SUCCESS, ocrResult: { processed_json: processedUrl, lines: lines.length }, ocrAttempts: 0,
      poNumber: soPo, poUid, uniwareCsvUrl: csvUrl, poDate, status: UPLOAD_STATUS.COMPLETED, completedAt: now,
    });
    const uploadId = String(up.identifiers[0].id);

    await m.getRepository(BulkOrder).update({ id: String(o.id) }, {
      status: BULK_ORDER_STATUS.PROCESSING, facilityCode: f.facilityCode, uniwareChannel, customerCode, customerId,
      processedBy: actor.id, processedAt: now, uploadId, poUid, saleOrderCode: code, saleOrderCount: n, updatedAt: now,
    });
    await addEvent(m, String(o.id), BULK_EVENT.PROCESSED, actor.id, null, { saleOrderCode: code, facilityCode: f.facilityCode, uniwareChannel, customerCode, uploadId });

    // S3 last: a failure here rolls the rows back (an unused file may stay, never a half-made sale order)
    await writeS3Text(orderUrl, `${JSON.stringify(orderJson(sale, lines, code, f), null, 2)}\n`);
    await writeS3Text(processedUrl, `${JSON.stringify(processedJson(sale, lines, orderUrl, poDate, now), null, 2)}\n`);
    await writeS3Text(csvUrl, csvOf(v, poDate, code));
  });
  log.info(LOG_SOURCE.API, `[bulk-orders] ${first.poNumber} processed by user ${actor.id}: sale order ${code}`);
  void forgetCache(CACHE_NS.PO_OVERVIEW_FILTERS);
  void flushChanges();
  bumpReview();
  return teamBulkOrder(id);
};

/** A sale order made from a bulk order (its po_uploads row). */
export const isBulkUpload = (u: Pick<PoUpload, 'source'>): boolean => u.source === UPLOAD_SOURCE.BULK;

/** The Verify switch: always OFF for bulk orders (user 2026-11-12: "everything is manual, no OCR": no Verify step). */
export const isBulkChannel = (channel: string | null): boolean =>
  channel !== null && Object.values(BULK_SALE.CHANNEL).some((c) => c.toLowerCase() === channel.trim().toLowerCase());

/**
 * Verify "Send back" of a bulk order's sale order: the saved PO Inactive (kept) + po_verifications sent_back, the upload
 * rejected (kept, cannot be reopened: BULK_UPLOAD_NOT_REOPENABLE), the order approved again (sale order fields cleared,
 * kept on the timeline) for our team to process again. 409 when already in Uniware (undo the mark first).
 */
export const bulkSendBack = async (uploadId: string, remark: string, by: ProcessActor): Promise<{ status: string; issues: number }> => {
  await AppDataSource.transaction(async (m) => {
    const u = await m.getRepository(PoUpload).findOne({ where: { id: uploadId }, lock: { mode: 'pessimistic_write' } });
    if (!u) throw appError(ERROR_CODES.UPLOAD_NOT_FOUND, uploadId);
    if (u.status !== UPLOAD_STATUS.COMPLETED || !u.poUid) throw appError(ERROR_CODES.VERIFY_NOT_READY, uploadId, u.status);
    if (u.uniwareUploadedAt) throw appError(ERROR_CODES.ALREADY_IN_UNIWARE, uploadId);
    const orders = m.getRepository(MasterPurchaseOrder);
    const so = (await orders.findOne({ select: ['orderNo1'], where: { uid: u.poUid } }))?.orderNo1 ?? null;
    await orders.update({ uid: u.poUid }, { statusActive: PO_ACTIVE_STATUS.INACTIVE });
    await m.getRepository(PoVerification).insert({
      uploadId: u.id, poUid: u.poUid, saleOrderCode: so, action: PO_VERIFY_ACTION.SENT_BACK, remark, doneBy: by.id, doneAt: new Date(),
    });
    await m.getRepository(PoUpload).update({ id: u.id }, {
      status: UPLOAD_STATUS.REJECTED, errorDetails: { step: PIPELINE_STEP.SAVE_PO, message: errorMessage(ERROR_CODES.BULK_UPLOAD_NOT_REOPENABLE, u.poNumber ?? ''), remark },
    });
    const o = await m.getRepository(BulkOrder).findOne({ where: { uploadId: String(u.id) }, lock: { mode: 'pessimistic_write' } });
    if (o) {
      await m.getRepository(BulkOrder).update({ id: String(o.id) }, {
        status: BULK_ORDER_STATUS.APPROVED, facilityCode: null, uniwareChannel: null, customerCode: null, customerId: null,
        processedBy: null, processedAt: null, uploadId: null, poUid: null, saleOrderCode: null, updatedAt: new Date(),
      });
      await addEvent(m, String(o.id), BULK_EVENT.SENT_BACK, by.id, remark, { saleOrderCode: so, uploadId: String(u.id) });
    }
  });
  log.info(LOG_SOURCE.API, `[bulk-orders] upload ${uploadId} sent back by user ${by.id}: order approved again`);
  void flushChanges();
  bumpReview();
  return { status: UPLOAD_STATUS.REJECTED, issues: 0 };
};
