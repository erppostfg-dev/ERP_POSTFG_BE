import { In, Not } from 'typeorm';
import { AppDataSource } from '../../config/data-source';
import { ACCESS_LEVEL, AccessLevel, BULK_BODY as F, BULK_INSTITUTION, BULK_ORDER_TYPE, BULK_ORDERS, BULK_PAGE, CAPABILITY, ERROR_CODES, errorMessage } from '../../constants';
import { LOG_SOURCE } from '../../constants/logging';
import { BulkInstitutionCustomer, BulkInstitutionCustomerAddress } from '../../entities';
import { appError } from '../../utils/AppError';
import { log } from '../../utils/logger';
import { accessFrom, allows, hasCapability, loadAccess } from '../auth/access.service';
import { BulkActor, Checker, checkAddress, isId, normalPhone, userNames } from './bulk-orders.service';

/*
 * Bulk Orders Portal v2 piece 5a (2026-11-24, user "GO"; PRD "Customers page"): the customers Institutional orders are
 * placed for. For now our Institutional team keeps the list (user: outside buyers sign in later); every person with the
 * Institutional page sees it, editors add / change. A customer = company, GSTIN (unverified until finance verifies it:
 * piece 5b; a GSTIN change clears the verification), billing address, contact, default discount %, shipping addresses.
 * Never deleted: switched off (active false), also its addresses. One customer per GSTIN; company names not twice.
 * An Institutional order with customerId takes the company / GSTIN / email / billing from here (bulk-orders.service).
 * DB load: list = 2 queries (+ names); a change = a few single-row reads + writes.
 */

const needInstitutional = async (actor: BulkActor, level: AccessLevel): Promise<void> => {
  const rows = await loadAccess(actor.id, actor.roles);
  if (!allows(accessFrom(rows, BULK_PAGE.INSTITUTIONAL), level)) {
    throw appError(ERROR_CODES.BULK_TYPE_NOT_ALLOWED, BULK_ORDER_TYPE.INSTITUTIONAL, level === ACCESS_LEVEL.EDITOR ? 'manage the customers of' : 'see the customers of');
  }
};

const addressOut = (a: BulkInstitutionCustomerAddress) => ({
  id: String(a.id), label: a.label, address: { line: a.addressLine, city: a.city, state: a.state, pincode: a.pincode }, active: a.isActive,
});

const customerOut = (c: BulkInstitutionCustomer, addresses: BulkInstitutionCustomerAddress[], names: Map<number, string>) => ({
  id: String(c.id), companyName: c.companyName, gstin: c.gstin,
  /** null = not verified (yet, or since the GSTIN changed). */
  gstinVerified: c.gstinVerifiedAt ? { by: { id: c.gstinVerifiedBy, name: c.gstinVerifiedBy ? names.get(c.gstinVerifiedBy) ?? null : null }, at: c.gstinVerifiedAt } : null,
  billingAddress: { line: c.billingAddressLine, city: c.billingCity, state: c.billingState, pincode: c.billingPincode },
  contactName: c.contactName, contactPhone: c.contactPhone, contactEmail: c.contactEmail, defaultDiscountPct: c.defaultDiscountPct,
  active: c.isActive,
  addresses: addresses.filter((a) => String(a.customerId) === String(c.id)).map(addressOut),
  createdBy: { id: c.createdBy, name: names.get(c.createdBy) ?? null }, createdAt: c.createdAt, updatedAt: c.updatedAt,
});

interface CustomerIn {
  companyName: string; gstin: string | null; billing: { line: string; city: string; state: string; pincode: string };
  contactName: string; contactPhone: string; contactEmail: string | null; defaultDiscountPct: number; active: boolean | undefined;
}

/** A customer body (create / change: every field; `active` only on a change). 400 with every wrong field. */
const parseCustomer = (c: Checker, body: Record<string, unknown>): CustomerIn => {
  const companyName = c.text(body[F.COMPANY_NAME], F.COMPANY_NAME, BULK_INSTITUTION.NAME_MAX);
  const gstin = c.text(body[F.GSTIN], F.GSTIN, 20, false).toUpperCase().replace(/\s/g, '') || null;
  if (gstin && !BULK_INSTITUTION.GSTIN_RE.test(gstin)) c.add(F.GSTIN, errorMessage(ERROR_CODES.FIELD_BAD_FORMAT, F.GSTIN, 'a 15-character GSTIN (e.g. 27AAAAA0000A1Z5)'));
  const billing = checkAddress(c, body[F.BILLING], F.BILLING);
  const contactName = c.text(body[F.CONTACT_NAME], F.CONTACT_NAME, BULK_ORDERS.NAME_MAX);
  const phoneText = c.text(body[F.CONTACT_PHONE], F.CONTACT_PHONE, 20);
  const contactPhone = phoneText ? normalPhone(phoneText) : null;
  if (phoneText && !contactPhone) c.add(F.CONTACT_PHONE, errorMessage(ERROR_CODES.FIELD_BAD_FORMAT, F.CONTACT_PHONE, 'a 10-digit phone number'));
  const contactEmail = c.text(body[F.EMAIL], F.EMAIL, BULK_INSTITUTION.EMAIL_MAX, false) || null;
  if (contactEmail && !BULK_INSTITUTION.EMAIL_RE.test(contactEmail)) c.add(F.EMAIL, errorMessage(ERROR_CODES.FIELD_BAD_FORMAT, F.EMAIL, 'an email address'));
  const d = body[F.DEFAULT_DISCOUNT] ?? 0;
  if (!(typeof d === 'number' && Number.isFinite(d) && d >= 0 && d < BULK_ORDERS.DISCOUNT_MAX && Math.round(d * 100) / 100 === d)) {
    c.add(F.DEFAULT_DISCOUNT, errorMessage(ERROR_CODES.FIELD_BAD_FORMAT, F.DEFAULT_DISCOUNT, `a % from 0 to below ${BULK_ORDERS.DISCOUNT_MAX} with at most 2 decimals`));
  }
  const a = body[F.ACTIVE];
  if (a !== undefined && typeof a !== 'boolean') c.add(F.ACTIVE, errorMessage(ERROR_CODES.FIELD_BAD_FORMAT, F.ACTIVE, 'true or false'));
  return { companyName, gstin, billing, contactName, contactPhone: contactPhone ?? '', contactEmail, defaultDiscountPct: d as number, active: a as boolean | undefined };
};

/** A shipping address body under `pre` ({ label, address }). */
const parseAddress = (c: Checker, raw: unknown, pre = '') => {
  const b = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return { label: c.text(b[F.LABEL], `${pre}${F.LABEL}`, BULK_ORDERS.LABEL_MAX), address: checkAddress(c, b[F.ADDRESS], `${pre}${F.ADDRESS}`) };
};

/** 409 when another customer has the GSTIN, or the company name (case ignored, active ones). */
const noTwin = async (x: CustomerIn, selfId: string | null): Promise<void> => {
  const repo = AppDataSource.getRepository(BulkInstitutionCustomer);
  const notSelf = selfId ? { id: Not(selfId) } : {};
  if (x.gstin && (await repo.count({ where: { gstin: x.gstin, ...notSelf } }))) throw appError(ERROR_CODES.BULK_INST_CUSTOMER_EXISTS, `GSTIN (${x.gstin})`);
  const sameName = await repo.createQueryBuilder('c').where('LOWER(c.companyName) = LOWER(:n) AND c.isActive = 1', { n: x.companyName })
    .andWhere(selfId ? 'c.id <> :self' : '1 = 1', { self: selfId }).getCount();
  if (sameName) throw appError(ERROR_CODES.BULK_INST_CUSTOMER_EXISTS, `company name (${x.companyName})`);
};

const loadCustomer = async (id: string): Promise<BulkInstitutionCustomer> => {
  const c = isId(id) ? await AppDataSource.getRepository(BulkInstitutionCustomer).findOneBy({ id }) : null;
  if (!c) throw appError(ERROR_CODES.BULK_INST_CUSTOMER_NOT_FOUND, String(id));
  return c;
};

/** One customer as the API shows it (2-3 queries). */
const oneOut = async (id: string) => {
  const c = await loadCustomer(id);
  const addresses = await AppDataSource.getRepository(BulkInstitutionCustomerAddress).find({ where: { customerId: id }, order: { id: 'ASC' } });
  return customerOut(c, addresses, await userNames([c.createdBy, c.gstinVerifiedBy ?? 0]));
};

/** Every customer (company A-Z) with its addresses: viewer on the Institutional page. */
export const listInstitutionCustomers = async (actor: BulkActor) => {
  await needInstitutional(actor, ACCESS_LEVEL.VIEWER);
  const all = await AppDataSource.getRepository(BulkInstitutionCustomer).find({ order: { companyName: 'ASC' }, take: BULK_ORDERS.CUSTOMERS_LIST_MAX });
  const addresses = all.length ? await AppDataSource.getRepository(BulkInstitutionCustomerAddress).find({ where: { customerId: In(all.map((c) => String(c.id))) }, order: { id: 'ASC' } }) : [];
  const names = await userNames(all.flatMap((c) => [c.createdBy, c.gstinVerifiedBy ?? 0]));
  return all.map((c) => customerOut(c, addresses, names));
};

/** A new customer (+ optional shipping addresses): editor on the Institutional page. */
export const addInstitutionCustomer = async (actor: BulkActor, body: Record<string, unknown>) => {
  await needInstitutional(actor, ACCESS_LEVEL.EDITOR);
  const c = new Checker();
  const x = parseCustomer(c, body);
  const raw = body[F.ADDRESSES] ?? [];
  if (!Array.isArray(raw) || raw.length > BULK_ORDERS.CUSTOMER_ADDRESSES_MAX) c.add(F.ADDRESSES, errorMessage(ERROR_CODES.FIELD_BAD_FORMAT, F.ADDRESSES, `a list of at most ${BULK_ORDERS.CUSTOMER_ADDRESSES_MAX} { label, address }`));
  const addresses = Array.isArray(raw) ? raw.map((a, i) => parseAddress(c, a, `${F.ADDRESSES}[${i}].`)) : [];
  c.fail();
  await noTwin(x, null);
  const id = await AppDataSource.transaction(async (m) => {
    const res = await m.getRepository(BulkInstitutionCustomer).insert({
      companyName: x.companyName, gstin: x.gstin, billingAddressLine: x.billing.line, billingCity: x.billing.city, billingState: x.billing.state, billingPincode: x.billing.pincode,
      contactName: x.contactName, contactPhone: x.contactPhone, contactEmail: x.contactEmail, defaultDiscountPct: x.defaultDiscountPct, createdBy: actor.id,
    });
    const customerId = String(res.identifiers[0].id);
    if (addresses.length) {
      await m.getRepository(BulkInstitutionCustomerAddress).insert(addresses.map((a) => ({
        customerId, label: a.label, addressLine: a.address.line, city: a.address.city, state: a.address.state, pincode: a.address.pincode, createdBy: actor.id,
      })));
    }
    return customerId;
  });
  log.info(LOG_SOURCE.API, `[bulk-orders] Institutional customer ${id} "${x.companyName}" added by user ${actor.id}`);
  return oneOut(id);
};

/** A change (every field again; `active` to switch it off / on). A new GSTIN = not verified any more. */
export const updateInstitutionCustomer = async (actor: BulkActor, id: string, body: Record<string, unknown>) => {
  await needInstitutional(actor, ACCESS_LEVEL.EDITOR);
  const cur = await loadCustomer(id);
  const c = new Checker();
  const x = parseCustomer(c, body);
  c.fail();
  await noTwin(x, String(cur.id));
  const gstinChanged = (cur.gstin ?? null) !== x.gstin;
  await AppDataSource.getRepository(BulkInstitutionCustomer).update({ id: String(cur.id) }, {
    companyName: x.companyName, gstin: x.gstin, billingAddressLine: x.billing.line, billingCity: x.billing.city, billingState: x.billing.state, billingPincode: x.billing.pincode,
    contactName: x.contactName, contactPhone: x.contactPhone, contactEmail: x.contactEmail, defaultDiscountPct: x.defaultDiscountPct,
    ...(x.active !== undefined ? { isActive: x.active } : {}),
    ...(gstinChanged ? { gstinVerifiedAt: null, gstinVerifiedBy: null } : {}),
    updatedBy: actor.id, updatedAt: new Date(),
  });
  log.info(LOG_SOURCE.API, `[bulk-orders] Institutional customer ${id} changed by user ${actor.id}${gstinChanged ? ' (GSTIN changed: not verified)' : ''}`);
  return oneOut(String(cur.id));
};

/** A new shipping address of a customer. */
export const addInstitutionCustomerAddress = async (actor: BulkActor, id: string, body: Record<string, unknown>) => {
  await needInstitutional(actor, ACCESS_LEVEL.EDITOR);
  const cur = await loadCustomer(id);
  const c = new Checker();
  const a = parseAddress(c, body);
  c.fail();
  const repo = AppDataSource.getRepository(BulkInstitutionCustomerAddress);
  if ((await repo.count({ where: { customerId: String(cur.id), isActive: true } })) >= BULK_ORDERS.CUSTOMER_ADDRESSES_MAX) {
    c.add(F.ADDRESSES, errorMessage(ERROR_CODES.FIELD_BAD_FORMAT, F.ADDRESSES, `at most ${BULK_ORDERS.CUSTOMER_ADDRESSES_MAX} active addresses: switch one off first`));
    c.fail();
  }
  await repo.insert({ customerId: String(cur.id), label: a.label, addressLine: a.address.line, city: a.address.city, state: a.address.state, pincode: a.address.pincode, createdBy: actor.id });
  return oneOut(String(cur.id));
};

/** A shipping address changed ({ label, address }) and / or switched off / on ({ active }). */
export const updateInstitutionCustomerAddress = async (actor: BulkActor, id: string, addressId: string, body: Record<string, unknown>) => {
  await needInstitutional(actor, ACCESS_LEVEL.EDITOR);
  const cur = await loadCustomer(id);
  const repo = AppDataSource.getRepository(BulkInstitutionCustomerAddress);
  const a = isId(addressId) ? await repo.findOneBy({ id: addressId, customerId: String(cur.id) }) : null;
  if (!a) throw appError(ERROR_CODES.BULK_INST_CUSTOMER_NOT_FOUND, `${id} address ${addressId}`);
  const c = new Checker();
  const has = (k: string) => Object.prototype.hasOwnProperty.call(body, k);
  const next = has(F.LABEL) || has(F.ADDRESS) ? parseAddress(c, body) : null;
  const act = body[F.ACTIVE];
  if (act !== undefined && typeof act !== 'boolean') c.add(F.ACTIVE, errorMessage(ERROR_CODES.FIELD_BAD_FORMAT, F.ACTIVE, 'true or false'));
  if (!next && act === undefined) c.add(F.ACTIVE, errorMessage(ERROR_CODES.FIELD_BAD_FORMAT, F.ACTIVE, `${F.LABEL} + ${F.ADDRESS} and / or ${F.ACTIVE}`));
  c.fail();
  await repo.update({ id: String(a.id) }, {
    ...(next ? { label: next.label, addressLine: next.address.line, city: next.address.city, state: next.address.state, pincode: next.address.pincode } : {}),
    ...(typeof act === 'boolean' ? { isActive: act } : {}),
  });
  return oneOut(String(cur.id));
};

/**
 * v2 piece 5b: finance verifies a customer's GSTIN ({ verified: true }) or takes it back ({ verified: false }): the
 * special permission "Bulk Orders: verify payments" (bulk-finance, admin / developer). 409 when it has no GSTIN.
 */
export const verifyInstitutionCustomerGstin = async (actor: BulkActor, id: string, body: Record<string, unknown>) => {
  if (!(await hasCapability(actor.id, actor.roles, CAPABILITY.BULK_PAYMENT_VERIFY))) throw appError(ERROR_CODES.BULK_NOT_PAYMENT_VERIFIER);
  const cur = await loadCustomer(id);
  const c = new Checker();
  const v = body[F.VERIFIED];
  if (typeof v !== 'boolean') c.add(F.VERIFIED, errorMessage(ERROR_CODES.FIELD_BAD_FORMAT, F.VERIFIED, 'true or false'));
  c.fail();
  if (!cur.gstin) throw appError(ERROR_CODES.BULK_INST_CUSTOMER_NO_GSTIN, cur.companyName);
  await AppDataSource.getRepository(BulkInstitutionCustomer).update({ id: String(cur.id) }, v ? { gstinVerifiedBy: actor.id, gstinVerifiedAt: new Date() } : { gstinVerifiedBy: null, gstinVerifiedAt: null });
  log.info(LOG_SOURCE.API, `[bulk-orders] Institutional customer ${id} GSTIN ${v ? 'verified' : 'unverified'} by user ${actor.id}`);
  return oneOut(String(cur.id));
};
