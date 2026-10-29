/*
 * Shipment_Status.csv and PO_Format.csv built from PEPIMS (mcaff_inv) instead of being uploaded (user, 2026-10-22/23).
 * Each column is [header in the uploaded file, where its value comes from], in the uploaded file's order. The mapping
 * was proven on the 22 Oct uploads (9,909 POs, 88,710 lines): every column equal on the same UID / (UID, Sr No),
 * apart from values people changed in PEPIMS after that export.
 *   po.<col>    shipment_orders.<col>        line.<col>   sku_orders.<col>
 *   sum.<col>   SUM(sku_orders.<col>) of the PO's lines   ''   always blank (no PEPIMS column)
 * Columns PEPIMS keeps under another name: PO Expiry Date = labelsLink, Critical Dispatch Date = dispatchDate,
 * Shipment Weight = actualWeight, Chargable Weight = physicalWeight, Total Units = Updated Qty = SUM(updatedQty).
 */

/** Days of POs (by Entry Date, ending with the report's day) read from PEPIMS. */
export const PEPIMS_TRACKER_DAYS = 90;

export const PEPIMS_SHIPMENT_STATUS_COLUMNS: readonly [string, string][] = [
  ['UID', 'po.uid'], ['Entry Date', 'po.entryDate'], ['PO Date', 'po.poDate'], ['Facility', 'po.facility'], ['Channel', 'po.channel'],
  ['Location', 'po.location'], ['PO Number', 'po.poNumber'], ['Total Units', 'sum.updatedQty'], ['Updated Qty', 'sum.updatedQty'],
  ['Updated Gmv', 'sum.updatedGmv'], ['Updated Po Value', 'sum.updatedPoValue'], ['Remarks (Planning)', 'po.remarksPlanning'],
  ['Special Remarks (COPT)', 'po.specialRemarksCOPT'], ['New Shipment Reference', 'po.newShipmentReference'],
  ['Status (Planning)', 'po.statusPlanning'], ['Status (Warehouse)', 'po.statusWarehouse'], ['Status (Logistics)', 'po.statusLogistics'],
  ['Channel Inwarding Remarks', 'po.channelInwardingRemarks'], ['Dispatch Remarks (Logistics)', 'po.dispatchRemarksLogistics'],
  ['Dispatch Remarks (Warehouse)', 'po.dispatchRemarksWarehouse'], ['Dispatch Date - Tentative (Planning)', 'po.dispatchDateTentative'],
  ['Working Date', 'po.workingDatePlanner'], ['RTS Date', 'po.rtsDate'], ['Dispatch Date', 'po.dispatchDate'],
  ['Current Appointment Date', 'po.currentAppointmentDate'], ['First Appointment Date', 'po.firstAppointmentDateCOPT'],
  ['No of Boxes', 'po.noOfBoxes'], ['Order No 1', 'po.orderNo1'], ['Order No 2', 'po.orderNo2'], ['Order No 3', 'po.orderNo3'],
  ['PO Number (Inward - CWH)', 'po.poNumberInwardCWH'], ['Pick List No', 'po.pickListNo'], ['Working Type (Warehouse)', 'po.workingTypeWarehouse'],
  ['Inventory Remarks (Warehouse)', 'po.inventoryRemarksWarehouse'], ['B2B Working Team Remarks', 'po.b2bWorkingTeamRemarks'],
  ['Volumetric Weight', 'po.volumetricWeight'], ['Channel Type', 'po.channelType'], ['1st Transporter (First Mile)', 'po.firstTransporter'],
  ['1st Docket No/ Vehicle Number (First Mile)', 'po.firstDocketNo'], ['2nd Transporter (Mid Mile)', 'po.secondTransporter'],
  ['2nd Docket No/ Vehicle Number (Mid Mile)', 'po.secondDocketNo'], ['3rd Transporter (Last Mile)', 'po.thirdTransporter'],
  ['3rd Docket No/ Vehicle Number (Last Mile)', 'po.thirdDocketNo'], ['Appointment Letter/STN', 'po.appointmentLetter'],
  ['PO Expiry Date', 'po.labelsLink'], ['Invoice Date', 'po.invoiceDate'], ['Invoice Link', 'po.invoiceLink'], ['CN Link', 'po.cnLink'],
  ['E-Way Link', 'po.ewayLink'], ['Invoice Value (Check with Invoice Link)', 'po.invoiceValue'], ['Remarks by Accounts Team', 'po.remarksAccountsTeam'],
  ['Invoice / Challan Number', 'po.invoiceChallanNumber'], ['Invoice Checked By', 'po.invoiceCheckedBy'], ['Customer Code', 'po.customerCode'],
  ['PO Entry Count', 'po.poEntryCount'], ['Delivery Date', 'po.deliveryDate'], ['Reschedule Lag (Remarks)', 'po.rescheduleLag'],
  ['Final Remarks', 'po.finalRemarks'], ['Shipment Weight', 'po.actualWeight'], ['Chargable Weight', 'po.physicalWeight'],
  ['Delivery Charges', 'po.deliveryCharges'], ['halting', 'po.halting'], ['Unloading Charges', 'po.unloadingCharges'],
  ['Dedicated Vehicle', 'po.dedicatedVehicle'], ['Other Charges', 'po.otherCharges'], ['TAT', ''], ['Critical Dispatch Date', 'po.dispatchDate'],
  ['Rates/kg', 'po.rpk'], ['DeliveryType', 'po.deliveryType'], ['Appointment Shooted Date', 'po.appointmentShootedDate'],
  ['Appointment Requested Date', 'po.appointmentRequestedDate'], ['Remarks (Warehouse)', 'po.remarksWarehouse'],
];

export const PEPIMS_PO_FORMAT_COLUMNS: readonly [string, string][] = [
  ['Shipment UID', 'po.uid'], ['Entry Date', 'po.entryDate'], ['PO Date', 'po.poDate'], ['Facility', 'po.facility'], ['Channel', 'po.channel'],
  ['Location', 'po.location'], ['PO Number', 'line.poNumber'], ['Brand', 'line.brandName'], ['Sr No', 'line.srNo'], ['SKU Name', 'line.skuName'],
  ['SKU Code', 'line.skuCode'], ['Channel SKU Code', 'line.channelSkuCode'], ['Quantity', 'line.qty'], ['GMV', 'line.gmv'], ['PO Value', 'line.poValue'],
  ['Updated Quantity', 'line.updatedQty'], ['Updated GMV', 'line.updatedGmv'], ['Updated PO Value', 'line.updatedPoValue'],
  ['Product Weight', 'line.actualWeight'], ['Working Date', 'po.workingDatePlanner'], ['Dispatch Date', 'po.dispatchDate'],
  ['Current Appointment Date', 'po.currentAppointmentDate'], ['Status Planning', 'po.statusPlanning'], ['Status Warehouse', 'po.statusWarehouse'],
  ['Status Logistics', 'po.statusLogistics'],
];
