import { z } from "zod";
export {
  DEFAULT_ORDER_DESIGN_EXECUTOR,
  ORDER_IMAGE_ENHANCEMENT_POLICY,
  ORDER_IMAGE_ENHANCEMENT_INSTRUCTION,
  orderDesignExecutor,
} from "@yummyai/contracts/order/design-policy";
import { EntityIdSchema as Id } from "@yummyai/contracts/common/ids";
import {
  OrderQueueStageSchema,
  OrderQueueCountsSchema,
  OrderLabelStatusSchema,
} from "@yummyai/contracts/order/workbench";
import {
  ArtworkMaterialSchema,
  ArtworkModeSchema,
  ArtworkLayoutSchema,
} from "@yummyai/contracts/catalog/artwork";
import { CustomizationSchema } from "@yummyai/contracts/catalog/product";
import {
  AmazonReportDetailViewSchema,
  AmazonReportFieldViewSchema,
} from "@yummyai/contracts/order/report";

export const OrderWorkspaceModuleSchema = z.enum([
  "orders",
  "artwork",
  "production",
  "shipments",
  "after-sales",
]);
export const OrderTemplatePlanSchema = z.object({
  orderLineId: Id,
  revision: z.int().nonnegative(),
  sourceVersionId: Id.nullable(),
  ready: z.boolean(),
  templateVersionId: Id.nullable(),
  artworkVersionId: Id.nullable(),
  specificationVersionId: Id.nullable(),
  blockers: z.array(z.string()),
  notes: z.array(z.string()),
  mappings: z.array(
    z.object({
      fieldKey: z.string(),
      label: z.string(),
      type: z.string(),
      value: z.string(),
      region: z.string().nullable(),
    }),
  ),
});
export type OrderTemplatePlan = z.infer<typeof OrderTemplatePlanSchema>;
export const OrderPreparationStatusSchema = z.enum([
  "pending_review",
  "needs_information",
  "ready_to_push",
  "pushed",
]);
export const OrderArtworkStatusSchema = z.enum([
  "not_pushed",
  "queued",
  "starting",
  "in_progress",
  "in_review",
  "changes_requested",
  "approved",
]);
export const OrderProofStatusSchema = z.enum([
  "not_required",
  "pending",
  "approved",
  "changes_requested",
]);
export const OrderWorkImageSchema = z
  .object({
    origin: z.enum(["report", "upload"]),
    key: z.string().min(1).max(1000),
    usage: z.string().trim().min(1).max(100),
  })
  .strict();
export const OrderWorkDraftSchema = z
  .object({
    printProfileVersionId: Id.nullable(),
    salesRecipeVersionId: Id.nullable().optional(),
    salesPackageId: Id.nullable().optional(),
    artworkVersionId: Id.nullable().optional(),
    specificationVersionId: Id.nullable().optional(),
    designExecutor: z.enum(["human", "agent"]).optional(),
    fields: z.array(AmazonReportFieldViewSchema).max(500),
    images: z.array(OrderWorkImageSchema).max(30),
    instructions: z.string().max(10000),
    customerApprovalRequired: z.boolean(),
    dueAt: z.iso.datetime().nullable(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (new Set(value.fields.map((field) => field.key)).size !== value.fields.length)
      ctx.addIssue({ code: "custom", path: ["fields"], message: "定制字段不可重复" });
    if (
      new Set(value.images.map((image) => `${image.origin}:${image.key}`)).size !==
      value.images.length
    )
      ctx.addIssue({
        code: "custom",
        path: ["images"],
        message: "图片不可重复选择，请在用途里说明多个位置",
      });
  });
export const SaveOrderWorkDraftInputSchema = z
  .object({
    expectedRevision: z.int().nonnegative(),
    expectedProjectionVersion: z.int().nonnegative().optional(),
    expectedSourceVersionId: Id.nullable(),
    draft: OrderWorkDraftSchema,
    status: z.enum(["pending_review", "needs_information", "ready_to_push"]),
    reason: z.string().trim().min(1).max(2000),
    idempotencyKey: z.uuid(),
  })
  .strict();
export const OrderWorkActionInputSchema = z
  .object({
    action: z.enum([
      "push",
      "recall",
      "start_artwork",
      "submit_artwork",
      "approve_artwork",
      "reject_artwork",
      "approve_proof",
      "reject_proof",
      "hold",
      "resume",
    ]),
    expectedRevision: z.int().positive(),
    expectedProjectionVersion: z.int().positive(),
    reason: z.string().trim().min(1).max(2000),
    idempotencyKey: z.uuid(),
    expectedEditorVersionId: Id.optional(),
  })
  .strict();
export const ArchiveOrderWorkInputSchema = z
  .object({
    archived: z.boolean(),
    expectedProjectionVersion: z.int().positive(),
    reason: z.string().trim().min(1).max(2000),
    idempotencyKey: z.uuid(),
  })
  .strict();
export const OrderWorkQuerySchema = z
  .object({
    module: OrderWorkspaceModuleSchema.default("orders"),
    q: z.string().trim().max(200).default(""),
    orderNumbers: z.string().trim().max(6000).optional(),
    sku: z.string().trim().max(150).optional(),
    printSku: z.string().trim().max(150).optional(),
    spu: z.string().trim().max(150).optional(),
    specification: z.string().trim().max(150).optional(),
    designExecutor: z.enum(["human", "agent"]).optional(),
    stage: OrderQueueStageSchema.optional(),
    labelStatus: OrderLabelStatusSchema.optional(),
    archived: z.enum(["active", "only"]).default("active"),
    accountId: Id.optional(),
    platform: z.enum(["amazon", "etsy"]).optional(),
    batchId: Id.optional(),
    preparation: OrderPreparationStatusSchema.optional(),
    artwork: OrderArtworkStatusSchema.optional(),
    proof: OrderProofStatusSchema.optional(),
    production: z.string().max(60).optional(),
    shipment: z.enum(["unshipped", "partial", "shipped"]).optional(),
    afterSales: z
      .enum([
        "open",
        "awaiting_customer",
        "awaiting_internal",
        "approved",
        "rejected",
        "resolved",
        "cancelled",
      ])
      .optional(),
    attention: z.enum(["held", "overdue", "source_changed"]).optional(),
    from: z.iso.date().optional(),
    to: z.iso.date().optional(),
    dateField: z.enum(["placed", "imported", "due", "dispatched"]).default("placed"),
    timeZone: z
      .string()
      .max(80)
      .default("Asia/Shanghai")
      .refine((value) => {
        try {
          new Intl.DateTimeFormat("en", { timeZone: value });
          return true;
        } catch {
          return false;
        }
      }, "无效的时区"),
    page: z.coerce.number().int().min(1).max(100000).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(25),
    grouping: z.enum(["items", "orders"]).default("items"),
  })
  .strict()
  .refine((value) => !value.from || !value.to || value.from <= value.to, "结束日期不能早于开始日期")
  .refine(
    (value) =>
      !value.orderNumbers || value.orderNumbers.split(/[\s,，;；]+/).filter(Boolean).length <= 100,
    "一次最多查询 100 个订单号",
  );
export const PrintProfileInputSchema = z
  .object({
    code: z.string().trim().min(1).max(100),
    name: z.string().trim().min(1).max(160),
    projectId: Id,
    versionId: Id,
    instructions: z.string().max(3000),
    expectedVersion: z.int().nonnegative(),
    idempotencyKey: z.uuid(),
  })
  .strict();
export const PrintProfileViewSchema = z
  .object({
    id: Id,
    versionId: Id,
    code: z.string(),
    name: z.string(),
    versionNumber: z.int().positive(),
    productType: z.enum(["shaped_pillow", "tire_cover"]),
    projectId: Id,
    sourceVersionId: Id,
    instructions: z.string(),
    createdAt: z.iso.datetime(),
  })
  .strict();
export const OrderWorkListItemSchema = z
  .object({
    id: Id,
    orderId: Id,
    externalOrderId: z.string(),
    externalLineId: z.string(),
    accountId: Id,
    storeName: z.string(),
    platform: z.enum(["amazon", "etsy"]),
    skuCode: z.string().nullable(),
    title: z.string(),
    quantity: z.int(),
    providerStatus: z.string(),
    sideState: z.string().nullable(),
    placedAt: z.iso.datetime(),
    reportLineId: Id.nullable(),
    preparation: OrderPreparationStatusSchema,
    artwork: OrderArtworkStatusSchema,
    proof: OrderProofStatusSchema,
    production: z.string(),
    readyQuantity: z.int().nonnegative(),
    shippedQuantity: z.int().nonnegative(),
    afterSalesCount: z.int().nonnegative(),
    printSku: z.string().nullable(),
    revision: z.int().nonnegative(),
    projectionVersion: z.int().nonnegative(),
    held: z.boolean(),
    sourceChanged: z.boolean(),
    dueAt: z.iso.datetime().nullable(),
    updatedAt: z.iso.datetime(),
    editorProjectId: Id.nullable(),
    queueStage: OrderQueueStageSchema.optional(),
    labelStatus: OrderLabelStatusSchema.optional(),
    packageCount: z.int().nonnegative().optional(),
    labeledPackageCount: z.int().nonnegative().optional(),
    designExecutor: z.enum(["human", "agent"]).nullable().optional(),
    spuCode: z.string().nullable().optional(),
    specificationName: z.string().nullable().optional(),
    importedAt: z.iso.datetime().nullable().optional(),
    dispatchedAt: z.iso.datetime().nullable().optional(),
    archivedAt: z.iso.datetime().nullable().optional(),
  })
  .strict();
export const OrderWorkListViewSchema = z
  .object({
    items: z.array(OrderWorkListItemSchema),
    total: z.int().nonnegative(),
    groupTotal: z.int().nonnegative().optional(),
    page: z.int(),
    pageSize: z.int(),
    counts: OrderQueueCountsSchema.optional(),
  })
  .strict();
export const OrderWorkAssetViewSchema = z
  .object({
    id: Id,
    name: z.string(),
    mediaType: z.string(),
    width: z.int(),
    height: z.int(),
    checksum: z.string(),
    path: z.string(),
  })
  .strict();
export const OrderWorkEventViewSchema = z
  .object({
    id: Id,
    action: z.string(),
    from: z.string(),
    to: z.string(),
    actor: z.string(),
    reason: z.string(),
    revision: z.int(),
    occurredAt: z.iso.datetime(),
  })
  .strict();
export const OrderWorkDetailViewSchema = z
  .object({
    catalog: z
      .object({
        status: z.enum(["matched", "unmatched", "ambiguous", "pinned"]),
        packageId: Id.nullable(),
        recipes: z.array(
          z.object({
            id: Id,
            skuId: Id,
            skuCode: z.string(),
            version: z.int(),
            printSku: z.string(),
            artworkVersionId: Id,
            processProfileVersionId: Id,
            spuCode: z.string(),
            specification: z.string(),
            specificationVersionId: Id,
          }),
        ),
        artworks: z.array(
          z.object({
            id: Id,
            code: z.string(),
            name: z.string(),
            version: z.int(),
            mode: ArtworkModeSchema,
            materials: z.array(ArtworkMaterialSchema),
            customization: CustomizationSchema,
            layout: ArtworkLayoutSchema,
            instructions: z.string(),
          }),
        ),
        specifications: z.array(
          z.object({
            id: Id,
            spuId: Id,
            spuCode: z.string(),
            spuName: z.string(),
            name: z.string(),
            version: z.int(),
            processProfileVersionId: Id,
            processName: z.string(),
            dimensions: z.string(),
          }),
        ),
      })
      .optional(),
    line: OrderWorkListItemSchema,
    draft: OrderWorkDraftSchema,
    report: AmazonReportDetailViewSchema.nullable(),
    profile: PrintProfileViewSchema.nullable(),
    assets: z.array(OrderWorkAssetViewSchema),
    events: z.array(OrderWorkEventViewSchema),
    versions: z.array(
      z.object({ id: Id, revision: z.int(), createdAt: z.iso.datetime() }).strict(),
    ),
  })
  .strict();
export const ReleaseOrderArtworkInputSchema = z
  .object({
    expectedRevision: z.int().positive(),
    expectedProjectionVersion: z.int().positive(),
    renderId: Id,
    supplierId: Id,
    quantity: z.int().positive().max(100000),
    expectedCompletionAt: z.iso.datetime(),
    instructions: z.string().trim().min(1).max(10000),
    idempotencyKey: z.uuid(),
  })
  .strict();
export type OrderWorkDraft = z.infer<typeof OrderWorkDraftSchema>;
export type OrderWorkQuery = z.infer<typeof OrderWorkQuerySchema>;
export type OrderWorkListItem = z.infer<typeof OrderWorkListItemSchema>;
export type OrderWorkDetail = z.infer<typeof OrderWorkDetailViewSchema>;
export const OrderWorkSelectionInputSchema = z
  .object({ ids: z.array(Id).min(1).max(100) })
  .strict();
export const OrderWorkSummarySchema = z
  .object({
    id: Id,
    revision: z.int().nonnegative(),
    sourceVersionId: Id.nullable(),
    printSku: z.string().nullable(),
    spu: z.string().nullable(),
    specification: z.string().nullable(),
    designExecutor: z.enum(["human", "agent"]).nullable(),
    fields: z.array(z.object({ label: z.string(), value: z.string() })),
    instructions: z.string(),
    images: z.array(
      z.object({
        path: z.string(),
        label: z.string(),
        selected: z.boolean(),
        kind: z.enum(["preview", "buyer", "artwork"]),
      }),
    ),
    blockers: z.array(z.string()),
    error: z.string().nullable(),
  })
  .strict();
export const OrderWorkSummariesSchema = z
  .object({ items: z.array(OrderWorkSummarySchema) })
  .strict();
export type OrderWorkSummary = z.infer<typeof OrderWorkSummarySchema>;
export const OrderBulkPreviewInputSchema = z
  .object({
    ids: z.array(Id).min(1).max(100),
    operation: z.enum(["check", "bind", "assign", "needs_information", "ready_to_push", "push"]),
    patch: z
      .object({
        artworkVersionId: Id.optional(),
        specificationVersionId: Id.optional(),
        designExecutor: z.enum(["human", "agent"]).optional(),
        dueAt: z.iso.datetime().optional(),
      })
      .strict()
      .default({}),
    onlyEmpty: z.boolean().default(true),
    reason: z.string().trim().min(1).max(2000),
  })
  .strict();
export type OrderBulkPreviewInput = z.infer<typeof OrderBulkPreviewInputSchema>;
export const OrderBulkPreviewSchema = z
  .object({
    items: z.array(
      z
        .object({
          line: OrderWorkListItemSchema,
          changes: z.array(z.string()),
          blockers: z.array(z.string()),
          save: SaveOrderWorkDraftInputSchema.nullable(),
          action: OrderWorkActionInputSchema.nullable(),
        })
        .strict(),
    ),
    failures: z.array(z.object({ id: Id, message: z.string() }).strict()),
  })
  .strict();
export type OrderBulkPreview = z.infer<typeof OrderBulkPreviewSchema>;
export type OrderWorkActionInput = z.infer<typeof OrderWorkActionInputSchema>;
export type PrintProfileView = z.infer<typeof PrintProfileViewSchema>;
export type OrderWorkspaceModule = z.infer<typeof OrderWorkspaceModuleSchema>;
export const DispatchOrderShipmentInputSchema = z
  .object({
    expectedVersion: z.int().positive(),
    reason: z.string().trim().min(1).max(1000),
    occurredAt: z.iso.datetime(),
    idempotencyKey: z.uuid(),
  })
  .strict();
export const CompleteAfterSalesInputSchema = z
  .object({
    expectedDecisionVersion: z.int().positive(),
    reason: z.string().trim().min(1).max(2000),
    evidenceReference: z.string().trim().min(1).max(200),
    occurredAt: z.iso.datetime(),
    idempotencyKey: z.uuid(),
  })
  .strict();
export const OrderCenterOptionsSchema = z
  .object({
    profiles: z.array(PrintProfileViewSchema),
    suppliers: z.array(z.object({ id: Id, name: z.string(), status: z.string() })),
    stores: z.array(z.object({ id: Id, displayName: z.string(), platform: z.string() })),
    standards: z.array(
      z.object({ id: Id, name: z.string(), versionNumber: z.int(), minimumScoreBps: z.int() }),
    ),
    preferenceScope: z.string(),
  })
  .strict();
export const OrderOperationsViewSchema = z.object({
  production: z.array(
    z.object({
      productionOrder: z.object({
        id: Id,
        supplierId: Id,
        status: z.string(),
        projectionVersion: z.int(),
        currentVersionNumber: z.int(),
        expectedCompletionAt: z.string(),
      }),
      versions: z.array(
        z.object({
          id: Id,
          versionNumber: z.int(),
          quantity: z.int(),
          sourceEditorProjectId: Id.nullable(),
          sourceEditorVersionId: Id.nullable(),
          sourceRenderId: Id.nullable(),
        }),
      ),
      milestones: z.array(
        z.object({ id: Id, type: z.string(), evidenceCode: z.string(), occurredAt: z.string() }),
      ),
      inspections: z.array(
        z.object({ id: Id, result: z.string(), scoreBps: z.int(), inspectedAt: z.string() }),
      ),
      defects: z.array(
        z.object({ id: Id, code: z.string(), severity: z.string(), disposition: z.string() }),
      ),
    }),
  ),
  shipments: z.array(
    z.object({
      shipment: z.object({
        id: Id,
        status: z.string(),
        currentVersionNumber: z.int(),
        approvedVersionNumber: z.int().nullable(),
      }),
      versions: z.array(z.object({ id: Id, versionNumber: z.int(), shipDate: z.string() })),
      packages: z.array(
        z.object({
          id: Id,
          shipmentVersionId: Id,
          trackingNumber: z.string(),
          carrierName: z.string(),
        }),
      ),
      packageLines: z.array(z.object({ packageId: Id, orderLineId: Id, quantity: z.int() })),
      tracking: z.array(
        z.object({
          id: Id,
          status: z.string(),
          occurredAt: z.string(),
          detailCode: z.string().nullable(),
        }),
      ),
      writebacks: z.array(z.object({ id: Id, status: z.string() })),
    }),
  ),
  cases: z.array(
    z.object({
      case: z.object({
        id: Id,
        type: z.string(),
        status: z.string(),
        reasonCode: z.string(),
        currentDecisionVersion: z.int(),
        createdAt: z.string(),
        summary: z.string(),
      }),
      contacts: z.array(
        z.object({ id: Id, direction: z.string(), occurredAt: z.string(), body: z.string() }),
      ),
      decisions: z.array(
        z.object({
          id: Id,
          resolution: z.string(),
          decidedAt: z.string(),
          refundAmountMinor: z.number().nullable(),
          refundCurrency: z.string().nullable(),
          reason: z.string(),
        }),
      ),
    }),
  ),
});
export type OrderCenterOptions = z.infer<typeof OrderCenterOptionsSchema>;
export type OrderOperationsView = z.infer<typeof OrderOperationsViewSchema>;
