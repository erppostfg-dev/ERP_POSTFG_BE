import { AppDataSource } from '../../config/data-source';
import { MasterSku } from '../../entities';

/*
 * GET /masters/pep-skus: every row of master_skus (about 900), sorted by pep_code. The page searches and filters in
 * the browser, so no paging yet. Values are sent as stored (no clean-up): an empty column comes back as null.
 * The page's category, sub-category, filling and recipe have no column in master_skus, so they are not sent.
 */

export interface PepSkuItem {
  pepCode: string;
  productName: string | null;
  brand: string | null;
  productType: string | null;
  mrp: number | null;
  /** master_skus.gst_tax_type as stored: the GST rate in percent as text ("18", "5", "0", "12"). */
  gstTaxType: string | null;
  eanCode: string | null;
  hsnCode: string | null;
  lengthMm: number | null;
  widthMm: number | null;
  heightMm: number | null;
  weightG: number | null;
  shelfLife: number | null;
  isActive: boolean;
}

export async function listPepSkus(): Promise<PepSkuItem[]> {
  const rows = await AppDataSource.getRepository(MasterSku).find({ order: { pepCode: 'ASC' } });
  return rows.map((r) => ({
    pepCode: r.pepCode,
    productName: r.productName,
    brand: r.brandName,
    productType: r.productType,
    mrp: r.mrp,
    gstTaxType: r.gstTaxType,
    eanCode: r.eanCode,
    hsnCode: r.hsnCode,
    lengthMm: r.lengthMm,
    widthMm: r.widthMm,
    heightMm: r.heightMm,
    weightG: r.weightG,
    shelfLife: r.shelfLife,
    isActive: r.isActive !== false,
  }));
}
