import { Column, Entity, Index, JoinColumn, ManyToOne, OneToMany, PrimaryGeneratedColumn, Unique } from 'typeorm';
import { PO_ACTIVE_STATUS, PoActiveStatus, TABLES } from '../constants/db';
import { NEW_PO_STATUS } from '../constants/sale-order';
import type { DetailsPurchaseOrder } from './details-purchase-order.entity';
import { DetailsChannel } from './details-channel.entity';
import { MasterChannel } from './master-channel.entity';
import { MasterCourierPartner } from './master-courier-partner.entity';
import { MasterFacility } from './master-facility.entity';
import { decimal } from './transformers';

/**
 * master_purchase_orders: the PO header, one row per PO (was shipment_orders). Column names are camelCase in the DB.
 * Written only once a PO has no open issues; the Uniware sale order code goes into orderNo1.
 * 2026-10-14: the text columns stay as PEPIMS has them (facility, location, transporters, statuses); next to them the
 * links facilityId, locationId, first/second/thirdTransporterId (null = not matched yet, masters:link fills them).
 */
@Entity({ name: TABLES.MASTER_PURCHASE_ORDERS })
@Unique('uq_master_po_channel_po_number', ['channel', 'poNumber'])
// PO Overview filters (2026-10-14); channel is covered by the unique key above, the links by their FK indexes.
@Index('idx_master_po_po_date', ['poDate'])
@Index('idx_master_po_working_date', ['workingDatePlanner'])
@Index('idx_master_po_dispatch_date', ['dispatchDate'])
@Index('idx_master_po_appointment_date', ['currentAppointmentDate'])
@Index('idx_master_po_status_planning', ['statusPlanning'])
@Index('idx_master_po_status_warehouse', ['statusWarehouse'])
@Index('idx_master_po_status_logistics', ['statusLogistics'])
@Index('idx_master_po_location', ['location'])
export class MasterPurchaseOrder {
  @PrimaryGeneratedColumn({ name: 'uid', type: 'bigint' })
  uid: string;

  @Column({ name: 'entryDate', type: 'date', nullable: true })
  entryDate: string | null;

  @Column({ name: 'poDate', type: 'date', nullable: true })
  poDate: string | null;

  @Column({ name: 'facility', type: 'varchar', length: 255, nullable: true })
  facility: string | null;

  /** master_channels.display_name. */
  @Column({ name: 'channel', type: 'varchar', length: 255, nullable: true })
  channel: string | null;

  @Column({ name: 'location', type: 'varchar', length: 255, nullable: true })
  location: string | null;

  @Column({ name: 'poNumber', type: 'varchar', length: 255, nullable: true })
  poNumber: string | null;

  @Column({ name: 'totalUnits', type: 'int', nullable: true })
  totalUnits: number | null;

  @Column({ name: 'brandName', type: 'varchar', length: 255, nullable: true })
  brandName: string | null;

  @Column({ name: 'remarksPlanning', type: 'text', nullable: true })
  remarksPlanning: string | null;

  @Column({ name: 'specialRemarksCOPT', type: 'text', nullable: true })
  specialRemarksCOPT: string | null;

  @Column({ name: 'newShipmentReference', type: 'varchar', length: 255, nullable: true })
  newShipmentReference: string | null;

  @Column({ name: 'statusActive', type: 'enum', enum: Object.values(PO_ACTIVE_STATUS), nullable: true, default: PO_ACTIVE_STATUS.ACTIVE })
  statusActive: PoActiveStatus | null;

  /** Text, checked by the API against master_shipment_statuses (stage planning). */
  @Column({ name: 'statusPlanning', type: 'varchar', length: 50, nullable: true, default: NEW_PO_STATUS.PLANNING })
  statusPlanning: string | null;

  @Column({ name: 'statusWarehouse', type: 'varchar', length: 50, nullable: true })
  statusWarehouse: string | null;

  @Column({ name: 'statusLogistics', type: 'varchar', length: 50, nullable: true })
  statusLogistics: string | null;

  @Column({ name: 'channelInwardingRemarks', type: 'text', nullable: true })
  channelInwardingRemarks: string | null;

  @Column({ name: 'dispatchRemarksLogistics', type: 'text', nullable: true })
  dispatchRemarksLogistics: string | null;

  @Column({ name: 'dispatchRemarksWarehouse', type: 'text', nullable: true })
  dispatchRemarksWarehouse: string | null;

  @Column({ name: 'dispatchDateTentative', type: 'date', nullable: true })
  dispatchDateTentative: string | null;

  @Column({ name: 'workingDatePlanner', type: 'date', nullable: true })
  workingDatePlanner: string | null;

  @Column({ name: 'rtsDate', type: 'date', nullable: true })
  rtsDate: string | null;

  @Column({ name: 'dispatchDate', type: 'date', nullable: true })
  dispatchDate: string | null;

  @Column({ name: 'currentAppointmentDate', type: 'date', nullable: true })
  currentAppointmentDate: string | null;

  @Column({ name: 'firstAppointmentDateCOPT', type: 'date', nullable: true })
  firstAppointmentDateCOPT: string | null;

  @Column({ name: 'noOfBoxes', type: 'int', nullable: true })
  noOfBoxes: number | null;

  /** The Uniware sale order code (from sale_order_code_counter). */
  @Column({ name: 'orderNo1', type: 'varchar', length: 255, nullable: true })
  orderNo1: string | null;

  @Column({ name: 'orderNo2', type: 'varchar', length: 255, nullable: true })
  orderNo2: string | null;

  @Column({ name: 'orderNo3', type: 'varchar', length: 255, nullable: true })
  orderNo3: string | null;

  @Column({ name: 'pickListNo', type: 'varchar', length: 255, nullable: true })
  pickListNo: string | null;

  @Column({ name: 'workingTypeWarehouse', type: 'varchar', length: 255, nullable: true })
  workingTypeWarehouse: string | null;

  @Column({ name: 'inventoryRemarksWarehouse', type: 'text', nullable: true })
  inventoryRemarksWarehouse: string | null;

  @Column({ name: 'b2bWorkingTeamRemarks', type: 'text', nullable: true })
  b2bWorkingTeamRemarks: string | null;

  @Column({ name: 'actualWeight', type: 'decimal', precision: 12, scale: 3, nullable: true, transformer: decimal })
  actualWeight: number | null;

  @Column({ name: 'volumetricWeight', type: 'decimal', precision: 12, scale: 3, nullable: true, transformer: decimal })
  volumetricWeight: number | null;

  @Column({ name: 'physicalWeight', type: 'decimal', precision: 12, scale: 3, nullable: true, transformer: decimal })
  physicalWeight: number | null;

  @Column({ name: 'channelType', type: 'varchar', length: 100, nullable: true })
  channelType: string | null;

  @Column({ name: 'firstTransporter', type: 'varchar', length: 255, nullable: true })
  firstTransporter: string | null;

  @Column({ name: 'firstDocketNo', type: 'varchar', length: 255, nullable: true })
  firstDocketNo: string | null;

  @Column({ name: 'secondTransporter', type: 'varchar', length: 255, nullable: true })
  secondTransporter: string | null;

  @Column({ name: 'secondDocketNo', type: 'varchar', length: 255, nullable: true })
  secondDocketNo: string | null;

  @Column({ name: 'thirdTransporter', type: 'varchar', length: 255, nullable: true })
  thirdTransporter: string | null;

  @Column({ name: 'thirdDocketNo', type: 'varchar', length: 255, nullable: true })
  thirdDocketNo: string | null;

  @Column({ name: 'appointmentLetter', type: 'text', nullable: true })
  appointmentLetter: string | null;

  @Column({ name: 'labelsLink', type: 'text', nullable: true })
  labelsLink: string | null;

  @Column({ name: 'invoiceDate', type: 'date', nullable: true })
  invoiceDate: string | null;

  @Column({ name: 'invoiceLink', type: 'text', nullable: true })
  invoiceLink: string | null;

  @Column({ name: 'cnLink', type: 'text', nullable: true })
  cnLink: string | null;

  @Column({ name: 'ewayLink', type: 'text', nullable: true })
  ewayLink: string | null;

  @Column({ name: 'invoiceValue', type: 'decimal', precision: 15, scale: 2, nullable: true, transformer: decimal })
  invoiceValue: number | null;

  @Column({ name: 'remarksAccountsTeam', type: 'text', nullable: true })
  remarksAccountsTeam: string | null;

  @Column({ name: 'invoiceChallanNumber', type: 'varchar', length: 255, nullable: true })
  invoiceChallanNumber: string | null;

  @Column({ name: 'invoiceCheckedBy', type: 'varchar', length: 255, nullable: true })
  invoiceCheckedBy: string | null;

  @Column({ name: 'tallyCustomerName', type: 'varchar', length: 255, nullable: true })
  tallyCustomerName: string | null;

  /** details_channels.uniware_customer_code (logical link, no FK). */
  @Column({ name: 'customerCode', type: 'varchar', length: 255, nullable: true })
  customerCode: string | null;

  @Column({ name: 'poEntryCount', type: 'int', nullable: true })
  poEntryCount: number | null;

  @Column({ name: 'temp', type: 'varchar', length: 255, nullable: true })
  temp: string | null;

  @Column({ name: 'deliveryDate', type: 'date', nullable: true })
  deliveryDate: string | null;

  @Column({ name: 'rescheduleLag', type: 'int', nullable: true })
  rescheduleLag: number | null;

  @Column({ name: 'finalRemarks', type: 'text', nullable: true })
  finalRemarks: string | null;

  @Column({ name: 'updatedGmv', type: 'decimal', precision: 15, scale: 2, nullable: true, transformer: decimal })
  updatedGmv: number | null;

  @Column({ name: 'firstAppointmentDate', type: 'date', nullable: true })
  firstAppointmentDate: string | null;

  @Column({ name: 'secondAppointmentDate', type: 'date', nullable: true })
  secondAppointmentDate: string | null;

  @Column({ name: 'thirdAppointmentDate', type: 'date', nullable: true })
  thirdAppointmentDate: string | null;

  @Column({ name: 'remarkAp1', type: 'text', nullable: true })
  remarkAp1: string | null;

  @Column({ name: 'remarkAp2', type: 'text', nullable: true })
  remarkAp2: string | null;

  @Column({ name: 'remarkAp3', type: 'text', nullable: true })
  remarkAp3: string | null;

  @Column({ name: 'deliveryCharges', type: 'decimal', precision: 15, scale: 2, nullable: true, transformer: decimal })
  deliveryCharges: number | null;

  @Column({ name: 'halting', type: 'decimal', precision: 15, scale: 2, nullable: true, transformer: decimal })
  halting: number | null;

  @Column({ name: 'unloadingCharges', type: 'decimal', precision: 15, scale: 2, nullable: true, transformer: decimal })
  unloadingCharges: number | null;

  @Column({ name: 'dedicatedVehicle', type: 'decimal', precision: 15, scale: 2, nullable: true, transformer: decimal })
  dedicatedVehicle: number | null;

  @Column({ name: 'otherCharges', type: 'decimal', precision: 15, scale: 2, nullable: true, transformer: decimal })
  otherCharges: number | null;

  @Column({ name: 'document', type: 'text', nullable: true })
  document: string | null;

  @Column({ name: 'proofOfDispatch', type: 'text', nullable: true })
  proofOfDispatch: string | null;

  @Column({ name: 'proofOfDelivery', type: 'text', nullable: true })
  proofOfDelivery: string | null;

  /** Rate per kg the shipment was charged (PEPIMS FLOAT); else master_courier_rates gives it. */
  @Column({ name: 'rpk', type: 'decimal', precision: 10, scale: 2, nullable: true, transformer: decimal })
  rpk: number | null;

  /** Earlier PO numbers of this shipment (PEPIMS JSON list). */
  @Column({ name: 'poNumbers', type: 'json', nullable: true })
  poNumbers: string[] | null;

  @Column({ name: 'deliveryType', type: 'varchar', length: 100, nullable: true })
  deliveryType: string | null;

  @Column({ name: 'appointmentShootedDate', type: 'date', nullable: true })
  appointmentShootedDate: string | null;

  @Column({ name: 'appointmentRequestedDate', type: 'date', nullable: true })
  appointmentRequestedDate: string | null;

  @Column({ name: 'remarksWarehouse', type: 'text', nullable: true })
  remarksWarehouse: string | null;

  @Column({ name: 'poNumberInwardCWH', type: 'varchar', length: 255, nullable: true })
  poNumberInwardCWH: string | null;

  @Column({ name: 'createdAt', type: 'datetime', nullable: true })
  createdAt: Date | null;

  @Column({ name: 'updatedAt', type: 'datetime', nullable: true })
  updatedAt: Date | null;

  /** Every appointment date given, oldest first (PEPIMS JSON list); currentAppointmentDate = the last one. */
  @Column({ name: 'allAppointmentDate', type: 'json', nullable: true })
  allAppointmentDate: string[] | null;

  /** The remark of each appointment change, same order as allAppointmentDate. */
  @Column({ name: 'appointmentRemarks', type: 'json', nullable: true })
  appointmentRemarks: string[] | null;

  /** master_facilities.id resolved from facility. */
  @Column({ name: 'facilityId', type: 'int', nullable: true })
  facilityId: number | null;

  /** details_channels.id of the delivery location (location / customerCode come from that row). */
  @Column({ name: 'locationId', type: 'bigint', nullable: true })
  locationId: string | null;

  /** master_courier_partners.id resolved from first / second / thirdTransporter. */
  @Column({ name: 'firstTransporterId', type: 'int', nullable: true })
  firstTransporterId: number | null;

  @Column({ name: 'secondTransporterId', type: 'int', nullable: true })
  secondTransporterId: number | null;

  @Column({ name: 'thirdTransporterId', type: 'int', nullable: true })
  thirdTransporterId: number | null;

  /** fk_master_po_channel: channel -> master_channels.display_name. */
  @ManyToOne(() => MasterChannel, { nullable: true, onUpdate: 'CASCADE' })
  @JoinColumn({ name: 'channel', referencedColumnName: 'displayName', foreignKeyConstraintName: 'fk_master_po_channel' })
  channelRef: MasterChannel | null;

  /** fk_master_po_facility */
  @ManyToOne(() => MasterFacility, { nullable: true, onDelete: 'RESTRICT', onUpdate: 'CASCADE' })
  @JoinColumn({ name: 'facilityId', referencedColumnName: 'id', foreignKeyConstraintName: 'fk_master_po_facility' })
  facilityRef: MasterFacility | null;

  /** fk_master_po_location */
  @ManyToOne(() => DetailsChannel, { nullable: true, onDelete: 'RESTRICT', onUpdate: 'CASCADE' })
  @JoinColumn({ name: 'locationId', referencedColumnName: 'id', foreignKeyConstraintName: 'fk_master_po_location' })
  locationRef: DetailsChannel | null;

  /** fk_master_po_transporter_1 / _2 / _3 */
  @ManyToOne(() => MasterCourierPartner, { nullable: true, onDelete: 'RESTRICT', onUpdate: 'CASCADE' })
  @JoinColumn({ name: 'firstTransporterId', referencedColumnName: 'id', foreignKeyConstraintName: 'fk_master_po_transporter_1' })
  firstTransporterRef: MasterCourierPartner | null;

  @ManyToOne(() => MasterCourierPartner, { nullable: true, onDelete: 'RESTRICT', onUpdate: 'CASCADE' })
  @JoinColumn({ name: 'secondTransporterId', referencedColumnName: 'id', foreignKeyConstraintName: 'fk_master_po_transporter_2' })
  secondTransporterRef: MasterCourierPartner | null;

  @ManyToOne(() => MasterCourierPartner, { nullable: true, onDelete: 'RESTRICT', onUpdate: 'CASCADE' })
  @JoinColumn({ name: 'thirdTransporterId', referencedColumnName: 'id', foreignKeyConstraintName: 'fk_master_po_transporter_3' })
  thirdTransporterRef: MasterCourierPartner | null;

  /** The PO's lines (details_purchase_orders.shipmentOrderId). */
  @OneToMany('DetailsPurchaseOrder', (line: DetailsPurchaseOrder) => line.purchaseOrder)
  lines: DetailsPurchaseOrder[];
}
