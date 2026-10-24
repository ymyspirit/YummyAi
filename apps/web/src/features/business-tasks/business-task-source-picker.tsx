import type { FollowupSource } from "@yummyai/contracts/operations/followup";
export type BusinessTaskSource = "workflow" | "order" | "sales_plan" | FollowupSource;
export function BusinessTaskSourcePicker({
  value,
  disabled,
  onChange,
}: {
  value: BusinessTaskSource;
  disabled?: boolean;
  onChange(value: BusinessTaskSource): void;
}) {
  return (
    <label>
      业务对象
      <select
        aria-label="业务对象"
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value as BusinessTaskSource)}
      >
        <option value="workflow">工作流待办</option>
        <option value="order">订单与履约</option>
        <option value="sales_plan">商品上架</option>
        <option value="procurement_order">采购跟进</option>
        <option value="after_sales_case">售后跟进</option>
        <option value="order_exception">订单异常</option>
      </select>
    </label>
  );
}
