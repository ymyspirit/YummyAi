import { type Page } from "@playwright/test";
import { WholeOrderDetailViewSchema } from "@yummyai/contracts/order/whole-detail";
import { AmazonReportDetailViewSchema } from "@yummyai/contracts/order/report";
import { FulfillmentCommandListSchema } from "@yummyai/contracts/order/fulfillment-command";
import { OrderExceptionOperationsQuerySchema, OrderExceptionOperationsViewSchema } from "@yummyai/contracts/order/exception-operations";
import { ErpSessionViewSchema, erpSessionAuthority } from "@yummyai/contracts/auth/session";
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
export async function fixture(page: Page, count = 3, options: { trackVersions?: boolean; currentReadContracts?: boolean } = {}) {
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
  let failureMessage = "Synthetic save conflict; retry required";
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
              sourceVersionId: options.currentReadContracts ? record.report?.versionId ?? null : null,
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
              ...(options.currentReadContracts ? { availability: "available" as const } : {}),
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
          id: item.line.id, revision: item.line.revision,
          sourceVersionId: options.currentReadContracts ? item.report?.versionId ?? null : null, printSku: item.line.printSku,
          spu: null, specification: null, designExecutor: item.draft.designExecutor ?? "agent",
          fields: item.draft.fields.map(field => ({ label: field.label, value: field.value ?? "" })),
          instructions: item.draft.instructions, images: [], blockers: [], error: null,
          ...(options.currentReadContracts ? { availability: "available" as const } : {}),
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
          json: { message: failureMessage },
        });
      }
      record.draft = input.draft;
      record.line.preparation = input.status;
      record.line.revision += 1;
      record.line.projectionVersion += 1;
      if (options.trackVersions) record.versions.push({
        id: id(2000 + saves.length), revision: record.line.revision, createdAt: now,
      });
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
    failNextSave: (message = "Synthetic save conflict; retry required") => {
      failNext = true;
      failureMessage = message;
    },
    holdSave: () => {
      pendingSave = new Promise<void>((resolve) => {
        releaseSave = resolve;
      });
    },
    releaseSave: () => releaseSave?.(),
  };
}

export const imageUploadPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6wwAAAABJRU5ErkJggg==",
  "base64",
);

/** UI transport only: backend integration owns actual defaulting and private storage. */
export async function imageReviewFixture(page: Page, options: { multipleFields?: boolean; persistedEmpty?: boolean } = {}) {
  const state = await fixture(page, 2, { trackVersions: true, currentReadContracts: true });
  const session = await page.request.get("/api/erp-auth/session");
  if (!session.ok()) throw new Error("The image fixture requires the current personal session");
  const identity = ErpSessionViewSchema.parse(await session.json());
  if (!identity.canUseErp) throw new Error("The current personal session cannot use the ERP");
  const authority = erpSessionAuthority(identity);
  const uploads: Array<{ lineId: string; name: string; contentBase64: string }> = [];
  let uploadFailure = false;
  let responseMismatch: "order" | "revision" | "source" | null = null;
  let pendingUpload: Promise<void> | undefined;
  let releaseUpload: (() => void) | undefined;
  for (const [index, record] of state.records.entries()) {
    const photo = (key: string, label: string) => ({ key, label, type: "image" as const, required: true,
      validation: { allowedMediaTypes: ["image/png" as const], maxFiles: 20, maxBytes: 1000000 } });
    record.catalog = {
      status: "unmatched", packageId: null, recipes: [], specifications: [],
      artworks: [{ id: id(400 + index), code: "SYNTHETIC-IMAGE-ART", name: "Synthetic upload schema",
        version: 1, mode: "customer_image", materials: [], layout: [], instructions: "UI fixture only",
        customization: { version: 1, fields: [photo("buyer_photo", "顾客原图"),
          ...(options.multipleFields ? [photo("back_photo", "背面原图")] : []),
          { key: "name", label: "Customer name", type: "short_text", required: false } ] },
      }],
    };
    record.draft.artworkVersionId = id(400 + index);
    record.draft.fields[0] = { ...record.draft.fields[0]!, font: "Synthetic Serif", color: "#336699" };
    record.line.revision = options.persistedEmpty ? 1 : 0;
    record.versions = options.persistedEmpty ? [{ id: id(450 + index), revision: 1, createdAt: now }] : [];
    record.report = AmazonReportDetailViewSchema.parse({
      line: { id: id(500 + index), orderId: record.line.orderId, orderLineId: record.line.id,
        externalOrderId: record.line.externalOrderId, externalLineId: "1", skuCode: record.line.skuCode,
        title: record.line.title, quantity: 1, currency: null, itemTotalMinor: null, state: "ready",
        versionNumber: 1, reviewed: false, lastErrorCode: null, updatedAt: now, hasPreview: true },
      versionId: id(510 + index), warnings: [],
      surfaces: [{ key: "front", label: "正面", fields: structuredClone(record.draft.fields),
        buyerFileKeys: ["buyer-first", "buyer-second"], previewFileKey: "platform-preview" }],
      files: [
        ...["first", "second"].flatMap((name) => [
          { key: `buyer-${name}`, name: `derived-${name}.png`, role: "buyer_image", originalFileKey: `source-${name}`,
            mediaType: "image/png", byteSize: imageUploadPng.length, width: 1, height: 1 },
          { key: `source-${name}`, name: `original-${name}.png`, role: "source", mediaType: "image/png",
            byteSize: imageUploadPng.length, width: 1, height: 1 },
        ]),
        { key: "platform-preview", name: "platform-preview.png", role: "preview", mediaType: "image/png", byteSize: imageUploadPng.length },
        { key: "unlinked", name: "unlinked-buyer.png", role: "buyer_image", mediaType: "image/png", byteSize: imageUploadPng.length },
      ],
    });
    // Mirrors the native response contract, not an alternative UI defaulting algorithm.
    record.draft.images = options.persistedEmpty ? [] : ["buyer-first", "buyer-second"].map((key) => ({
      origin: "report" as const, key, usage: options.multipleFields ? "待选择定制字段" : "buyer_photo",
    }));
    OrderWorkDetailViewSchema.parse(record);
  }
  await page.route("**/api/orders/reports/lines/**/files/**", (route) =>
    route.fulfill({ contentType: "image/png", body: imageUploadPng }));
  await page.route("**/api/order-review-fixture/images/**", (route) =>
    route.fulfill({ contentType: "image/png", body: imageUploadPng }));
  await page.route("**/api/order-centers/fulfillment-commands?**", (route) => {
    const request = route.request(), orderId = new URL(request.url()).searchParams.get("orderId");
    if (request.method() !== "GET" || !state.records.some((record) => record.line.orderId === orderId))
      throw new Error("The image fixture only owns empty current-order recovery reads");
    if (request.headers()["x-yummyai-context-authority"] !== authority)
      throw new Error("Synthetic recovery request does not match the authenticated personal authority");
    return route.fulfill({ headers: { "x-yummyai-context-authority": authority, "cache-control": "private, no-store" },
      json: FulfillmentCommandListSchema.parse({ items: [], truncated: false }) });
  });
  await page.route("**/api/order-exceptions/**", (route) => {
    const request = route.request(), url = new URL(request.url()), orderId = url.pathname.split("/")[3];
    const record = state.records.find((item) => item.line.orderId === orderId);
    if (request.method() !== "GET" || !record)
      throw new Error("The image fixture only owns empty current-order exception reads");
    const query = OrderExceptionOperationsQuerySchema.parse(Object.fromEntries(url.searchParams));
    return route.fulfill({ json: OrderExceptionOperationsViewSchema.parse({
      orderId, lineId: null, label: record.line.externalOrderId, orderSequence: 1,
      sourceChecksum: "b".repeat(64), asOf: now, canCreate: false, query,
      total: 0, page: query.page, pageSize: query.pageSize,
      summary: { open: 0, resolved: 0, missingEvent: 0 }, items: [],
    }) });
  });
  await page.route("**/api/order-centers/lines/*/images", async (route) => {
    const request = route.request(), lineId = new URL(request.url()).pathname.split("/")[4]!;
    if (request.method() !== "POST") throw new Error("Upload fixture only owns the exact image POST");
    const input = request.postDataJSON() as { name: string; contentBase64: string };
    if (Object.keys(input).sort().join(",") !== "contentBase64,name" ||
      typeof input.name !== "string" || input.contentBase64 !== imageUploadPng.toString("base64"))
      throw new Error("Unexpected synthetic upload bytes or contract");
    uploads.push({ lineId, ...input });
    await pendingUpload;
    pendingUpload = undefined;
    if (uploadFailure) {
      uploadFailure = false;
      return route.fulfill({ status: 503, json: { message: "Synthetic upload unavailable; retry the original file" } });
    }
    const record = state.records.find((item) => item.line.id === lineId);
    if (!record) throw new Error("Unknown synthetic upload order");
    record.assets.push({ id: id(600 + uploads.length), name: input.name, mediaType: "image/png", width: 1, height: 1,
      checksum: "a".repeat(64), path: `/api/order-review-fixture/images/${id(600 + uploads.length)}` });
    const response = structuredClone(record);
    if (responseMismatch === "order") response.line.id = state.records[1]!.line.id;
    if (responseMismatch === "revision") { response.line.revision += 1; response.line.projectionVersion += 1; }
    if (responseMismatch === "source") response.report!.versionId = id(999);
    responseMismatch = null;
    return route.fulfill({ json: OrderWorkDetailViewSchema.parse(response) });
  });
  return {
    ...state, uploads,
    failNextUpload: () => { uploadFailure = true; },
    mismatchNextUpload: (kind: "order" | "revision" | "source") => { responseMismatch = kind; },
    holdNextUpload: () => { pendingUpload = new Promise<void>((resolve) => { releaseUpload = resolve; }); },
    releaseUpload: () => releaseUpload?.(),
  };
}
