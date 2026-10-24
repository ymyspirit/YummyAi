import type { WholeOrderDetailView } from "@yummyai/contracts/order/whole-detail";
import type { OrderWorkListItem, OrderWorkspaceModule } from "@yummyai/contracts/order/workspace";
import { orderOperatorTask } from "@yummyai/contracts/order/workbench";

export function orderReviewQueue(items: OrderWorkListItem[], selectedId?: string) {
  const seen = new Set<string>();
  return items.filter(item => {
    if (seen.has(item.orderId)) return false;
    seen.add(item.orderId); return true;
  }).map(item => items.find(row => row.id === selectedId && row.orderId === item.orderId)?.id ?? item.id).slice(0, 100);
}

export type WholeOrderNextStep = {
  title: string; description: string; action: string; module: OrderWorkspaceModule;
  lineId: string; section: "item" | "delivery" | "operation" | "refresh";
  target?: "production-release" | "production-progress" | "production-quality" | "shipment-package" | "shipment-review" | "shipment-dispatch" | "platform-confirmation" | "after-sales-create";
};
export function wholeOrderNextStep(view: WholeOrderDetailView): WholeOrderNextStep {
  const first = view.items[0]!.line;
  const step = (title: string, description: string, action: string, module: OrderWorkspaceModule, section: WholeOrderNextStep["section"] = "operation", lineId = first.id): WholeOrderNextStep => ({ title, description, action, module, section, lineId });
  if (first.orderStatus === "voided") return step("整单已作废", "原稿、工厂记录和运单继续保留。", "查看订单记录", "orders", "item");
  const priorities = ["held", "verify_source", "complete_information", "production_attention", "design_attention", "customer_changes", "after_sales", "review_order", "dispatch_design", "review_artwork", "customer_proof", "waiting_design"];
  for (const key of priorities) {
    const item = view.items.find(item => orderOperatorTask(item.line).key === key);
    if (item) {
      const task = orderOperatorTask(item.line);
      return step(task.title, `${item.line.externalLineId || item.line.skuCode || "本单商品"}：${task.description}`, task.action, task.module, "item", item.line.id);
    }
  }
  const plan = view.fulfillment.data;
  if (!plan) return step("先重新核对整单", view.fulfillment.error ?? "整单操作条件尚未读取，暂不能判断下一步。", "重新读取整单", "orders", "refresh");
  if (plan.platformConfirmationPending) return { ...step("核对平台发货确认", "整单已实际交运，按平台真实确认结果登记依据。", "登记平台确认", "shipments"), target: "platform-confirmation" };
  if (plan.orderStatus === "shipped") return step("整单已出库", "运单已集中在下方，可查看实际物流和售后记录。", "查看发货记录", "shipments");
  if (plan.shipmentIds.length && !view.shipments.data) return step("先读取运单记录", view.shipments.error ?? "包裹记录尚未读取，暂不能判断审核和出库进度。", "重新读取整单", "shipments", "refresh");
  if (plan.items.every(item => item.readyQuantity >= item.quantity)) {
    const pending = view.shipments.data?.find(row => !["cancelled", "dispatched", "completed"].includes(row.shipment.status));
    return pending ? pending.shipment.approvedVersionNumber === pending.shipment.currentVersionNumber
      ? { ...step("确认整单实际出库", "核对一包内的全部抱枕及运单，工厂实际交运后登记凭证。", "确认整单出库", "shipments"), target: "shipment-dispatch" }
      : { ...step("审核整单包裹", "核对本单全部抱枕、物流单号和收件信息。", "审核整单包裹", "shipments"), target: "shipment-review" }
      : { ...step("准备整单发货", "本单全部抱枕已完工并通过质检，填写已有运单后统一打包。", "填写整单运单", "shipments"), target: "shipment-package" };
  }
  const productions = plan.items.map(item => item.production);
  if (productions.every(row => row === null)) {
    const missingFile = view.items.find(item => !item.artwork.data?.productionFile);
    if (missingFile) return step(missingFile.artwork.data?.productionPending ? "等待正式生产文件" : "补齐正式生产文件", `${missingFile.line.externalLineId} 的审核稿尚无可交付的正式文件。`, "查看本件制图", "artwork", "item", missingFile.line.id);
    return { ...step(plan.factories.length ? "安排整单生产" : "核对工厂承接条件", plan.factories.length ? "本单审核稿与正式文件已齐，选择能承接全部抱枕的同一工厂。" : "正式文件已齐，当前没有满足全部商品要求的同一工厂，请查看整单生产中的承接条件。", plan.factories.length ? "安排整单生产" : "查看承接条件", "production"), target: "production-release" };
  }
  if (!view.production.data) return step("先读取生产记录", view.production.error ?? "生产记录尚未读取。", "重新读取整单", "production", "refresh");
  const currentRecords = productions.map(production => view.production.data!.find(record => record.productionOrder.id === production?.id));
  if (currentRecords.some(record => !record?.deliveryReceipt?.factoryErp?.bindingReleased &&
    (record?.deliveryReceipt?.factoryErp?.voidSummary?.pending ?? (record?.deliveryReceipt?.factoryErp?.exception ? 1 : 0)) > 0))
    return step("核对工厂作废异常", "工厂表中存在作废记录 原订单与生产未自动取消 请核对实际情况。", "查看工厂原表与绑定", "production", "delivery");
  if (currentRecords.some(record => !record?.deliveryReceipt?.factoryErp?.bindingReleased && (record?.deliveryReceipt?.factoryErp?.voidSummary?.requiresOrderHandling ?? 0) > 0))
    return step("处理工厂作废后续", "原作废已由操作者核对 订单取消 停做与其他实际处理仍须按原业务记录确认。", "查看生产与订单处理", "production", "delivery");
  if (currentRecords.length && currentRecords.every(record => !record?.deliveryReceipt?.factoryErp?.bindingReleased && record?.deliveryReceipt?.factoryErp?.status === "shipped"))
    return step("核对工厂发货凭据", "工厂表已显示本单完整组发货 内部质检 实际交运和平台确认仍按真实凭据核对。", "查看工厂发货记录", "production", "delivery");
  if (productions.some(row => row === null) || new Set(productions.map(row => row?.status)).size > 1) return step("核对整单生产进度", "各商品记录不一致，请按真实工厂回执核对，已有历史继续保留。", "查看生产记录", "production");
  const status = productions[0]!.status;
  if (status === "planned") return productions.every(row => view.production.data!.some(record => record.productionOrder.id === row?.id && !!record.deliveryReceipt))
    ? { ...step("交付整单文件并登记发送", "整单交付包已生成；下载交给工厂后，按实际发送时间登记。", "登记整单发送工厂", "production"), target: "production-progress" }
    : step("下载整单生产文件", "交付包默认包含本单全部正式文件；下载交给工厂后登记真实发送记录。", "准备整单文件", "production", "delivery");
  if (status === "submitted" || status === "acknowledged") return step("跟进工厂排产与发货", "实际提交成功后按默认已排产 用工厂 Excel 或 CSV 核对后续状态。", "导入或核对工厂状态", "production", "delivery");
  if (status === "in_production") return { ...step("跟进整单生产完工", "等待本单所有抱枕制作完成，再按实际结果登记。", "打开完工登记", "production"), target: "production-progress" };
  if (status === "completed") return { ...step("检查本单全部抱枕", "整单已完工，核对全部商品并记录真实质检结果后才可发货。", "登记整单质检", "production"), target: "production-quality" };
  return step("核对工厂异常", "查看工厂与生产记录，再按实际情况处理。", "查看生产记录", "production");
}
