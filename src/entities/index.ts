/**
 * TypeORM entities for the tables in mcaff_postfg_dev (Final_Schema/final_schema.sql), one per table.
 * They only MAP the existing tables: the schema is created and migrated by others, the app never changes it.
 */
export * from './details-channel.entity';
export * from './details-purchase-order.entity';
export * from './master-channel-sku.entity';
export * from './master-appointment-remark.entity';
export * from './master-channel.entity';
export * from './master-courier-partner.entity';
export * from './master-courier-rate.entity';
export * from './master-facility.entity';
export * from './master-final-status-map.entity';
export * from './master-purchase-order.entity';
export * from './master-shipment-status.entity';
export * from './master-sku.entity';
export * from './po-issue-action.entity';
export * from './po-issue.entity';
export * from './po-review-submission.entity';
export * from './po-upload.entity';
export * from './sale-order-code-counter.entity';
export * from './shipment-log.entity';
export * from './team-access.entities';
export * from './auth.entities';
