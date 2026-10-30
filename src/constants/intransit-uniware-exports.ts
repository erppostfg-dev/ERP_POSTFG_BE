/*
 * Uniware exports the in-transit connector runs (port of intransit-service/uniware_exports.json, user, 2026-10-15).
 * One entry per Uniware file. 'payload' is sent to /services/rest/v1/export/job/create
 * (frequency ONETIME is added automatically).
 * payload.exportColums are Uniware's INTERNAL column ids (e.g. displayorderCode), and
 * payload.exportFilters use internal filter ids (e.g. addedOn). Both come from the export
 * screen: Dashboard > Other Reports > Export, F12 > Network, create the export, open the
 * 'export/job/create' request > Payload.
 * header: the column names expected in the downloaded file (= the manual export's header);
 * a download missing a column the pipeline needs is refused.
 * rolling_days: date-range filters are reset each run to whole days, from N days ago 00:00
 * to today 23:59:59 (Indian time), sent as epoch milliseconds like the export screen does.
 * date_column: a date column in the file used to confirm the date filter was applied.
 *
 * Trimmed to what the report uses (user, 2026-10-19): the exports asked for 152 columns, the stages read 32, and the
 * B2B file alone was ~45 MB. Each export now asks only for the columns the stages read plus a few kept for people
 * reading the sheets (marked "kept"). The id -> column pairs come from the full exports (same order). Export_B2B_
 * InTransit_Orders and Duplicate_PO_Report copy every export column, so they now show these columns only.
 * Windows widened from 70 to 90 days: in-transit sale orders older than 70 days were being missed (oldest still in
 * transit on 19 Oct: 7 Aug). The full column lists are in git history if a column is needed back.
 */

export interface UniwareExport {
  /** The input file this export becomes. */
  file: string;
  /** Date-range filters cover the last N whole days (IST); absent: no date filter. */
  rolling_days?: number | null;
  /** Sent to /services/rest/v1/export/job/create (frequency ONETIME is added). */
  payload: { exportJobTypeName: string; exportColums: string[]; exportFilters?: { id: string; dateRange?: { start: number; end: number } }[] } & Record<string, unknown>;
  /** A date column of the file, used to confirm the date filter was applied. */
  date_column?: string | null;
  /** The column names expected in the downloaded file. */
  header?: string[];
  /**
   * Only these facilities' rows are used by the report (others are not exported); absent: every listed facility.
   * Lower-cased match against the facilities marked for the export (master_facilities.uniware_export).
   */
  onlyFacilities?: 'stock';
}

export const UNIWARE_EXPORTS: Record<string, UniwareExport> = {
  // lookups (quantities + status per PO), b2b_orders (in-transit units), combined_intransit, final_sku
  b2b: {
    file: 'Export-B2B Sale Orders.csv',
    rolling_days: 90,
    payload: {
      exportJobTypeName: 'B2B Sale Orders',
      exportColums: [
        'saleOrderCode', // Sale Order Code
        'displayorderCode', // Display Order Code = the PO number
        'skuCode', // Item SKU Code
        'channelProductId', // Channel Product ID
        'itemTypeName', // Item Type Name (kept)
        'channel', // Channel Name (kept)
        'displayOrderDateTime', // Order Date (kept; also checks the date window)
        'status', // Sale Order Status
        'soiTotalQty', // Total Quantity
        'unallocatedQuantity',
        'unfulfillableQuantity',
        'allocatedQuantity',
        'cancelledQuantity',
        'inProcessQuantity',
        'completeQuantity',
        'facility', // Facility (kept)
      ],
      exportFilters: [{ id: 'addedOn', dateRange: { start: 0, end: 0 } }],
    },
    date_column: 'Order Date as dd/mm/yyyy hh:MM:ss',
    header: [
      'Sale Order Code', 'Display Order Code', 'Item SKU Code', 'Channel Product ID', 'Item Type Name', 'Channel Name',
      'Order Date as dd/mm/yyyy hh:MM:ss', 'Sale Order Status', 'Total Quantity', 'Unallocated Quantity', 'Unfulfillable Quantity',
      'Allocated Quantity', 'Cancelled Quantity', 'In Process Quantity', 'Complete Quantity', 'Facility',
      'Channel Shipping', // added by Uniware itself
    ],
  },
  // shipments (GRN check), duplicates (Duplicate_PO_Report), combined_intransit (open POs)
  po: {
    file: 'Purchase_Order.csv',
    rolling_days: 90,
    payload: {
      exportJobTypeName: 'Purchase Orders',
      exportColums: [
        'purchaseOrderCode', // PO Code
        'created', // Created
        'deliveryDate', // Delivery Date
        'itemTypeName', // Item Type Name
        'itemtypeSku', // Item SkuCode
        'vendor', // Vendor Name (kept)
        'quantity', // Order Quantity
        'recieveQuantity', // Recieved Quantity
        'pendingQuantity', // Pending Quantity (kept)
        'facility', // Facility
        'total', // Total
        'purchaseOrderStatus', // Purchase Order Status
        'purchaseOrder_ReferenceNo', // Reference No
        'purchaseOrder_ReferenceOrder', // ReferenceOrder
      ],
      exportFilters: [{ id: 'addedOn', dateRange: { start: 0, end: 0 } }],
    },
    date_column: 'Created',
    header: [
      'PO Code', 'Created', 'Delivery Date', 'Item Type Name', 'Item SkuCode', 'Vendor Name', 'Order Quantity', 'Recieved Quantity',
      'Pending Quantity', 'Facility', 'Total', 'Purchase Order Status', 'Reference No', 'ReferenceOrder',
    ],
  },
  // inventory (SOH per facility); only the report's stock facilities (rules FACILITY_GROUPS) are exported
  inventory: {
    file: 'Export-Inventory Snapshot.csv',
    rolling_days: null,
    payload: {
      exportJobTypeName: 'Inventory Snapshot',
      exportColums: [
        'facility', // Facility
        'itemTypeName', // Item Type Name
        'itemtypeSku', // Item SkuCode
        'openSale', // Open Sale
        'inventory', // Inventory
        'putawayPending', // Putaway Pending
        'pendingStockTransfer', // Stock In Transfer
        'openPurchase', // Open Purchase
      ],
      exportFilters: [],
    },
    date_column: null,
    header: ['Facility', 'Item Type Name', 'Item SkuCode', 'Open Sale', 'Inventory', 'Putaway Pending', 'Stock In Transfer', 'Open Purchase'],
    onlyFacilities: 'stock',
  },
  // Every shelf of the stock facilities, as exported (user, 2026-10-29): the workbook's Shelfwise_Inventory sheet.
  shelfwise: {
    file: 'Export-Shelfwise Inventory.csv',
    rolling_days: null,
    payload: {
      exportJobTypeName: 'Shelfwise Inventory',
      exportColums: [
        'facility',
        'skuCode',
        'itemTypeName',
        'inventoryType',
        'shelf',
        'enabledForInventoryAllocation',
        'enabledForInventorySync',
        'enabledForSkuMixing',
        'enabledForShelfHold',
        'quantity',
        'quantityBlocked',
        'ageingStock',
        'quantityNotFound',
        'excessQuantity',
        'netVariance',
        'quantityDamaged',
        'priority',
        'section',
        'batchCode',
        'expiry',
      ],
      exportFilters: [],
    },
    date_column: null,
    // as downloaded on 29-Oct (42 facilities, 35,124 rows)
    header: [
      'Facility',
      'Item Type SKU Code',
      'Item Type Name',
      'Inventory Type',
      'Shelf',
      'Inventory Allocation',
      'Inventory Sync',
      'Sku Mixing',
      'Shelf On Hold',
      'Quantity',
      'Quantity Blocked',
      'Is Ageing Stock',
      'Quantity Not Found',
      'Excess Quantity',
      'Net Variance',
      'Quantity Damaged',
      'Priority',
      'Section',
      'Batch Code',
      'Expiry',
    ],
    onlyFacilities: 'stock',
  },
};
