import type { ProcurementWorkspaceView } from "@yummyai/contracts";
import {
  AlertTriangle,
  ArrowRight,
  BadgeDollarSign,
  ClipboardCheck,
  FileQuestion,
  PackageCheck,
  PackagePlus,
  ReceiptText,
  RefreshCw,
  ShoppingCart,
} from "lucide-react";

export function ProcurementWorkspace({ data }: { data: ProcurementWorkspaceView }) {
  const suppliers = new Map(data.suppliers.map((supplier) => [supplier.id, supplier]));
  const stockItems = new Map(data.stockItems.map((stockItem) => [stockItem.id, stockItem]));
  const locations = new Map(data.locations.map((location) => [location.id, location]));
  const receiptByOrder = groupBy(data.receipts, (receipt) => receipt.purchaseOrderId);
  const invoiceByOrder = groupBy(data.invoices, (invoice) => invoice.purchaseOrderId);
  const activeOrders = data.purchaseOrders.filter((order) =>
    !["received", "rejected", "cancelled"].includes(order.status));
  const varianceOrders = data.purchaseOrders.filter((order) =>
    order.status === "reconciliation_required");
  const openSuggestions = data.suggestions.filter((suggestion) => suggestion.status === "open");
  const receivedUnits = data.receipts.reduce(
    (total, receipt) => total + receipt.lines.reduce((sum, line) => sum + line.receivedQuantity, 0),
    0,
  );

  if (
    !data.requisitions.length
    && !data.rfqs.length
    && !data.purchaseOrders.length
    && !data.receipts.length
    && !data.policies.length
    && !data.suggestions.length
  ) {
    return (
      <section className="procurement-empty" aria-labelledby="procurement-empty-title">
        <ShoppingCart size={32} />
        <strong id="procurement-empty-title">还没有采购证据</strong>
        <span>先通过采购 API 建立申请、询价或补货策略。系统不会根据库存缺口自动批准采购。</span>
      </section>
    );
  }

  return (
    <>
      <section className="procurement-signals" aria-label="采购运营摘要">
        <Signal icon={<ShoppingCart size={17} />} code="ACTIVE PO" label="进行中采购单" value={activeOrders.length} />
        <Signal icon={<PackageCheck size={17} />} code="RECEIVED" label="累计收货数量" value={receivedUnits} tone="green" />
        <Signal icon={<AlertTriangle size={17} />} code="RECONCILE" label="待对账采购单" value={varianceOrders.length} tone="red" />
        <Signal icon={<RefreshCw size={17} />} code="REPLENISH" label="开放补货建议" value={openSuggestions.length} tone="amber" />
      </section>

      <section className="procurement-flow" aria-label="采购证据链">
        <FlowStep code="REQUEST" label="采购申请" value={data.requisitions.length} icon={<ClipboardCheck size={15} />} />
        <ArrowRight size={14} />
        <FlowStep code="RFQ" label="询价" value={data.rfqs.length} icon={<FileQuestion size={15} />} />
        <ArrowRight size={14} />
        <FlowStep code="APPROVAL" label="已审批" value={data.purchaseOrders.filter((order) => order.status !== "draft" && order.status !== "rejected").length} icon={<ShoppingCart size={15} />} />
        <ArrowRight size={14} />
        <FlowStep code="RECEIPT" label="收货凭证" value={data.receipts.length} icon={<PackagePlus size={15} />} />
        <ArrowRight size={14} />
        <FlowStep code="INVOICE" label="供应商发票" value={data.invoices.length} icon={<ReceiptText size={15} />} />
      </section>

      <section className="procurement-panel" aria-labelledby="procurement-orders-title">
        <SectionHeader
          code="VERSIONED PURCHASE ORDERS"
          title="库存采购单"
          detail={`${data.purchaseOrders.length} 笔，${varianceOrders.length} 笔待对账`}
        />
        <div className="procurement-table-scroll">
          <table className="procurement-table procurement-order-table">
            <thead>
              <tr>
                <th>采购单 / 供应商</th>
                <th>状态</th>
                <th>采购内容</th>
                <th>金额</th>
                <th>预计到货</th>
                <th>收货 / 发票</th>
              </tr>
            </thead>
            <tbody>
              {data.purchaseOrders.map((order) => {
                const orderReceipts = receiptByOrder.get(order.id) ?? [];
                const orderInvoices = invoiceByOrder.get(order.id) ?? [];
                return (
                  <tr key={order.id}>
                    <td>
                      <strong>{order.code}</strong>
                      <span>{suppliers.get(order.supplierId)?.name ?? "未知供应商"} · V{order.currentVersion}</span>
                    </td>
                    <td><Status value={order.status} /></td>
                    <td>
                      {order.lines.map((line) => (
                        <span className="procurement-line" key={line.lineKey}>
                          <b>{stockItems.get(line.stockItemId)?.name ?? line.lineKey}</b>
                          <small>{line.quantity} {unitLabel(line.unit)} · {locations.get(line.destinationLocationId)?.name ?? "未知库位"}</small>
                        </span>
                      ))}
                    </td>
                    <td><strong className="procurement-money">{formatMoney(order.totalMinor, order.currency)}</strong></td>
                    <td><time dateTime={order.expectedAt}>{formatDate(order.expectedAt)}</time></td>
                    <td>
                      <span>{orderReceipts.length} 次收货</span>
                      <small>{orderInvoices.length ? invoiceStatus(orderInvoices) : "未登记发票"}</small>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {!data.purchaseOrders.length ? <InlineEmpty message="还没有库存采购单。" /> : null}
      </section>

      <div className="procurement-columns">
        <section className="procurement-panel" aria-labelledby="replenishment-title">
          <SectionHeader
            code="POLICY-BASED SUGGESTIONS"
            title="补货建议"
            detail={`${openSuggestions.length} 条开放建议`}
          />
          {data.suggestions.length ? (
            <ol className="procurement-suggestion-list">
              {data.suggestions.map((suggestion) => (
                <li key={suggestion.id}>
                  <span className="procurement-list-icon"><RefreshCw size={15} /></span>
                  <div>
                    <strong>{stockItems.get(suggestion.stockItemId)?.name ?? "未知物料"}</strong>
                    <span>{locations.get(suggestion.locationId)?.name ?? "未知库位"} · 可用 {suggestion.availableQuantity} · 在途 {suggestion.inTransitQuantity}</span>
                  </div>
                  <b>+{suggestion.suggestedQuantity}<small>建议</small></b>
                </li>
              ))}
            </ol>
          ) : <InlineEmpty message="当前没有补货建议。建议只提供数量，不会自动建单或审批。" />}
        </section>

        <section className="procurement-panel" aria-labelledby="reconciliation-title">
          <SectionHeader
            code="THREE-WAY MATCH"
            title="收货与发票对账"
            detail={`${data.invoices.filter((invoice) => invoice.status === "reconciliation_required").length} 张发票有差异`}
          />
          {data.receipts.length || data.invoices.length ? (
            <ol className="procurement-reconcile-list">
              {data.receipts.slice(0, 6).map((receipt) => (
                <li key={receipt.id}>
                  <PackagePlus size={15} />
                  <div>
                    <strong>{orderCode(data, receipt.purchaseOrderId)}</strong>
                    <span>{receipt.lines.reduce((sum, line) => sum + line.receivedQuantity, 0)} 已收 · {receipt.lines.reduce((sum, line) => sum + line.rejectedQuantity, 0)} 拒收</span>
                  </div>
                  <Status value={receipt.hasVariance ? "reconciliation_required" : "received"} />
                </li>
              ))}
              {data.invoices.slice(0, 6).map((invoice) => (
                <li key={invoice.id}>
                  <BadgeDollarSign size={15} />
                  <div>
                    <strong>{invoice.invoiceNumber}</strong>
                    <span>{formatMoney(invoice.totalMinor, invoice.currency)} · 差异 {formatSignedMoney(invoice.varianceMinor, invoice.currency)}</span>
                  </div>
                  <Status value={invoice.status} />
                </li>
              ))}
            </ol>
          ) : <InlineEmpty message="还没有收货或供应商发票证据。" />}
        </section>
      </div>

      <section className="procurement-panel" aria-labelledby="procurement-sourcing-title">
        <SectionHeader
          code="SOURCE EVIDENCE"
          title="申请与询价"
          detail={`${data.requisitions.length} 个申请 · ${data.quotes.length} 份报价`}
        />
        <div className="procurement-sourcing-grid">
          {data.requisitions.map((requisition) => (
            <article key={requisition.id}>
              <span className="procurement-source-code">REQUEST</span>
              <strong>{requisition.code}</strong>
              <p>{requisition.lines.length} 个物料行 · {requisition.reasonCode}</p>
              <Status value={requisition.status} />
            </article>
          ))}
          {data.quotes.map((quote) => (
            <article key={quote.id}>
              <span className="procurement-source-code">QUOTE V{quote.version}</span>
              <strong>{suppliers.get(quote.supplierId)?.name ?? "未知供应商"}</strong>
              <p>{quote.lines.length} 个报价行 · 有效至 {formatDate(quote.validUntil)}</p>
              <b className="procurement-money">{formatMoney(quote.totalMinor, quote.currency)}</b>
            </article>
          ))}
        </div>
        {!data.requisitions.length && !data.quotes.length
          ? <InlineEmpty message="还没有采购申请或供应商报价。" />
          : null}
      </section>
    </>
  );
}

function Signal({
  icon,
  code,
  label,
  value,
  tone = "blue",
}: {
  icon: React.ReactNode;
  code: string;
  label: string;
  value: number;
  tone?: "blue" | "green" | "red" | "amber";
}) {
  return (
    <div className={`procurement-signal signal-${tone}`}>
      <span>{icon}</span>
      <p><small>{code}</small><strong>{label}</strong></p>
      <b>{value}</b>
    </div>
  );
}

function FlowStep({
  code,
  label,
  value,
  icon,
}: {
  code: string;
  label: string;
  value: number;
  icon: React.ReactNode;
}) {
  return (
    <div>
      <span>{icon}</span>
      <p><small>{code}</small><strong>{label}</strong></p>
      <b>{value}</b>
    </div>
  );
}

function SectionHeader({ code, title, detail }: { code: string; title: string; detail: string }) {
  return (
    <header>
      <div><p className="section-code">{code}</p><h2 id={headingId(title)}>{title}</h2></div>
      <span>{detail}</span>
    </header>
  );
}

function Status({ value }: { value: string }) {
  return <span className={`procurement-status status-${value}`}>{statusLabel(value)}</span>;
}

function InlineEmpty({ message }: { message: string }) {
  return <p className="procurement-inline-empty"><AlertTriangle size={15} />{message}</p>;
}

function groupBy<T>(values: T[], key: (value: T) => string) {
  const grouped = new Map<string, T[]>();
  for (const value of values) {
    const id = key(value);
    grouped.set(id, [...(grouped.get(id) ?? []), value]);
  }
  return grouped;
}

function orderCode(data: ProcurementWorkspaceView, purchaseOrderId: string) {
  return data.purchaseOrders.find((order) => order.id === purchaseOrderId)?.code ?? "未知采购单";
}

function invoiceStatus(invoices: ProcurementWorkspaceView["invoices"]) {
  return invoices.some((invoice) => invoice.status === "reconciliation_required") ? "发票有差异" : "发票已匹配";
}

function statusLabel(value: string) {
  return ({
    draft: "草稿",
    rfq_open: "询价中",
    ordered: "已建单",
    approved: "已审批",
    rejected: "已拒绝",
    partially_received: "部分收货",
    received: "已收货",
    reconciliation_required: "待对账",
    cancelled: "已取消",
    matched: "已匹配",
    open: "开放",
    converted: "已转换",
    dismissed: "已忽略",
  } as Record<string, string>)[value] ?? value;
}

function unitLabel(unit: string) {
  return ({ each: "件", pair: "对", set: "套", meter: "米", gram: "克", kilogram: "千克" } as Record<string, string>)[unit] ?? unit;
}

function formatMoney(value: number, currency: string) {
  return new Intl.NumberFormat("zh-CN", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
  }).format(value / 100);
}

function formatSignedMoney(value: number, currency: string) {
  const formatted = formatMoney(Math.abs(value), currency);
  return `${value > 0 ? "+" : value < 0 ? "-" : ""}${formatted}`;
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" })
    .format(new Date(value));
}

function headingId(title: string) {
  return ({
    "库存采购单": "procurement-orders-title",
    "补货建议": "replenishment-title",
    "收货与发票对账": "reconciliation-title",
    "申请与询价": "procurement-sourcing-title",
  } as Record<string, string>)[title];
}
