"use client";
import { useState, type FormEvent } from "react";
import { CalendarClock, CircleAlert, PackageCheck, Pause, RefreshCw, Search, SlidersHorizontal } from "lucide-react";
import { ORDER_LIFECYCLE_LABELS, type OrderQueueCounts } from "@yummyai/contracts/order/workbench";
import type { OrderCenterOptions } from "@yummyai/contracts/order/workspace";
import { OrderDateRange } from "./order-date-range";

export const legacyWorkflowFilters = [
  "stage", "preparation", "artwork", "production", "proof", "shipment", "afterSales",
  "labelStatus", "workView",
] as const;
const attentionChoices = [
  ["platform_deadline_missing", "平台交期待核对", CalendarClock],
  ["platform_overdue", "平台已超期", CircleAlert],
  ["overdue", "内部计划超期", CalendarClock],
  ["source_changed", "来源有更新", RefreshCw],
  ["held", "已暂停", Pause],
  ["platform_confirmation_pending", "平台发货待确认", PackageCheck],
] as const;

export function OrderLifecycleSummary({ counts }: { counts?: OrderQueueCounts }) {
  return <div className="oc-lifecycle-summary" aria-label="整单状态统计">
    {Object.entries(ORDER_LIFECYCLE_LABELS).map(([key, title]) => <span key={key}>
      {title} <b>{counts?.orderStatuses?.[key as keyof typeof ORDER_LIFECYCLE_LABELS] ?? "—"}</b>
    </span>)}
    <small>按整单统计 · 全部商品共同决定订单进度</small>
  </div>;
}

export function OrderWorkbenchFilters({ query, options, disabled, onSubmit, onClear, onAttentionChange }: {
  query: string; options: OrderCenterOptions | null; disabled: boolean;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void; onClear: () => void;
  onAttentionChange?: (attention: string | null) => void;
}) {
  const params = new URLSearchParams(query);
  const advanced = ["sku", "spu", "printSku", "specification", "platform", "productType", "dateField", "orderNumbers", "archived"];
  const count = advanced.filter(key => !!params.get(key) && !["active", "placed"].includes(params.get(key)!)).length;
  const [open, setOpen] = useState(count > 0);
  return <form className="oc-workbench-filters" onSubmit={onSubmit}>
    <fieldset disabled={disabled}>
      <div className="oc-filter-primary">
        <label className="oc-search"><span>搜索订单</span><div><Search size={15} />
          <input name="q" defaultValue={params.get("q") ?? ""} placeholder="订单号 / 商品 / 物流单号" />
        </div></label>
        <FilterSelect name="accountId" title="店铺" value={params.get("accountId")}
          choices={options?.stores.map(store => [store.id, store.displayName]) ?? []} disabled={!options} />
        <FilterSelect name="orderStatus" title="订单状态" value={params.get("orderStatus")} choices={Object.entries(ORDER_LIFECYCLE_LABELS)} />
        <div className="oc-basic-date"><span>{({ placed: "下单日期", imported: "导入日期", due: "内部截止日期", dispatched: "发货日期" } as Record<string, string>)[params.get("dateField") ?? "placed"]}</span>
          <OrderDateRange from={params.get("from") ?? ""} to={params.get("to") ?? ""} />
        </div>
        <div className="oc-filter-buttons">
          <button className="oc-button primary" type="submit">查询</button>
          <button className="oc-button" type="button" onClick={onClear}>重置</button>
          <button className="oc-button" type="button" aria-expanded={open} onClick={() => setOpen(!open)}>
            <SlidersHorizontal size={14} />更多筛选{count ? ` (${count})` : ""}
          </button>
        </div>
      </div>
      <input type="hidden" name="caseScope" value={params.get("caseScope") ?? ""} />
      <input type="hidden" name="attention" value={params.get("attention") ?? ""} />
      <input type="hidden" name="timeZone" value={Intl.DateTimeFormat().resolvedOptions().timeZone} />
      <div className="oc-operations-quick-filters" role="group" aria-label="优先处理筛选">
        <span>优先处理</span>
        <button className="oc-button" type="button" aria-pressed={!params.get("attention")} disabled={!onAttentionChange}
          onClick={() => onAttentionChange?.(null)}>不限关注条件</button>
        {attentionChoices.map(([value, label, Icon]) => <button key={value} className="oc-button" type="button"
          aria-pressed={params.get("attention") === value} disabled={!onAttentionChange}
          onClick={() => onAttentionChange?.(params.get("attention") === value ? null : value)}><Icon size={14} aria-hidden="true" />{label}</button>)}
      </div>
      <div className="oc-filter-advanced" hidden={!open}>
        <label>商品 SKU<input name="sku" defaultValue={params.get("sku") ?? ""} placeholder="输入 SKU" /></label>
        <label>产品 SPU<input name="spu" defaultValue={params.get("spu") ?? ""} placeholder="已绑定 SPU 编码" /></label>
        <label>印花 SKU<input name="printSku" defaultValue={params.get("printSku") ?? ""} placeholder="已绑定印花编码" /></label>
        <label>规格<input name="specification" defaultValue={params.get("specification") ?? ""} placeholder="已绑定规格名称" /></label>
        <FilterSelect name="platform" title="平台" value={params.get("platform")} choices={[["amazon", "Amazon"], ["etsy", "Etsy"]]} />
        <FilterSelect name="productType" title="商品类型" value={params.get("productType")}
          choices={[["shaped_pillow", "异形抱枕"], ["tire_cover", "轮胎罩"], ["rectangular_print", "平面印刷"]]} />
        <FilterSelect name="dateField" title="时间类型" value={params.get("dateField") ?? "placed"}
          choices={[["placed", "平台下单时间"], ["imported", "导入时间"], ["due", "内部截止时间"], ["dispatched", "最近发货时间"]]} all={false} />
        <FilterSelect name="archived" title="记录范围" value={params.get("archived") ?? "active"}
          choices={[["active", "正常订单"], ["only", "已归档记录"]]} all={false} />
        <label className="oc-batch-search">批量订单号<textarea name="orderNumbers" defaultValue={params.get("orderNumbers") ?? ""}
          placeholder="每行一个订单号，也支持逗号分隔；最多 100 个" rows={2} /></label>
      </div>
    </fieldset>
  </form>;
}

function FilterSelect({ name, title, value, choices, disabled = false, all = true }: {
  name: string; title: string; value: string | null; choices: string[][]; disabled?: boolean; all?: boolean;
}) {
  const [selected, setSelected] = useState(value ?? "");
  return <label>{title}<select name={name} aria-label={title} value={selected}
    onChange={event => setSelected(event.target.value)} disabled={disabled}>
    {all && <option value="">全部</option>}
    {value && !choices.some(([key]) => key === value) && <option value={value}>所选{title}暂不可用</option>}
    {choices.map(([key, label]) => <option key={key} value={key}>{label}</option>)}
  </select>{disabled && <input type="hidden" name={name} value={selected} />}</label>;
}
