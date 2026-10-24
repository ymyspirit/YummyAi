import { type Page } from "@playwright/test";
import { WholeOrderDetailViewSchema } from "@yummyai/contracts/order/whole-detail";
import { orderQueueStage, OrderQueueStageSchema, orderOperatorTask, orderOperatorException, orderLifecycleStatus, OrderLifecycleStatusSchema } from "@yummyai/contracts/order/workbench";
import {
  OrderWorkDetailViewSchema,
  SaveOrderWorkDraftInputSchema,
  OrderBulkPreviewInputSchema,
  type OrderWorkDetail,
} from "@yummyai/contracts/order/workspace";

// This suite owns its in-memory order transport. No customer order, factory,
// marketplace or AI provider is written. The real save boundary is exercised
// separately by order-workspace.integration.test.ts and order-centers.spec.ts.
export const id = (n: number) => `019f0000-0000-7000-8000-${n.toString().padStart(12, "0")}`;
const now = "2026-09-14T00:00:00.000Z";
const profile = {
  id: id(100),
  versionId: id(101),
  code: "SYNTHETIC-PROFILE",
  name: "Synthetic review profile",
  versionNumber: 1,
  productType: "tire_cover",
  projectId: id(102),
  sourceVersionId: id(103),
  instructions: "Synthetic fixture only",
  createdAt: now,
};
function detail(n: number): OrderWorkDetail {
  return OrderWorkDetailViewSchema.parse({
    line: {
      id: id(n),
      orderId: id(n + 20),
      externalOrderId: `SYNTHETIC-REVIEW-${n}`,
      externalLineId: "1",
      accountId: id(99),
      storeName: "Synthetic review store",
      platform: "amazon",
      skuCode: `SYNTHETIC-SKU-${n}`,
      title: `Synthetic custom order ${n}`,
      quantity: 1,
      providerStatus: "report_imported",
      sideState: null,
      placedAt: now,
      reportLineId: null,
      preparation: "pending_review",
      artwork: "not_pushed",
      proof: "not_required",
      production: "not_released",
      readyQuantity: 0,
      shippedQuantity: 0,
      afterSalesCount: 0,
      printSku: null,
      revision: 1,
      projectionVersion: 1,
      held: false,
      sourceChanged: false,
      dueAt: null,
      updatedAt: now,
      editorProjectId: null,
    },
    draft: {
      printProfileVersionId: profile.versionId,
      fields: [{ key: "name", label: "Customer name", kind: "text", value: `Synthetic name ${n}` }],
      images: [],
      instructions: `Original instructions ${n}`,
      customerApprovalRequired: false,
      dueAt: null,
    },
    profile,
    report: null,
    assets: [],
    events: [],
    versions: [],
  });
}
export async function fixture(page: Page, count = 3) {
  const records = Array.from({ length: count }, (_, n) => detail(n + 1));
  function refreshLifecycle() {
    const orders = new Map<string, typeof records>();
    for (const record of records) orders.set(record.line.orderId, [...(orders.get(record.line.orderId) ?? []), record]);
    for (const group of orders.values()) for (const record of group) Object.assign(record.line, {
      orderStatus: orderLifecycleStatus(group.map(item => item.line)), orderLineCount: group.length,
      orderQuantity: group.reduce((quantity, item) => quantity + item.line.quantity, 0),
    });
  }
  const saves: Array<ReturnType<typeof SaveOrderWorkDraftInputSchema.parse> & { lineId: string }> =
    [];
  const unexpectedWrites: string[] = [];
  let workspaceReads = 0;
  let failNext = false;
  let releaseSave: (() => void) | undefined;
  let pendingSave: Promise<void> | undefined;
  await page.route("**/api/ai-assists/**", (route) => route.fulfill({ json: [] }));
  await page.route("**/api/order-centers/**", async (route) => {
    refreshLifecycle();
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace("/api/order-centers/", "");
    if (path === "options")
      return route.fulfill({
        json: {
          profiles: [profile],
          stores: [],
          suppliers: [],
          standards: [],
          preferenceScope: "synthetic-review",
        },
      });
    if (path === "workspace") {
      workspaceReads += 1;
      const status = url.searchParams.get("preparation");
      const baseItems = records
        .filter((record) =>
          url.searchParams.get("archived") === "only"
            ? !!record.line.archivedAt
            : !record.line.archivedAt,
        )
        .filter((record) => !status || record.line.preparation === status)
        .map((record) => record.line)
        .filter(line => !url.searchParams.get("sku") || line.skuCode?.includes(url.searchParams.get("sku")!))
        .filter(
          (line) =>
            !url.searchParams.get("orderNumbers") ||
            url.searchParams
              .get("orderNumbers")!
              .split(/[\s,，;；]+/)
              .includes(line.externalOrderId),
        )
        .filter(
          (line) =>
            !url.searchParams.get("labelStatus") ||
            (url.searchParams.get("labelStatus") === "missing"
              ? ["missing", "partial"].includes(line.labelStatus ?? "")
              : line.labelStatus === url.searchParams.get("labelStatus")),
        );
      const stages = Object.fromEntries(
        OrderQueueStageSchema.options.map((stage) => [
          stage,
          baseItems.filter((line) => orderQueueStage(line) === stage).length,
        ]),
      );
      const filtered = baseItems.filter(
        (line) =>
          !url.searchParams.get("stage") || orderQueueStage(line) === url.searchParams.get("stage"),
      );
      const view = url.searchParams.get("workView");
      const items = filtered.filter(line => !url.searchParams.get("orderStatus") || line.orderStatus === url.searchParams.get("orderStatus"))
        .filter(line => view === "todo" ? orderOperatorTask(line).actionable
        : view === "waiting" ? !orderOperatorTask(line).actionable && !["complete", "cancelled", "archived"].includes(orderOperatorTask(line).key)
        : view === "exceptions" ? orderOperatorException(line) : true);
      const pageNumber = Number(url.searchParams.get("page") ?? 1),
        pageSize = Number(url.searchParams.get("pageSize") ?? 25);
      const groups = [...new Set(items.map((item) => item.orderId))];
      const visible = new Set(groups.slice((pageNumber - 1) * pageSize, pageNumber * pageSize));
      return route.fulfill({
        json: {
          items: items.filter((item) => visible.has(item.orderId)),
          total: items.length,
          groupTotal: groups.length,
          page: pageNumber,
          pageSize,
          counts: {
            orderStatuses: Object.fromEntries(OrderLifecycleStatusSchema.options.map(status => [status,
              new Set(baseItems.filter(line => line.orderStatus === status).map(line => line.orderId)).size])),
            operatorViews: {
              todo: baseItems.filter(line => orderOperatorTask(line).actionable).length,
              waiting: baseItems.filter(line => !orderOperatorTask(line).actionable && !["complete", "cancelled", "archived"].includes(orderOperatorTask(line).key)).length,
              exceptions: baseItems.filter(line => orderOperatorException(line)).length, all: baseItems.length,
            },
            total: baseItems.length,
            orders: new Set(baseItems.map((line) => line.orderId)).size,
            quantity: baseItems.reduce((n, line) => n + line.quantity, 0),
            stages,
            held: baseItems.filter((line) => line.held).length,
            overdue: 0,
            sourceChanged: baseItems.filter((line) => line.sourceChanged).length,
            missingLabels: baseItems.filter((line) =>
              ["missing", "partial"].includes(line.labelStatus ?? ""),
            ).length,
          },
        },
      });
    }
    if (path === "summaries") {
      const ids = request.postDataJSON().ids as string[];
      return route.fulfill({
        json: {
          items: records
            .filter((record) => ids.includes(record.line.id))
            .map((record) => ({
              id: record.line.id,
              revision: record.line.revision,
              sourceVersionId: null,
              printSku: record.line.printSku,
              spu: null,
              specification: null,
              designExecutor: record.draft.designExecutor ?? "agent",
              fields: record.draft.fields.map((field) => ({
                label: field.label,
                value: field.value ?? "",
              })),
              instructions: record.draft.instructions,
              images: [],
              blockers: [],
              error: null,
            })),
        },
      });
    }
    if (path === "selection")
      return route.fulfill({ json: { items: records.map((record) => record.line) } });
    if (path === "bulk/preview") {
      const input = OrderBulkPreviewInputSchema.parse(request.postDataJSON());
      return route.fulfill({
        json: {
          failures: [],
          items: records
            .filter((record) => input.ids.includes(record.line.id))
            .map((record) => ({
              line: record.line,
              changes: ["Synthetic verified change"],
              blockers: record.line.held ? ["订单已暂停或取消"] : [],
              action: null,
              save:
                record.line.held || input.operation === "check"
                  ? null
                  : SaveOrderWorkDraftInputSchema.parse({
                      expectedRevision: record.line.revision,
                      expectedProjectionVersion: record.line.projectionVersion,
                      expectedSourceVersionId: null,
                      draft: { ...record.draft, ...input.patch },
                      status:
                        input.operation === "ready_to_push"
                          ? "ready_to_push"
                          : input.operation === "needs_information"
                            ? "needs_information"
                            : "pending_review",
                      reason: input.reason,
                      idempotencyKey: crypto.randomUUID(),
                    }),
            })),
        },
      });
    }
    const lineId = path.split("/")[1];
    const record = records.find((record) => record.line.id === lineId);
    if (!record)
      return route.fulfill({ status: 404, json: { message: "Synthetic order not found" } });
    if (request.method() === "GET" && path.endsWith("/order-detail")) {
      const group = records.filter(item => item.line.orderId === record.line.orderId);
      return route.fulfill({ json: WholeOrderDetailViewSchema.parse({
        orderId: record.line.orderId,
        items: group.map(item => ({ line: item.line, summary: { data: {
          id: item.line.id, revision: item.line.revision, sourceVersionId: null, printSku: item.line.printSku,
          spu: null, specification: null, designExecutor: item.draft.designExecutor ?? "agent",
          fields: item.draft.fields.map(field => ({ label: field.label, value: field.value ?? "" })),
          instructions: item.draft.instructions, images: [], blockers: [], error: null,
        }, error: null }, artwork: { data: null, error: null } })),
        fulfillment: { data: {
          orderId: record.line.orderId, orderNumber: record.line.externalOrderId, orderStatus: record.line.orderStatus,
          quantity: group.reduce((sum, item) => sum + item.line.quantity, 0), shipmentIds: [], platformConfirmationPending: false, factories: [],
          items: group.map(item => ({ lineId: item.line.id, quantity: item.line.quantity, expectedRevision: item.line.revision,
            expectedProjectionVersion: item.line.projectionVersion, externalLineId: item.line.externalLineId, title: item.line.title,
            sku: item.line.skuCode, specification: null, readyQuantity: 0, shippedQuantity: 0, renderId: null, fileName: null,
            editorVersionNumber: null, productionBlockers: ["Synthetic artwork not prepared"], shipmentBlockers: [], operationBlockers: [], production: null })),
        }, error: null },
        production: { data: [], error: null }, shipments: { data: [], error: null }, cases: { data: [], error: null }, shipos: { data: [], error: null },
      }) });
    }
    if (request.method() === "POST" && path.endsWith("/draft")) {
      const input = SaveOrderWorkDraftInputSchema.parse(request.postDataJSON());
      saves.push({ ...input, lineId });
      await pendingSave;
      pendingSave = undefined;
      if (failNext) {
        failNext = false;
        return route.fulfill({
          status: 409,
          json: { message: "Synthetic save conflict; retry required" },
        });
      }
      record.draft = input.draft;
      record.line.preparation = input.status;
      record.line.revision += 1;
      record.line.projectionVersion += 1;
      return route.fulfill({ json: record });
    }
    if (request.method() !== "GET") {
      unexpectedWrites.push(path);
      return route.fulfill({
        status: 409,
        json: { message: "Synthetic fixture rejects this action" },
      });
    }
    return route.fulfill({ json: record });
  });
  return {
    records,
    saves,
    unexpectedWrites,
    workspaceReads: () => workspaceReads,
    failNextSave: () => {
      failNext = true;
    },
    holdSave: () => {
      pendingSave = new Promise<void>((resolve) => {
        releaseSave = resolve;
      });
    },
    releaseSave: () => releaseSave?.(),
  };
}
