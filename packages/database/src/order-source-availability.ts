import { sql, type SQL } from "drizzle-orm";

/** Metadata-only current privacy gate, shared by order operations and follow-up readers. */
export function orderPrivateSourceAvailable(orderId: SQL) {
  return sql`exists(select 1 from orders privacy_order where privacy_order.id=${orderId}
    and privacy_order.address_status<>'anonymized'
    and not exists(select 1 from order_protected_details p where p.order_id=privacy_order.id and (p.status='anonymized' or p.retention_expires_at<=clock_timestamp()))
    and not exists(select 1 from order_work_items w join order_lines l on l.id=w.id where l.order_id=privacy_order.id and (w.encrypted_data_key is null or w.expires_at<=clock_timestamp()))
    and not exists(select 1 from amazon_order_report_lines r join order_lines l on l.id=r.order_line_id where l.order_id=privacy_order.id and (r.state='expired' or r.expires_at<=clock_timestamp())))`;
}
