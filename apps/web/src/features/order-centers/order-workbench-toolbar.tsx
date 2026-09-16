"use client";
import { useState, type FormEvent } from "react";
import { Search, SlidersHorizontal } from "lucide-react";
import {
  ORDER_QUEUE_LABELS,
  ORDER_LABEL_LABELS,
  type OrderQueueCounts,
  type OrderQueueStage,
} from "@yummyai/contracts/order/workbench";
import type { OrderCenterOptions } from "@yummyai/contracts/order/workspace";
import { OrderDateRange } from "./order-date-range";

const visibleStages: OrderQueueStage[] = [
  "pending_review",
  "needs_information",
  "ready_to_push",
  "queued",
  "in_progress",
  "in_review",
  "approved",
  "ready_to_ship",
];
export function OrderQueueBar({
  counts,
  stage,
  attention,
  missingLabels,
  disabled,
  onSelect,
  onAttention,
  onMissingLabels,
}: {
  counts?: OrderQueueCounts;
  stage: string | null;
  attention: string | null;
  missingLabels: boolean;
  disabled: boolean;
  onSelect: (value: string | null) => void;
  onAttention: (value: string | null) => void;
  onMissingLabels: (value: boolean) => void;
}) {
  const displayed = visibleStages;
  return (
    <div className="oc-queue-region">
      <div className="oc-queue-caption">
        <button
          type="button"
          className={`oc-text-button${!stage ? " active" : ""}`}
          disabled={disabled}
          onClick={() => onSelect(null)}
        >
          全部 <b>{counts?.total ?? "—"}</b>
        </button>
        <span>按当前筛选统计 · 单位：商品行</span>
      </div>
      <nav className="oc-queue-counts" aria-label="订单状态统计">
        {displayed.map((value) => (
          <button
            type="button"
            key={value}
            disabled={disabled}
            aria-label={ORDER_QUEUE_LABELS[value]}
            aria-pressed={stage === value}
            className={stage === value ? "active" : ""}
            onClick={() => onSelect(value)}
          >
            <span>{ORDER_QUEUE_LABELS[value]}</span>
            <strong>{counts?.stages[value] ?? "—"}</strong>
          </button>
        ))}
      </nav>
      <div className="oc-extra-queues" aria-label="其他环节与异常筛选">
        {(["changes_requested", "production", "shipped", "cancelled"] as const).map((value) => (
          <button
            type="button"
            key={value}
            disabled={disabled}
            className={`oc-text-button${stage === value ? " active" : ""}`}
            aria-pressed={stage === value}
            onClick={() => onSelect(value)}
          >
            {ORDER_QUEUE_LABELS[value]} <b>{counts?.stages[value] ?? "—"}</b>
          </button>
        ))}
        <button
          type="button"
          disabled={disabled}
          className={`oc-text-button${missingLabels ? " active" : ""}`}
          aria-pressed={missingLabels}
          onClick={() => onMissingLabels(!missingLabels)}
        >
          缺少面单 <b>{counts?.missingLabels ?? "—"}</b>
        </button>
        {(
          [
            ["held", "已暂停", counts?.held],
            ["overdue", "已超期", counts?.overdue],
            ["source_changed", "资料有更新", counts?.sourceChanged],
          ] as const
        ).map(([value, title, count]) => (
          <button
            key={value}
            type="button"
            disabled={disabled}
            className={`oc-text-button${attention === value ? " active" : ""}`}
            aria-pressed={attention === value}
            onClick={() => onAttention(attention === value ? null : value)}
          >
            {title} <b>{count ?? "—"}</b>
          </button>
        ))}
      </div>
    </div>
  );
}

export function OrderWorkbenchFilters({
  query,
  options,
  disabled,
  onSubmit,
  onClear,
}: {
  query: string;
  options: OrderCenterOptions | null;
  disabled: boolean;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onClear: () => void;
}) {
  const params = new URLSearchParams(query);
  const advanced = [
    "platform",
    "spu",
    "specification",
    "printSku",
    "designExecutor",
    "attention",
    "labelStatus",
    "orderNumbers",
    "preparation",
    "artwork",
    "production",
    "shipment",
    "proof",
    "afterSales",
    "archived",
  ];
  const count = advanced.filter((key) => !!params.get(key) && params.get(key) !== "active").length;
  const [open, setOpen] = useState(count > 0);
  return (
    <form className="oc-workbench-filters" onSubmit={onSubmit}>
      <fieldset disabled={disabled}>
        <div className="oc-filter-primary">
          <label className="oc-search">
            <span>搜索订单</span>
            <div>
              <Search size={15} />
              <input
                name="q"
                defaultValue={params.get("q") ?? ""}
                placeholder="订单号 / 商品 / 物流单号"
              />
            </div>
          </label>
          <FilterSelect
            name="accountId"
            title="店铺"
            value={params.get("accountId")}
            choices={options?.stores.map((s) => [s.id, s.displayName]) ?? []}
            disabled={!options}
          />
          <label>
            商品 SKU
            <input name="sku" defaultValue={params.get("sku") ?? ""} placeholder="输入 SKU" />
          </label>
          <FilterSelect
            name="stage"
            title="当前环节"
            value={params.get("stage")}
            choices={Object.entries(ORDER_QUEUE_LABELS)}
          />
          <FilterSelect
            name="dateField"
            title="时间类型"
            value={params.get("dateField") ?? "placed"}
            choices={[
              ["placed", "平台下单时间"],
              ["imported", "导入时间"],
              ["due", "内部截止时间"],
              ["dispatched", "最近交运时间"],
            ]}
            all={false}
          />
          <OrderDateRange from={params.get("from") ?? ""} to={params.get("to") ?? ""} />
          <div className="oc-filter-buttons">
            <button className="oc-button primary" type="submit">
              查询
            </button>
            <button className="oc-button" type="button" onClick={onClear}>
              重置
            </button>
            <button
              className="oc-button"
              type="button"
              aria-expanded={open}
              onClick={() => setOpen(!open)}
            >
              <SlidersHorizontal size={14} />
              更多筛选{count ? ` (${count})` : ""}
            </button>
          </div>
        </div>
        <input
          type="hidden"
          name="timeZone"
          value={Intl.DateTimeFormat().resolvedOptions().timeZone}
        />
        <div className="oc-filter-advanced" hidden={!open}>
          <FilterSelect
            name="platform"
            title="平台"
            value={params.get("platform")}
            choices={[
              ["amazon", "Amazon"],
              ["etsy", "Etsy"],
            ]}
          />
          <label>
            产品 SPU
            <input
              name="spu"
              defaultValue={params.get("spu") ?? ""}
              placeholder="已绑定 SPU 编码"
            />
          </label>
          <label>
            印花 SKU
            <input
              name="printSku"
              defaultValue={params.get("printSku") ?? ""}
              placeholder="已绑定印花编码"
            />
          </label>
          <label>
            规格
            <input
              name="specification"
              defaultValue={params.get("specification") ?? ""}
              placeholder="已绑定规格名称"
            />
          </label>
          <FilterSelect
            name="designExecutor"
            title="设计执行方式"
            value={params.get("designExecutor")}
            choices={[
              ["agent", "无人设计 Agent"],
              ["human", "美工设计"],
            ]}
          />
          <FilterSelect
            name="labelStatus"
            title="物流面单"
            value={params.get("labelStatus")}
            choices={Object.entries(ORDER_LABEL_LABELS).map(([k, v]) => [
              k,
              k === "missing" ? "缺少面单（含部分缺少）" : v,
            ])}
          />
          <FilterSelect
            name="attention"
            title="需要关注"
            value={params.get("attention")}
            choices={[
              ["held", "已暂停"],
              ["overdue", "内部截止已超期"],
              ["source_changed", "导入资料有变化"],
            ]}
          />
          <FilterSelect
            name="preparation"
            title="审单状态"
            value={params.get("preparation")}
            choices={[
              ["pending_review", "待审单"],
              ["needs_information", "待补资料"],
              ["ready_to_push", "待派发制图"],
              ["pushed", "已推送"],
            ]}
          />
          <FilterSelect
            name="artwork"
            title="制图状态"
            value={params.get("artwork")}
            choices={[
              ["not_pushed", "未推送"],
              ["queued", "待开始制图"],
              ["starting", "准备素材中"],
              ["in_progress", "制图中"],
              ["in_review", "待审图"],
              ["changes_requested", "需改图"],
              ["approved", "已审图"],
            ]}
          />
          <FilterSelect
            name="proof"
            title="客户确认"
            value={params.get("proof")}
            choices={[
              ["not_required", "无需确认"],
              ["pending", "待客户确认"],
              ["approved", "客户已确认"],
              ["changes_requested", "客户要求修改"],
            ]}
          />
          <FilterSelect
            name="production"
            title="生产状态"
            value={params.get("production")}
            choices={[
              ["not_released", "未下达"],
              ["planned", "待发送工厂"],
              ["submitted", "待工厂接单"],
              ["acknowledged", "工厂已接单"],
              ["in_production", "生产中"],
              ["awaiting_quality", "待质检"],
              ["quality_hold", "质检异常"],
              ["completed", "已完工"],
              ["partially_completed", "部分完工"],
              ["cancel_requested", "待确认停单"],
              ["cancelled", "已取消"],
              ["failed", "失败"],
            ]}
          />
          <FilterSelect
            name="shipment"
            title="发货状态"
            value={params.get("shipment")}
            choices={[
              ["unshipped", "未交运"],
              ["partial", "部分交运"],
              ["shipped", "已全部交运"],
            ]}
          />
          <FilterSelect
            name="afterSales"
            title="售后状态"
            value={params.get("afterSales")}
            choices={[
              ["open", "待处理"],
              ["awaiting_customer", "等客户回复"],
              ["awaiting_internal", "待内部处理"],
              ["approved", "方案已通过"],
              ["rejected", "已拒绝"],
              ["resolved", "已结案"],
              ["cancelled", "已取消"],
            ]}
          />
          <FilterSelect
            name="archived"
            title="记录范围"
            value={params.get("archived") ?? "active"}
            choices={[
              ["active", "正常订单"],
              ["only", "已归档记录"],
            ]}
            all={false}
          />
          <label className="oc-batch-search">
            批量订单号
            <textarea
              name="orderNumbers"
              defaultValue={params.get("orderNumbers") ?? ""}
              placeholder="每行一个订单号，也支持逗号分隔；最多 100 个"
              rows={2}
            />
          </label>
        </div>
      </fieldset>
    </form>
  );
}
function FilterSelect({
  name,
  title,
  value,
  choices,
  disabled = false,
  all = true,
}: {
  name: string;
  title: string;
  value: string | null;
  choices: string[][];
  disabled?: boolean;
  all?: boolean;
}) {
  const [selected, setSelected] = useState(value ?? "");
  return (
    <label>
      {title}
      <select
        name={name}
        aria-label={title}
        value={selected}
        onChange={(event) => setSelected(event.target.value)}
        disabled={disabled}
      >
        {all && <option value="">全部</option>}
        {value && !choices.some(([key]) => key === value) && (
          <option value={value}>所选{title}暂不可用</option>
        )}
        {choices.map(([key, label]) => (
          <option key={key} value={key}>
            {label}
          </option>
        ))}
      </select>
      {disabled && <input type="hidden" name={name} value={selected} />}
    </label>
  );
}
