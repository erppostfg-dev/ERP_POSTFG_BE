import { Column, Entity, PrimaryColumn } from 'typeorm';
import { TABLES } from '../constants/db';

/** sale_order_code_counter: one row per date with the last serial used for generated sale order codes. */
@Entity({ name: TABLES.SALE_ORDER_CODE_COUNTER })
export class SaleOrderCodeCounter {
  /** YYYY-MM-DD. */
  @PrimaryColumn({ name: 'counter_date', type: 'date' })
  counterDate: string;

  @Column({ name: 'last_serial', type: 'int' })
  lastSerial: number;
}
