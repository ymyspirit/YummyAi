"use client";

import { sumStockQuantities, subtractStockQuantity, compareStockQuantity, formatStockQuantity, stockQuantityMatchesUnit } from "@yummyai/contracts/inventory/quantity";
import { NonnegativeStockQuantitySchema } from "@yummyai/contracts/inventory/quantity-schema";
import { Permission } from "@yummyai/authz/permissions";

import type { InventoryPurchaseOrderView, ProcurementWorkspaceView } from "@yummyai/contracts/procurement";
import { ClipboardPlus, Plus } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { Field, RecordDialog, RecordForm } from "../manual-operations/record-form";
import { formDate, formText, localDateTime, unitNames } from "../manual-operations/operation-types";
import { IncomingInspectionDialog } from "./incoming-inspection-dialog";
import { ProcurementCommandWorkbench, ProcurementCycleLauncher } from "./procurement-command-workbench";
import { ProcurementMeasure } from "./procurement-cycle-form";
import { ProcurementInvoiceForm } from "./procurement-invoice-form";
import { ProcurementReconciliationWorkbench } from "./procurement-reconciliation-workbench";
import { useErpAccess } from "../identity/erp-access";

export function ProcurementOperations({ data }: { data: ProcurementWorkspaceView }) {
  return <>
    <div className="record-toolbar"><ProcurementCycleLauncher data={data} kind="requisition_create" primary><ClipboardPlus size={15} />新增采购申请</ProcurementCycleLauncher><ProcurementCycleLauncher data={data} kind="purchase_create"><Plus size={15} />新增采购单</ProcurementCycleLauncher><Link href="/suppliers">供应商档案</Link><Link href="/inventory">仓库与物料</Link><p>先保存原填写 核对后执行 采购单审核后再登记到货</p></div>
    <ProcurementCommandWorkbench data={data} />
    <ProcurementReconciliationWorkbench data={data} />
  </>;
}

export function PurchaseOrderActions({ data, order }: { data: ProcurementWorkspaceView; order: InventoryPurchaseOrderView }) {
  const [action, setAction] = useState<"receive" | "incoming" | "invoice">();
  const [message, setMessage] = useState("");
  const router = useRouter();
  const search = useSearchParams(), reconciliationQuery = new URLSearchParams(search.toString()); reconciliationQuery.set("invoiceOrder", order.id);
  const access = useErpAccess();
  const editable = ["draft", "rejected"].includes(order.status);
  const receivable = ["approved", "partially_received", "reconciliation_required"].includes(order.status);
  const saved = () => { setMessage(action === "receive" ? "收货已入账" : "已保存"); setAction(undefined); router.refresh(); };
  return <>
    <div className="record-toolbar" style={{ margin: 0 }}>
      {editable && <><ProcurementCycleLauncher data={data} kind="purchase_revise" targetId={order.id}>修订采购草稿</ProcurementCycleLauncher><ProcurementCycleLauncher data={data} kind="purchase_review" targetId={order.id}>审核采购单</ProcurementCycleLauncher></>}
      <button onClick={() => setAction("incoming")}>{receivable ? "来料检验与入账" : "来料记录"}</button>
      {!editable && order.status !== "cancelled" && <button type="button" disabled={!access.can(Permission.ProcurementWrite)} onClick={() => setAction("invoice")}>登记实际发票</button>}
      <Link href={`/procurement?${reconciliationQuery}#invoice-reconciliation-workbench`}>核对发票差异</Link>
      {order.status === "received" && <span>收货流程已完成</span>}
    </div>
    {message && <small role="status">{message}</small>}
    {action === "receive" && <PurchaseReceipt data={data} order={order} onClose={() => setAction(undefined)} onSaved={saved} />}
    {action === "incoming" && <IncomingInspectionDialog purchaseOrderId={order.id} onClose={() => setAction(undefined)} onChanged={() => router.refresh()} onLegacyReceipt={() => setAction("receive")} />}
    {action === "invoice" && <ProcurementInvoiceForm data={data} order={order} onClose={() => setAction(undefined)} onCompleted={() => setMessage("实际发票登记结果已确认")} onChanged={() => router.refresh()} />}
  </>;
}

function PurchaseReceipt({ data, order, onClose, onSaved }: { data: ProcurementWorkspaceView; order: InventoryPurchaseOrderView; onClose: () => void; onSaved: () => void }) {
  const [receivedAt] = useState(() => localDateTime());
  const [lotPrefix] = useState(() => `LOT-${crypto.randomUUID().slice(0, 8).toUpperCase()}`);
  const receipts = data.receipts.filter((receipt) => receipt.purchaseOrderId === order.id);
  return <RecordDialog title={`登记收货 ${order.code}`} onClose={onClose}><RecordForm operation="purchase.receive" id={order.id} onCancel={onClose} onSaved={onSaved} submitLabel="确认收货并入库"
    description="按实际验收结果填写。本次实收数量会写入对应物料、库位和批次；采购金额不随收货改写。"
    build={(form) => {
      const lines = order.lines.map((line, index) => {
        const received = NonnegativeStockQuantitySchema.parse(formText(form, `received-${index}`) || "0");
        const rejected = NonnegativeStockQuantitySchema.parse(formText(form, `rejected-${index}`) || "0");
        if (!stockQuantityMatchesUnit(received, line.unit) || !stockQuantityMatchesUnit(rejected, line.unit)) throw new Error("件、对和套的收货数量必须为整数");
        return { lineKey: line.lineKey, receivedQuantity: received, rejectedQuantity: rejected, rejectionReasonCode: compareStockQuantity(rejected, 0) > 0 ? formText(form, `reason-${index}`) || null : null, lotCode: compareStockQuantity(received, 0) > 0 ? formText(form, `lot-${index}`).toUpperCase() : null, expiresAt: null };
      }).filter((line) => compareStockQuantity(line.receivedQuantity, 0) !== 0 || compareStockQuantity(line.rejectedQuantity, 0) !== 0);
      if (!lines.length) throw new Error("请至少填写一行实收或拒收数量。");
      return { expectedVersion: order.currentVersion, receivedAt: formDate(form, "receivedAt"), externalReference: formText(form, "reference") || null, lines };
    }}>
    <div className="record-grid"><Field label="收货时间"><input type="datetime-local" required name="receivedAt" defaultValue={receivedAt} /></Field><Field label="送货单号（可选）"><input name="reference" maxLength={200} /></Field></div>
    {order.lines.map((line, index) => {
      const previous = receipts.flatMap((receipt) => receipt.lines).filter((row) => row.lineKey === line.lineKey);
      const received = sumStockQuantities(previous.map(row => row.receivedQuantity));
      const rejected = sumStockQuantities(previous.map(row => row.rejectedQuantity));
      const pending = subtractStockQuantity(line.quantity, sumStockQuantities([received, rejected]));
      return <section className="record-line" key={line.lineKey} aria-label={`收货明细 ${index + 1}`}><header><strong>{data.stockItems.find((item) => item.id === line.stockItemId)?.name ?? line.lineKey}</strong></header>
        <ProcurementMeasure quantity={line.quantity} unit={line.unit} stockBasis={line.stockBasis} />
        <p className="record-help">累计实收 {formatStockQuantity(received)} · 累计拒收 {formatStockQuantity(rejected)} · 待核对 {compareStockQuantity(pending, 0) < 0 ? "0" : formatStockQuantity(pending)} {unitNames[line.unit]} · {data.locations.find((item) => item.id === line.destinationLocationId)?.name}</p>
        <div className="record-grid"><Field label="本次实收数量" help={`采购单位 ${unitNames[line.unit]} 最多9位小数`}><input name={`received-${index}`} type="text" inputMode="decimal" maxLength={41} defaultValue="0" /></Field><Field label="本次拒收数量" help={`采购单位 ${unitNames[line.unit]} 最多9位小数`}><input name={`rejected-${index}`} type="text" inputMode="decimal" maxLength={41} defaultValue="0" /></Field>
          <Field label="批次编码" help="实收时必填；每次收货使用新的批次。"><input name={`lot-${index}`} maxLength={64} defaultValue={`${lotPrefix}-${index + 1}`} /></Field><Field label="拒收原因"><select name={`reason-${index}`} defaultValue=""><option value="">无拒收</option><option value="QUALITY_FAILED">质量不合格</option><option value="WRONG_ITEM">物料不符</option><option value="DAMAGED">破损</option></select></Field></div>
      </section>;
    })}
  </RecordForm></RecordDialog>;
}

