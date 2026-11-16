import { createHash } from "crypto";
import { MigrationInterface, QueryRunner } from "typeorm";

/*
 * Bulk Orders customer book = address book (2026-11-13, user: "save the addresses so we can suggest the customer code if
 * the same address came before"; constants/bulk-orders.ts BULK_SALE):
 *   - bulk_customers + order_type, receiver_name, ship_address_line / city / state / pincode, address_key (sha1 of the
 *     delivery pincode + cleaned line, indexed), hidden_at / hidden_by ("Don't suggest again"); index on ship_pincode.
 *   - Filled from the orders already processed (customer_code set): each order's delivery address + channel + code; an
 *     existing row (by customer_id) gets its first order's address, the others become rows of their own (Marketing had
 *     none). Same cleaning as bulk-process.service addressKey (copied here so this migration never changes).
 * Only NEW columns / indexes + filled rows; down() drops the columns (rows added by up() stay, as customer rows).
 */
const addressKey = (pincode: string, line: string): string =>
    createHash("sha1").update(`${pincode.trim()}|${line.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()}`).digest("hex");

interface OrderRow {
    id: string; order_type: string; institution_name: string | null; gstin: string | null; contact_email: string | null;
    receiver_name: string; receiver_phone: string; address_line: string; city: string; state: string; pincode: string;
    billing_address_line: string | null; billing_city: string | null; billing_state: string | null; billing_pincode: string | null;
    uniware_channel: string; customer_code: string; customer_id: string | null; processed_by: number | null; processed_at: Date | null;
}

export class BulkCustomerAddresses1795300000000 implements MigrationInterface {
    name = 'BulkCustomerAddresses1795300000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query("ALTER TABLE `bulk_customers` ADD `order_type` varchar(20) NOT NULL DEFAULT 'institutional', ADD `receiver_name` varchar(150) NULL, ADD `ship_address_line` varchar(500) NULL, ADD `ship_city` varchar(100) NULL, ADD `ship_state` varchar(100) NULL, ADD `ship_pincode` varchar(10) NULL, ADD `address_key` char(40) NULL, ADD `hidden_at` datetime(6) NULL, ADD `hidden_by` int NULL");
        await queryRunner.query("CREATE INDEX `idx_bulk_customers_address_key` ON `bulk_customers` (`address_key`)");
        await queryRunner.query("CREATE INDEX `idx_bulk_customers_ship_pincode` ON `bulk_customers` (`ship_pincode`)");

        const orders = (await queryRunner.query("SELECT id, order_type, institution_name, gstin, contact_email, receiver_name, receiver_phone, address_line, city, state, pincode, billing_address_line, billing_city, billing_state, billing_pincode, uniware_channel, customer_code, customer_id, processed_by, processed_at FROM `bulk_orders` WHERE customer_code IS NOT NULL AND uniware_channel IS NOT NULL ORDER BY processed_at, id")) as OrderRow[];
        const existing = new Set(((await queryRunner.query("SELECT id FROM `bulk_customers`")) as { id: string | number }[]).map((r) => String(r.id)));
        const seen = new Map<string, string>(); // type|key|channel|code -> row id
        const filled = new Set<string>();
        for (const o of orders) {
            const key = addressKey(o.pincode, o.address_line);
            const k = [o.order_type, key, o.uniware_channel.toLowerCase(), o.customer_code.toLowerCase()].join("|");
            const ship = [o.receiver_name, o.address_line, o.city, o.state, o.pincode, key];
            if (seen.has(k)) continue;
            if (o.customer_id && existing.has(String(o.customer_id)) && !filled.has(String(o.customer_id))) {
                await queryRunner.query("UPDATE `bulk_customers` SET order_type = ?, receiver_name = ?, ship_address_line = ?, ship_city = ?, ship_state = ?, ship_pincode = ?, address_key = ? WHERE id = ?", [o.order_type, ...ship, o.customer_id]);
                filled.add(String(o.customer_id));
                seen.set(k, String(o.customer_id));
                continue;
            }
            const inst = o.order_type === "institutional";
            const res = (await queryRunner.query(
                "INSERT INTO `bulk_customers` (order_type, name, gstin, address_line, city, state, pincode, phone, email, uniware_channel, customer_code, used_count, last_order_id, created_by, receiver_name, ship_address_line, ship_city, ship_state, ship_pincode, address_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)",
                [o.order_type, (inst ? o.institution_name : null) ?? o.receiver_name, inst ? o.gstin : null, o.billing_address_line ?? o.address_line, o.billing_city ?? o.city,
                    o.billing_state ?? o.state, o.billing_pincode ?? o.pincode, o.receiver_phone, o.contact_email, o.uniware_channel, o.customer_code, o.id, o.processed_by ?? 0, ...ship],
            )) as { insertId: number };
            seen.set(k, String(res.insertId));
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query("DROP INDEX `idx_bulk_customers_ship_pincode` ON `bulk_customers`");
        await queryRunner.query("DROP INDEX `idx_bulk_customers_address_key` ON `bulk_customers`");
        await queryRunner.query("ALTER TABLE `bulk_customers` DROP COLUMN `hidden_by`, DROP COLUMN `hidden_at`, DROP COLUMN `address_key`, DROP COLUMN `ship_pincode`, DROP COLUMN `ship_state`, DROP COLUMN `ship_city`, DROP COLUMN `ship_address_line`, DROP COLUMN `receiver_name`, DROP COLUMN `order_type`");
    }
}
