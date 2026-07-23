import {
  ArrowDownLeft,
  ArrowRight,
  ArrowUpRight,
  Boxes,
  CircleAlert,
  MapPin,
  PackageCheck,
  PackageOpen,
  Route,
  ShieldCheck,
  Warehouse,
} from "lucide-react";
import type {
  InventoryBalanceView,
  InventoryLocationView,
  InventoryMovementView,
  InventoryStockItemView,
  InventoryTransferView,
  InventoryUnit,
  InventoryWorkspaceView,
} from "@yummyai/contracts";

export function InventoryWorkspace({ data }: { data: InventoryWorkspaceView }) {
  const stockItems = new Map(data.stockItems.map((item) => [item.id, item]));
  const locations = new Map(data.locations.map((location) => [location.id, location]));
  const warehouses = new Map(data.warehouses.map((warehouse) => [warehouse.id, warehouse]));
  const lots = new Map(data.lots.map((lot) => [lot.id, lot]));
  const totals = {
    physical: 0,
    reserved: 0,
    available: 0,
    inTransit: 0,
  };
  for (const balance of data.balances) {
    totals.physical += balance.physicalQuantity;
    totals.reserved += balance.reservedQuantity;
    totals.available += balance.availableQuantity;
    totals.inTransit += balance.inTransitQuantity;
  }
  const activeReservations = data.reservations.filter((reservation) => reservation.status === "active");

  if (!data.stockItems.length && !data.balances.length) {
    return (
      <section className="inventory-empty" aria-labelledby="inventory-empty-title">
        <PackageOpen size={32} />
        <strong id="inventory-empty-title">还没有库存事实</strong>
        <span>先通过库存 API 建立仓库、库位和物料，再记录期初或收货流水。系统不会推测库存数量。</span>
      </section>
    );
  }

  return (
    <>
      <section className="inventory-signal" aria-label="库存桶汇总">
        <Signal icon={<Boxes size={17} />} code="PHYSICAL" label="实物库存" value={totals.physical} tone="navy" />
        <Signal icon={<ShieldCheck size={17} />} code="RESERVED" label="已预占" value={totals.reserved} tone="amber" />
        <Signal icon={<PackageCheck size={17} />} code="AVAILABLE" label="可用库存" value={totals.available} tone="green" />
        <Signal icon={<Route size={17} />} code="IN TRANSIT" label="在途库存" value={totals.inTransit} tone="blue" />
      </section>

      <section className="inventory-ledger" aria-labelledby="inventory-balance-title">
        <SectionHeader
          code="REBUILDABLE PROJECTION"
          title="库存余额"
          detail={`${data.balances.length} 个物料 / 库位 / 批次维度`}
        />
        <div className="inventory-table-scroll">
          <table className="inventory-table inventory-balance-table">
            <thead>
              <tr>
                <th>物料</th><th>库位</th><th>批次</th><th>实物</th><th>预占</th><th>可用</th><th>在途</th><th>单位</th>
              </tr>
            </thead>
            <tbody>
              {data.balances.map((balance) => (
                <BalanceRow
                  key={`${balance.stockItemId}:${balance.locationId}:${balance.lotId ?? "-"}`}
                  balance={balance}
                  stockItem={stockItems.get(balance.stockItemId)}
                  location={locations.get(balance.locationId)}
                  warehouseName={warehouseName(locations.get(balance.locationId), warehouses)}
                  lotCode={balance.lotId ? lots.get(balance.lotId)?.code : undefined}
                />
              ))}
            </tbody>
          </table>
        </div>
        {!data.balances.length ? <InlineEmpty message="物料已建立，但还没有可计算的库存流水。" /> : null}
      </section>

      <div className="inventory-two-column">
        <section className="inventory-ledger" aria-labelledby="inventory-reservation-title">
          <SectionHeader
            code="AVAILABILITY LOCK"
            title="有效预占"
            detail={`${activeReservations.length} 笔占用`}
          />
          {activeReservations.length ? (
            <ol className="inventory-queue">
              {activeReservations.map((reservation) => (
                <li key={reservation.id}>
                  <span className="inventory-queue-icon"><ShieldCheck size={15} /></span>
                  <div>
                    <strong>{stockLabel(stockItems.get(reservation.stockItemId))}</strong>
                    <span>{locationLabel(locations.get(reservation.locationId))} · {sourceLabel(reservation.sourceType)} {reservation.sourceId}</span>
                  </div>
                  <b>{reservation.quantity}<small>{unitLabel(reservation.unit)}</small></b>
                </li>
              ))}
            </ol>
          ) : <InlineEmpty message="当前没有有效预占，可用量等于实物量。" />}
        </section>

        <section className="inventory-ledger" aria-labelledby="inventory-transfer-title">
          <SectionHeader
            code="PAIRED MOVEMENTS"
            title="库存调拨"
            detail={`${data.transfers.length} 笔调拨`}
          />
          {data.transfers.length ? (
            <ol className="inventory-transfer-list">
              {data.transfers.map((transfer) => (
                <TransferRow
                  key={transfer.id}
                  transfer={transfer}
                  stockItem={stockItems.get(transfer.stockItemId)}
                  source={locations.get(transfer.sourceLocationId)}
                  destination={locations.get(transfer.destinationLocationId)}
                />
              ))}
            </ol>
          ) : <InlineEmpty message="当前没有调拨记录。" />}
        </section>
      </div>

      <section className="inventory-ledger" aria-labelledby="inventory-movement-title">
        <SectionHeader
          code="IMMUTABLE MOVEMENT LEDGER"
          title="最近库存流水"
          detail={`显示最近 ${data.movements.length} 条`}
        />
        <div className="inventory-table-scroll">
          <table className="inventory-table inventory-movement-table">
            <thead>
              <tr>
                <th>发生时间</th><th>物料 / 库位</th><th>变动</th><th>库存桶</th><th>原因</th><th>来源</th>
              </tr>
            </thead>
            <tbody>
              {data.movements.map((movement) => (
                <MovementRow
                  key={movement.id}
                  movement={movement}
                  stockItem={stockItems.get(movement.stockItemId)}
                  location={locations.get(movement.locationId)}
                />
              ))}
            </tbody>
          </table>
        </div>
        {!data.movements.length ? <InlineEmpty message="还没有不可变库存流水。" /> : null}
      </section>
    </>
  );
}

function Signal({
  icon,
  code,
  label,
  value,
  tone,
}: {
  icon: React.ReactNode;
  code: string;
  label: string;
  value: number;
  tone: "navy" | "amber" | "green" | "blue";
}) {
  return (
    <div className={`inventory-signal-item signal-${tone}`}>
      <span>{icon}</span>
      <p><small>{code}</small><strong>{label}</strong></p>
      <b>{value}</b>
    </div>
  );
}

function SectionHeader({ code, title, detail }: { code: string; title: string; detail: string }) {
  return (
    <header>
      <div><p className="section-code">{code}</p><h2>{title}</h2></div>
      <span>{detail}</span>
    </header>
  );
}

function BalanceRow({
  balance,
  stockItem,
  location,
  warehouseName: warehouseLabel,
  lotCode,
}: {
  balance: InventoryBalanceView;
  stockItem?: InventoryStockItemView;
  location?: InventoryLocationView;
  warehouseName: string;
  lotCode?: string;
}) {
  return (
    <tr>
      <td><strong>{stockLabel(stockItem)}</strong><code>{stockItem?.code ?? shortId(balance.stockItemId)}</code></td>
      <td><span className="inventory-location"><MapPin size={13} />{locationLabel(location)}</span><small>{warehouseLabel}</small></td>
      <td><code>{lotCode ?? "无批次"}</code></td>
      <QuantityCell value={balance.physicalQuantity} />
      <QuantityCell value={balance.reservedQuantity} tone={balance.reservedQuantity ? "amber" : undefined} />
      <QuantityCell value={balance.availableQuantity} tone={balance.availableQuantity ? "green" : "danger"} />
      <QuantityCell value={balance.inTransitQuantity} tone={balance.inTransitQuantity ? "blue" : undefined} />
      <td><span className="inventory-unit">{unitLabel(balance.unit as InventoryUnit)}</span></td>
    </tr>
  );
}

function QuantityCell({ value, tone }: { value: number; tone?: "amber" | "green" | "blue" | "danger" }) {
  return <td><b className={tone ? `inventory-quantity quantity-${tone}` : "inventory-quantity"}>{value}</b></td>;
}

function TransferRow({
  transfer,
  stockItem,
  source,
  destination,
}: {
  transfer: InventoryTransferView;
  stockItem?: InventoryStockItemView;
  source?: InventoryLocationView;
  destination?: InventoryLocationView;
}) {
  return (
    <li>
      <div className="inventory-transfer-route">
        <span><Warehouse size={13} />{locationLabel(source)}</span>
        <ArrowRight size={14} />
        <span><MapPin size={13} />{locationLabel(destination)}</span>
      </div>
      <div>
        <strong>{stockLabel(stockItem)}</strong>
        <span>{transfer.quantity} {unitLabel(transfer.unit as InventoryUnit)}</span>
      </div>
      <span className={`inventory-status status-${transfer.status}`}>{transferStatusLabel(transfer.status)}</span>
    </li>
  );
}

function MovementRow({
  movement,
  stockItem,
  location,
}: {
  movement: InventoryMovementView;
  stockItem?: InventoryStockItemView;
  location?: InventoryLocationView;
}) {
  const positive = movement.quantityDelta > 0;
  return (
    <tr>
      <td><time dateTime={movement.occurredAt}>{formatDateTime(movement.occurredAt)}</time></td>
      <td><strong>{stockLabel(stockItem)}</strong><span>{locationLabel(location)}</span></td>
      <td><span className={positive ? "movement-delta is-positive" : "movement-delta is-negative"}>
        {positive ? <ArrowDownLeft size={13} /> : <ArrowUpRight size={13} />}
        {positive ? "+" : ""}{movement.quantityDelta}
      </span></td>
      <td><span className="inventory-bucket">{bucketLabel(movement.bucket)}</span></td>
      <td><code>{movement.reasonCode}</code></td>
      <td><span>{sourceLabel(movement.sourceType)}</span><code>{movement.sourceId}</code></td>
    </tr>
  );
}

function InlineEmpty({ message }: { message: string }) {
  return <p className="inventory-inline-empty"><CircleAlert size={15} />{message}</p>;
}

function stockLabel(stockItem?: InventoryStockItemView) {
  return stockItem?.name ?? "未知物料";
}

function locationLabel(location?: InventoryLocationView) {
  return location ? `${location.code} · ${location.name}` : "未知库位";
}

function warehouseName(
  location: InventoryLocationView | undefined,
  warehouses: Map<string, InventoryWorkspaceView["warehouses"][number]>,
) {
  if (!location) return "未知仓库";
  return warehouses.get(location.warehouseId)?.name ?? "未知仓库";
}

function sourceLabel(source: string) {
  return ({
    opening: "期初",
    order: "订单",
    order_line: "订单行",
    receipt: "收货",
    return: "退货",
    transfer: "调拨",
    adjustment: "调整",
    reconciliation: "对账",
    manual: "人工",
  } as Record<string, string>)[source] ?? source;
}

function bucketLabel(bucket: InventoryMovementView["bucket"]) {
  return ({ physical: "实物", in_transit: "在途", provider: "服务商", virtual: "虚拟" })[bucket];
}

function transferStatusLabel(status: InventoryTransferView["status"]) {
  return ({ draft: "草稿", in_transit: "在途", received: "已收货", cancelled: "已取消" })[status];
}

function unitLabel(unit: InventoryUnit) {
  return ({ each: "件", pair: "对", set: "套", meter: "米", gram: "克", kilogram: "千克" })[unit];
}

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(value));
}

function shortId(value: string) {
  return value.slice(0, 8);
}
