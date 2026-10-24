import type { BusinessTaskStage, BusinessTaskState, BusinessTaskView } from "@yummyai/contracts/operations/business-task";
import type { WholeOrderDetailView } from "@yummyai/contracts/order/whole-detail";
import type { OrderDesignAgentRunView } from "@yummyai/contracts/order/design-agent";
import type { LogisticsTaskView } from "@yummyai/contracts/logistics";
import { orderOperatorTask } from "@yummyai/contracts/order/workbench";

type Section<T> = { data: T | null; error: string | null };
export function aggregateTaskState(states: BusinessTaskState[]): BusinessTaskState {
  if (!states.length) return "pending";
  for (const state of ["unavailable", "blocked", "working", "waiting", "pending"] as const) if (states.includes(state)) return state;
  return states.every(state => state === "cancelled") ? "cancelled" : "done";
}

/** Read-only projection. Evidence, not model prose or label creation, advances stages. */
export function projectOrderTask(input: {
  whole: WholeOrderDetailView; logistics: Section<LogisticsTaskView[]>;
  design: Section<Array<OrderDesignAgentRunView | null>>;
  delivery: { state: BusinessTaskState; detail: string; href: string; evidence: Array<{ label: string; value: string }> };
}): BusinessTaskView {
  const { whole, logistics, design, delivery } = input, lines = whole.items.map(item => item.line), first = lines[0]!;
  const href = (module: string, line = first.id) => `/${module === "artwork" ? "order-artwork" : module}?order=${whole.orderId}&line=${line}`;
  const tasks = lines.map(line => ({ line, task: orderOperatorTask(line) }));
  const summarize = (passed: number) => `${passed} / ${lines.length} 个商品已满足本环节条件`;
  const stage = (key: string, label: string, states: BusinessTaskState[], detail: string, url: string, action: string, evidence: BusinessTaskStage["evidence"] = []): BusinessTaskStage => ({ key, label, state: aggregateTaskState(states), detail, href: url, action, evidence });
  const intake = tasks.filter(({ task }) => ["held", "verify_source", "complete_information", "review_order", "dispatch_design"].includes(task.key));
  const stages: BusinessTaskStage[] = [
    stage("intake", "审单与制作依据", lines.map(line => line.sourceChanged || line.held ? "blocked" : line.preparation === "pushed" ? "done" : "waiting"),
      intake[0]?.task.description ?? summarize(lines.filter(line => line.preparation === "pushed").length), href("orders", intake[0]?.line.id), "核对订单资料",
      lines.map(line => ({ label: line.externalLineId || "订单商品", value: `资料 V${line.revision}` }))),
    stage("artwork", "制作与技术检查", lines.map(line => ["in_review", "approved"].includes(line.artwork) ? "done" : line.designRunStatus === "needs_attention" || line.artwork === "changes_requested" ? "blocked" : ["queued", "running"].includes(line.designRunStatus ?? "") ? "working" : "pending"),
      "按订单固定配方制作，修正与恢复沿用原任务", href("artwork", tasks.find(({ task }) => ["design_attention", "waiting_design", "customer_changes"].includes(task.key))?.line.id), "查看制作与检查",
      (design.data ?? []).flatMap(run => run ? [{ label: `制作任务 ${run.id.slice(-8)}`, value: `${run.recipeVersion} / ${run.ruleSnapshot ? "已有固定规则快照" : "旧任务缺少规则快照"}` }] : [])),
    stage("review", "审核与客户校样", whole.items.map(item => item.artwork.error ? "unavailable" : item.artwork.data?.approved && (item.line.proof === "not_required" || item.line.proof === "approved" && item.line.proofVersionCurrent === true) ? "done" : "waiting"),
      "审核必须对应当前制作版本，客户校样沿用订单要求", href("artwork"), "查看审核条件"),
    stage("files", "正式生产文件", whole.items.map(item => item.artwork.error ? "unavailable" : item.artwork.data?.productionFile ? "done" : item.artwork.data?.productionPending ? "working" : "pending"),
      summarize(whole.items.filter(item => item.artwork.data?.productionFile).length), href("artwork", whole.items.find(item => !item.artwork.data?.productionFile)?.line.id), "查看正式文件",
      whole.items.flatMap(item => item.artwork.data ? [{ label: item.line.externalLineId || "制作稿", value: `制作 V${item.artwork.data.versionNumber}${item.artwork.data.productionFile ? " / 已有正式文件" : " / 正式文件待准备"}` }] : [])),
    stage("schedule", "工厂与生产排期", whole.fulfillment.data ? whole.fulfillment.data.items.map(item => item.production ? "done" : "waiting") : ["unavailable"],
      whole.fulfillment.error ?? "确认实际工厂、数量和预计完工时间", href("production"), "安排生产"),
    stage("logistics", "物流与面单", logistics.error ? ["unavailable"] : logistics.data?.length ? logistics.data.map(task => task.status === "completed" ? "done" : ["attention", "reconciliation_required"].includes(task.status) ? "blocked" : task.status === "cancelled" ? "cancelled" : "working") : ["pending"],
      logistics.error ?? "按已确认包装、交期与预算执行；结果不确定时查询原任务", logistics.data?.find(task => ["attention", "reconciliation_required"].includes(task.status)) ? `/logistics?task=${logistics.data.find(task => ["attention", "reconciliation_required"].includes(task.status))!.id}` : `/logistics?orderId=${whole.orderId}`, "处理物流任务",
      (logistics.data ?? []).map(task => ({ label: `${task.factoryName} / ${task.id.slice(-8)}`, value: task.status === "completed" ? "面单准备完成" : task.status === "reconciliation_required" ? "结果待核对" : "进入原任务核对" }))),
    stage("delivery", "工厂文件交付", [delivery.state], delivery.detail, delivery.href, "查看交付与回执", delivery.evidence),
    stage("quality", "生产与质检", whole.fulfillment.data ? whole.fulfillment.data.items.map(item => item.readyQuantity >= item.quantity ? "done" : item.production?.status === "quality_hold" || item.production?.status === "failed" ? "blocked" : item.production ? "working" : "pending") : ["unavailable"],
      "工厂完工与全部数量通过质检后才可出库", href("production"), "核对生产与质检"),
    stage("shipment", "实际交运与平台确认", whole.fulfillment.data ? [whole.fulfillment.data.orderStatus === "shipped" && !whole.fulfillment.data.platformConfirmationPending ? "done" : whole.fulfillment.data.platformConfirmationPending ? "waiting" : "pending"] : ["unavailable"],
      "依据真实交接记录与平台确认，面单生成不会推进出库", href("shipments"), "核对实际发货"),
  ];
  const notices = [whole.fulfillment.error, logistics.error, design.error].filter((text): text is string => !!text);
  const unavailable = lines.some(line => line.held || line.archivedAt || line.sourceChanged);
  const cancelled = lines.some(line => line.orderStatus === "voided");
  if (unavailable) notices.push("订单已暂停、归档或来源变化，请在原业务页核对后继续");
  const runs = (design.data ?? []).filter((run): run is OrderDesignAgentRunView => !!run);
  const complete = !design.error && runs.length === lines.length;
  const steps = runs.flatMap(run => run.steps);
  const checked = steps.filter(step => step.key === "preflight" && step.status === "completed");
  const firstPassed = runs.filter(run => run.steps.some(step => step.key === "preflight" && step.status === "completed" && step.attempt === 1) && !run.qualityDiagnostics.some(issue => issue.severity === "error" || issue.severity === "manual"));
  return {
    id: whole.orderId, kind: "order", title: first.externalOrderId, goal: "从订单资料推进至工厂交付、质检与实际发货",
    state: cancelled ? "cancelled" : unavailable ? "blocked" : aggregateTaskState(stages.map(stage => stage.state)), stages, notices,
    metrics: [
      { key: "first_pass", label: "制图首次检查通过", value: complete && checked.length === runs.length ? `${firstPassed.length} / ${runs.length}` : null, note: "最近制图任务首次 preflight 完成且无错误或待人工判定项，不代表运营审核通过" },
      { key: "retries", label: "制图重试次数", value: design.error || !runs.length ? null : String(steps.reduce((sum, step) => sum + Math.max(0, step.attempt - 1), 0)), note: `覆盖 ${runs.length} / ${lines.length} 个商品的最近制图任务` },
      { key: "recovery", label: "人工恢复记录", value: design.error || !runs.length ? null : String(steps.filter(step => step.responseRecovery).length), note: "仅统计有凭证的模型结果人工恢复，其他人工操作未纳入" },
      { key: "cost", label: "制图已回报费用", value: complete && runs.every(run => run.actualCostUsd !== null) ? `${runs.reduce((sum, run) => sum + run.actualCostUsd!, 0).toFixed(4)} USD` : null, note: "最近制图任务的渠道回报费用；缺少费用或任务时不补零" },
      { key: "duration", label: "已记录制图执行耗时", value: design.error || !steps.some(step => step.startedAt && step.completedAt) ? null : `${Math.round(steps.reduce((sum, step) => sum + (step.startedAt && step.completedAt ? Math.max(0, Date.parse(step.completedAt) - Date.parse(step.startedAt)) : 0), 0) / 1000)} 秒`, note: "已结束步骤的记录耗时合计，排队、等待审核及未记录的早期重试不计入" },
    ],
  };
}
