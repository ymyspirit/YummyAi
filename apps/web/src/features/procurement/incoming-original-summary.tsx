import type { PrepareIncomingCommand } from "@yummyai/contracts/procurement/incoming-command";
import type { IncomingWorkspaceView } from "@yummyai/contracts/procurement/incoming";
import { unitNames } from "../manual-operations/operation-types";
import { CriterionDescription } from "./incoming-operation-form";
import { formatStockQuantity } from "@yummyai/contracts/inventory/quantity";

export const incomingTime = (value: string) => new Date(value).toLocaleString("zh-CN", { hour12: false });

/** Human-readable original facts, without presenting transport JSON as a form. */
export function IncomingOriginalSummary({ original, workspace }: { original: PrepareIncomingCommand; workspace: IncomingWorkspaceView }) {
  const line = workspace.arrivals.flatMap(arrival => arrival.lines).find(item => item.id === original.targetId);
  const unit = line ? unitNames[line.unit] : "原实际批次单位当前不可读取 请核对";
  const location = (id: string) => {
    const row = workspace.locations.find(item => item.id === id);
    return row ? `${row.warehouseName} · ${row.name} · ${row.code}` : "此原库位当前未列在可用选项中 请核对";
  };
  switch (original.kind) {
    case "publish_standard": {
      const input = original.input;
      return <div className="incoming-original"><dl><dt>原标准</dt><dd>{input.title} · {input.code} · 依据 v{input.expectedVersion}</dd><dt>原来源</dt><dd>{input.sourceReference}</dd></dl>
        <ol>{input.criteria.map(row => <li key={row.code}><strong>{row.label} · {row.code}</strong><span><CriterionDescription criterion={row} /></span></li>)}</ol></div>;
    }
    case "record_arrival": {
      const input = original.input;
      return <div className="incoming-original"><dl><dt>到货编号</dt><dd>{input.code}</dd><dt>原采购版本</dt><dd>v{input.expectedPurchaseOrderVersion}</dd><dt>实际到货</dt><dd>{incomingTime(input.arrivedAt)}</dd><dt>原交接凭据</dt><dd>{input.externalReference}</dd></dl>
        <ol>{input.lines.map(row => <li key={row.lineKey}><strong>{row.lineKey} · 实际 {formatStockQuantity(row.quantity)} {unitNames[row.unit]}</strong><span>供应商原批号 {row.lotCode}</span><span>实际保管 {location(row.holdingLocationId)}</span><span>{row.expiresAt ? `有效期限 ${incomingTime(row.expiresAt)}` : "未声明有效期限"}</span></li>)}</ol></div>;
    }
    case "record_inspection": {
      const input = original.input;
      return <div className="incoming-original"><dl><dt>原检验修订</dt><dd>v{input.expectedInspectionVersion}</dd><dt>实际测量</dt><dd>{incomingTime(input.measuredAt)}</dd><dt>原实际批次单位</dt><dd>{unit}</dd><dt>原抽样数量</dt><dd>{formatStockQuantity(input.sampleQuantity)} {unit}</dd><dt>本次处置</dt><dd>接受 {formatStockQuantity(input.acceptedQuantity)} · 拒收 {formatStockQuantity(input.rejectedQuantity)} {unit}</dd>
        {input.rejectionReason && <><dt>拒收原因</dt><dd>{input.rejectionReason}</dd></>}{input.notes && <><dt>原说明</dt><dd>{input.notes}</dd></>}</dl>
        {input.readings.length ? <ol>{input.readings.map(row => <li key={row.criterionCode}><strong>{row.criterionCode}</strong><span>{row.value} {row.unit ?? ""}</span></li>)}</ol> : <p className="record-help">原填写未提供测量值</p>}</div>;
    }
    case "review_inspection": return <dl className="incoming-original"><dt>原检验修订</dt><dd>v{original.input.expectedInspectionVersion}</dd><dt>原核准决定</dt><dd>{original.input.decision === "approved" ? "批准本次检验处置" : "拒绝本次检验"}</dd><dt>原核准依据</dt><dd>{original.input.reason}</dd></dl>;
    case "post_inspection": return <dl className="incoming-original"><dt>原检验修订</dt><dd>v{original.input.expectedInspectionVersion}</dd><dt>原实际批次单位</dt><dd>{unit}</dd><dt>实际入账</dt><dd>{incomingTime(original.input.postedAt)}</dd><dt>本次接受</dt><dd>{formatStockQuantity(original.input.acceptedQuantity)} {unit} · {original.input.ownershipConfirmation ? "已确认商家实际接收并拥有" : "无接受库存"}</dd><dt>本次拒收</dt><dd>{formatStockQuantity(original.input.rejectedQuantity)} {unit} · {original.input.rejectionLocationId ? location(original.input.rejectionLocationId) : "无拒收保管"}</dd></dl>;
    case "return_rejected": return <dl className="incoming-original"><dt>原拒收处置</dt><dd>已绑定本批原处置</dd><dt>实际退回</dt><dd>{formatStockQuantity(original.input.quantity)} {unit} · {incomingTime(original.input.returnedAt)}</dd><dt>实际交接凭据</dt><dd>{original.input.externalReference}</dd><dt>实际退回原因</dt><dd>{original.input.reason}</dd></dl>;
  }
}
