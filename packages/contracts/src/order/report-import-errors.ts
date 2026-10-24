import { z } from "zod";

export const AmazonReportImportErrorCodeSchema = z.enum([
  "report_too_large", "report_row_limit", "report_quote_trailing_characters", "report_quote_unclosed",
  "report_amount_invalid", "report_amount_precision", "report_amount_overflow", "report_field_invalid",
  "report_empty", "report_headers_invalid", "report_headers_missing", "report_columns_mismatch",
  "report_date_invalid", "report_date_nonexistent", "report_currency_invalid", "report_quantity_invalid",
  "report_quantity_overflow", "report_tax_overflow", "report_buyer_shipping_invalid", "report_duplicate_conflict",
  "report_order_conflict", "report_order_line_limit", "report_financial_columns_incomplete", "report_type_unsupported",
  "report_order_limit", "report_account_unavailable", "report_marketplace_mismatch", "report_queue_unavailable",
  "report_invalid_request", "report_invalid", "report_format_invalid", "report_amount_out_of_range",
]);

// Only known report column names may cross the diagnostic boundary. Source values
// and arbitrary input headers must never be included in error responses or logs.
export const AmazonReportRequiredHeaderSchema = z.enum([
  "order-id", "order-item-id", "purchase-date", "sku", "product-name", "quantity-purchased",
  "currency", "item-price", "quantity-shipped", "quantity-to-ship", "promise-date",
]);

export const AmazonReportImportErrorSchema = z.object({
  code: AmazonReportImportErrorCodeSchema,
  row: z.number().int().positive().max(21_000_000).optional(),
  missingHeaders: z.array(AmazonReportRequiredHeaderSchema).min(1).max(11).optional(),
}).strict();

export type AmazonReportImportError = z.infer<typeof AmazonReportImportErrorSchema>;
export type AmazonReportImportErrorCode = z.infer<typeof AmazonReportImportErrorCodeSchema>;
export type AmazonReportRequiredHeader = z.infer<typeof AmazonReportRequiredHeaderSchema>;

const messages: Record<AmazonReportImportErrorCode, string> = {
  report_too_large: "报告大小超过允许限制，请选择不超过 5 MiB 的原始报告",
  report_row_limit: "订单报告超过 20000 条订单行限制",
  report_quote_trailing_characters: "引号结束后出现无效字符",
  report_quote_unclosed: "字段引号未闭合",
  report_amount_invalid: "金额格式无效",
  report_amount_precision: "金额精度超过币种允许的小数位",
  report_amount_overflow: "金额超过可处理范围",
  report_field_invalid: "字段为空、过长或包含无效字符",
  report_empty: "订单报告没有可导入的订单行",
  report_headers_invalid: "订单报告包含重复或空白列名",
  report_headers_missing: "订单报告缺少必要列，请下载亚马逊订单报告原始 TXT 文件",
  report_columns_mismatch: "列数与表头不一致",
  report_date_invalid: "购买时间无效或缺少时区",
  report_date_nonexistent: "购买日期不存在",
  report_currency_invalid: "币种无效或暂不支持",
  report_quantity_invalid: "购买数量必须是正整数",
  report_quantity_overflow: "购买数量超过可处理范围",
  report_tax_overflow: "税额超过可处理范围",
  report_buyer_shipping_invalid: "买家或配送信息格式无效",
  report_duplicate_conflict: "同一订单行出现相互冲突的数据",
  report_order_conflict: "同一订单的时间、币种或配送信息不一致",
  report_order_line_limit: "单个订单超过 1000 条订单行限制",
  report_financial_columns_incomplete: "报告金额列不完整，币种 currency 与商品金额 item-price 必须同时提供；系统不会推测币种或金额",
  report_type_unsupported: "无法识别订单报告类型，请下载含金额的订单报告，或包含 quantity-shipped、quantity-to-ship、promise-date 的未发货订单报告",
  report_order_limit: "每批报告需要包含 1 至 1000 个订单",
  report_account_unavailable: "请选择可用的亚马逊店铺",
  report_marketplace_mismatch: "所选站点不属于当前店铺，请核对报告站点",
  report_queue_unavailable: "后台任务服务暂不可用，报告尚未导入，请稍后重试",
  report_invalid_request: "订单报告导入参数无效，请重新选择店铺、站点和原始报告",
  report_invalid: "订单报告格式无法识别，请检查原始 TXT 或 TSV 文件",
  report_format_invalid: "订单报告格式无法识别，请检查原始 TXT 或 TSV 文件",
  report_amount_out_of_range: "订单总金额超过可处理范围，请核对原始报告",
};

export function formatAmazonReportImportError(error: AmazonReportImportError): string {
  const diagnostic = AmazonReportImportErrorSchema.parse(error);
  const prefix = diagnostic.row === undefined ? "" : `订单报告第 ${diagnostic.row} 行：`;
  const columns = diagnostic.code === "report_headers_missing" && diagnostic.missingHeaders
    ? `（缺少：${diagnostic.missingHeaders.join("、")}）` : "";
  return `${prefix}${messages[diagnostic.code]}${columns}`;
}
