import {
  Body,
  Controller,
  Get,
  Header,
  Inject,
  Param,
  Post,
  Query,
  Req,
  Res,
  StreamableFile,
  UnprocessableEntityException,
} from "@nestjs/common";
import { Permission } from "@yummyai/authz";
import {
  CreateShipmentInputSchema,
  AppendShipmentVersionInputSchema,
  ReviewShipmentVersionInputSchema,
  RecordTrackingEventInputSchema,
  RecordProductionMilestoneInputSchema,
  RecordQualityInspectionInputSchema,
  CreateQualityStandardInputSchema,
  CreateProductionRecoveryInputSchema,
  CreateAfterSalesCaseInputSchema,
  DecideAfterSalesCaseInputSchema,
  RecordCustomerContactInputSchema,
} from "@yummyai/contracts";
import { z } from "zod";
import { RequiresPermission } from "../auth/permissions.decorator.js";
import type { AuthenticatedRequest } from "../auth/tenant-context.guard.js";
import { OrderWorkspaceService } from "./order-workspace.service.js";
import { OrderProductionService } from "./order-production.service.js";
import { OrderShipmentService } from "./order-shipment.service.js";
import { OrderAfterSalesService } from "./order-after-sales.service.js";
import { OrderRoutingService } from "./order-routing.service.js";
import { MarketplaceAccountService } from "../marketplaces/marketplace-account.service.js";
import { OrderWholeDetailService } from "./order-whole-detail.service.js";
import { OrderReviewService } from "./order-review.service.js";
import { ShiposService } from "../suppliers/shipos.service.js";
import { readOrderSection } from "./order-read-section.js";

const id = (value: string) => z.uuidv7().parse(value);
const upload = z
  .object({
    name: z.string().min(1).max(200),
    contentBase64: z
      .string()
      .min(4)
      .max(45 * 1024 * 1024)
      .regex(/^[A-Za-z0-9+/]+={0,2}$/),
  })
  .strict();
@Controller("v1/order-centers")
export class OrderWorkspaceController {
  constructor(
    @Inject(OrderWorkspaceService) private readonly work: OrderWorkspaceService,
    @Inject(OrderProductionService) private readonly production: OrderProductionService,
    @Inject(OrderShipmentService) private readonly shipments: OrderShipmentService,
    @Inject(OrderAfterSalesService) private readonly afterSales: OrderAfterSalesService,
    @Inject(OrderRoutingService) private readonly routing: OrderRoutingService,
    @Inject(MarketplaceAccountService) private readonly accounts: MarketplaceAccountService,
    @Inject(OrderWholeDetailService) private readonly wholeDetail: OrderWholeDetailService,
    @Inject(OrderReviewService) private readonly review: OrderReviewService,
    @Inject(ShiposService) private readonly shipos: ShiposService,
  ) {}

  @Get("review")
  @Header("Cache-Control", "private, no-store")
  @RequiresPermission(Permission.OrderRead, Permission.OrderPiiRead, Permission.FinanceRead)
  reviewWorkspace(@Req() request: AuthenticatedRequest, @Query() query: unknown) {
    return this.review.workspace(context(request), query);
  }

  @Get("lines/:id/review")
  @Header("Cache-Control", "private, no-store")
  @RequiresPermission(Permission.OrderRead, Permission.OrderPiiRead)
  orderReview(@Req() request: AuthenticatedRequest, @Param("id") value: string) {
    return this.review.get(context(request), id(value));
  }

  @Get("orders/:id/shipos-evidence")
  @Header("Cache-Control", "private, no-store")
  @RequiresPermission(Permission.OrderRead, Permission.OrderPiiRead)
  shiposEvidence(@Req() request: AuthenticatedRequest, @Param("id") value: string) {
    return this.shipos.orderEvidence(context(request), id(value));
  }

  @Get("orders/:id/fulfillment")
  @Header("Cache-Control", "private, no-store")
  @RequiresPermission(Permission.OrderRead)
  wholeOrderFulfillment(@Req() request: AuthenticatedRequest, @Param("id") value: string) {
    return this.production.wholeOrderFulfillment(context(request), id(value));
  }

  @Post("orders/:id/release")
  @RequiresPermission(Permission.OrderWrite)
  releaseWholeOrder(@Req() request: AuthenticatedRequest, @Param("id") value: string, @Body() body: unknown) {
    return this.production.releaseWholeOrder(context(request), id(value), body);
  }

  @Post("orders/:id/shipments")
  @RequiresPermission(Permission.OrderWrite)
  createWholeOrderShipment(@Req() request: AuthenticatedRequest, @Param("id") value: string, @Body() body: unknown) {
    return this.shipments.createWholeOrder(context(request), id(value), body);
  }

  @Post("orders/:id/production-progress")
  @RequiresPermission(Permission.OrderWrite)
  recordWholeProduction(@Req() request: AuthenticatedRequest, @Param("id") value: string, @Body() body: unknown) {
    return this.production.recordWholeOrderProduction(context(request), id(value), body);
  }

  @Post("orders/:id/quality-pass")
  @RequiresPermission(Permission.OrderWrite)
  inspectWholeOrder(@Req() request: AuthenticatedRequest, @Param("id") value: string, @Body() body: unknown) {
    return this.production.inspectWholeOrder(context(request), id(value), body);
  }

  @Get("workspace")
  @Header("Cache-Control", "private, no-store")
  @RequiresPermission(Permission.OrderRead)
  list(@Req() request: AuthenticatedRequest, @Query() query: unknown) {
    return this.work.list(context(request), query);
  }
  @Get("options")
  @Header("Cache-Control", "private, no-store")
  @RequiresPermission(Permission.OrderRead)
  async options(@Req() request: AuthenticatedRequest) {
    const ctx = context(request);
    const [profiles, suppliers, stores, standards, factories] = await Promise.all([
      this.work.profiles(ctx),
      this.routing.listSuppliers(ctx),
      this.accounts.list(ctx),
      this.production.qualityStandards(ctx),
      this.production.factoryList(ctx),
    ]);
    return {
      profiles,
      factories,
      suppliers: suppliers.map((supplier) => ({
        id: supplier.id,
        name: supplier.name,
        status: supplier.status,
      })),
      stores: stores.map((store) => ({
        id: store.id,
        displayName: store.displayName,
        platform: store.platform,
      })),
      standards: standards.map((standard) => ({
        id: standard.id,
        name: standard.name,
        versionNumber: standard.versionNumber,
        minimumScoreBps: standard.minimumScoreBps,
        criteria: standard.criteria,
      })),
      preferenceScope: `${ctx.tenantId}:${ctx.userId}`,
    };
  }
  @Post("selection")
  @Header("Cache-Control", "private, no-store")
  @RequiresPermission(Permission.OrderRead)
  selection(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    return this.work.selection(context(request), body);
  }
  @Post("summaries")
  @Header("Cache-Control", "private, no-store")
  @RequiresPermission(Permission.OrderRead, Permission.OrderPiiRead)
  summaries(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    return this.work.summaries(context(request), body);
  }
  @Post("lines/:id/intake-check")
  @Header("Cache-Control", "private, no-store")
  @RequiresPermission(Permission.OrderRead, Permission.OrderPiiRead)
  intakeCheck(@Req() request: AuthenticatedRequest, @Param("id") value: string, @Body() body: unknown) {
    return this.work.intakeCheck(context(request), id(value), body);
  }
  @Post("bulk/preview")
  @Header("Cache-Control", "private, no-store")
  @RequiresPermission(Permission.OrderWrite, Permission.OrderPiiRead)
  bulkPreview(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    return this.work.bulkPreview(context(request), body);
  }
  @Get("lines/:id")
  @Header("Cache-Control", "private, no-store")
  @RequiresPermission(Permission.OrderPiiRead)
  detail(@Req() request: AuthenticatedRequest, @Param("id") value: string) {
    return this.work.detail(context(request), id(value));
  }
  @Post("lines/:id/draft")
  @RequiresPermission(Permission.OrderWrite)
  save(@Req() request: AuthenticatedRequest, @Param("id") value: string, @Body() body: unknown) {
    return this.work.save(context(request), id(value), body);
  }
  @Post("lines/:id/archive")
  @RequiresPermission(Permission.OrderWrite, Permission.OrderPiiRead)
  archive(@Req() request: AuthenticatedRequest, @Param("id") value: string, @Body() body: unknown) {
    return this.work.archive(context(request), id(value), body);
  }
  @Post("lines/:id/platform-deadline")
  @RequiresPermission(Permission.OrderWrite, Permission.OrderPiiRead)
  platformDeadline(@Req() request: AuthenticatedRequest, @Param("id") value: string, @Body() body: unknown) {
    return this.work.recordPlatformDeadline(context(request), id(value), body);
  }
  @Post("shipments/:id/platform-confirmation")
  @RequiresPermission(Permission.OrderWrite, Permission.OrderPiiRead)
  platformConfirmation(@Req() request: AuthenticatedRequest, @Param("id") value: string, @Body() body: unknown) {
    return this.shipments.recordManualConfirmation(context(request), id(value), body);
  }
  @Get("lines/:id/template-plan")
  @Header("Cache-Control", "private, no-store")
  @RequiresPermission(Permission.OrderRead, Permission.OrderPiiRead)
  templatePlan(@Req() request: AuthenticatedRequest, @Param("id") value: string) {
    return this.work.templatePlan(context(request), id(value));
  }
  @Get("lines/:id/factories")
  @Header("Cache-Control", "private, no-store")
  @RequiresPermission(Permission.OrderRead, Permission.OrderPiiRead, Permission.ProductRead)
  productionFactories(@Req() request: AuthenticatedRequest, @Param("id") value: string, @Query() query: unknown) {
    const input = z.object({ renderId: z.uuidv7(), quantity: z.coerce.number().int().positive().max(100000).optional() }).strict().parse(query);
    return this.production.factoryOptions(context(request), id(value), input.renderId, input.quantity);
  }
  @Get("lines/:id/production-availability")
  @Header("Cache-Control", "private, no-store")
  @RequiresPermission(Permission.OrderRead, Permission.OrderPiiRead)
  productionAvailability(@Req() request: AuthenticatedRequest, @Param("id") value: string, @Query() query: unknown) {
    z.object({}).strict().parse(query);
    return this.production.productionAvailability(context(request), id(value));
  }
  @Get("lines/:id/manufacturing")
  @Header("Cache-Control", "private, no-store")
  @RequiresPermission(Permission.OrderRead, Permission.OrderPiiRead, Permission.ProductRead)
  manufacturingOptions(@Req() request: AuthenticatedRequest, @Param("id") value: string, @Query() query: unknown) {
    return this.production.manufacturingOptions(context(request), id(value), z.object({ originalProductionOrderId: z.uuidv7().optional(), nativeSpecificationVersionId: z.uuidv7().optional(), after: z.uuidv7().optional() }).strict()
      .refine(value => !(value.originalProductionOrderId && value.nativeSpecificationVersionId), "不能混用原生产绑定与直接生产规格").parse(query));
  }
  @Get("lines/:id/artwork-materials/:assetId")
  @Header("Cache-Control", "private, no-store")
  @Header("X-Content-Type-Options", "nosniff")
  @RequiresPermission(Permission.OrderRead, Permission.OrderPiiRead, Permission.AssetRead)
  async artworkMaterial(
    @Req() request: AuthenticatedRequest,
    @Param("id") value: string,
    @Param("assetId") assetId: string,
  ) {
    const file = await this.work.artworkMaterial(context(request), id(value), id(assetId));
    return new StreamableFile(file.body, {
      type: "application/octet-stream",
      disposition: `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`,
    });
  }
  @Get("lines/:id/revisions/:revisionId")
  @Header("Cache-Control", "private, no-store")
  @RequiresPermission(Permission.OrderPiiRead)
  revision(
    @Req() request: AuthenticatedRequest,
    @Param("id") value: string,
    @Param("revisionId") revisionId: string,
  ) {
    return this.work.revision(context(request), id(value), id(revisionId));
  }
  @Post("lines/:id/actions")
  @RequiresPermission(Permission.OrderWrite)
  action(@Req() request: AuthenticatedRequest, @Param("id") value: string, @Body() body: unknown) {
    return this.work.action(context(request), id(value), body);
  }
  @Post("lines/:id/images")
  @RequiresPermission(Permission.OrderWrite)
  imageUpload(
    @Req() request: AuthenticatedRequest,
    @Param("id") value: string,
    @Body() body: unknown,
  ) {
    const input = upload.parse(body),
      bytes = Buffer.from(input.contentBase64, "base64");
    if (bytes.toString("base64") !== input.contentBase64)
      throw new UnprocessableEntityException("图片编码无效");
    return this.work.upload(context(request), id(value), input.name, bytes);
  }
  @Get("lines/:id/images/:imageId")
  @RequiresPermission(Permission.OrderPiiRead)
  async image(
    @Req() request: AuthenticatedRequest,
    @Param("id") value: string,
    @Param("imageId") imageId: string,
    @Res({ passthrough: true }) response: { setHeader(name: string, value: string): void },
  ) {
    const file = await this.work.image(context(request), id(value), id(imageId));
    response.setHeader("Cache-Control", "private, no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
    return new StreamableFile(file.body, { type: file.mediaType, length: file.body.byteLength });
  }
  @Get("profiles")
  @Header("Cache-Control", "private, no-store")
  @RequiresPermission(Permission.OrderRead)
  profiles(@Req() request: AuthenticatedRequest) {
    return this.work.profiles(context(request));
  }
  @Get("lines/:id/source-files/:key")
  @RequiresPermission(Permission.OrderPiiRead)
  async sourceFile(
    @Req() request: AuthenticatedRequest,
    @Param("id") value: string,
    @Param("key") key: string,
    @Query() query: unknown,
    @Res({ passthrough: true }) response: { setHeader(name: string, value: string): void },
  ) {
    const input = z.object({ revision: z.string().regex(/^[1-9][0-9]{0,9}$/).transform(Number).pipe(z.int().max(2147483647)) }).strict().parse(query);
    const file = await this.work.sourceFile(context(request), id(value), z.string().regex(/^[a-z0-9_-]{1,200}$/i).parse(key), input.revision);
    response.setHeader("Cache-Control", "private, no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
    response.setHeader("Content-Disposition", `${file.inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(file.name).replaceAll("'", "%27")}`);
    return new StreamableFile(file.body, { type: file.mediaType, length: file.body.byteLength });
  }
  @Get("lines/:id/report-images/:index")
  @Header("Cache-Control", "private, no-store")
  @RequiresPermission(Permission.OrderPiiRead)
  async reportImage(
    @Req() request: AuthenticatedRequest,
    @Param("id") value: string,
    @Param("index") index: string,
  ) {
    const file = await this.work.reportImage(
      context(request),
      id(value),
      z.coerce.number().int().min(0).max(29).parse(index),
    );
    return new StreamableFile(file.body, { type: file.mediaType, length: file.body.byteLength });
  }
  @Post("profiles/:id/archive")
  @RequiresPermission(Permission.DesignWrite)
  archiveProfile(@Req() request: AuthenticatedRequest, @Param("id") id: string, @Body() body: unknown) {
    return this.work.archiveProfile(context(request), z.uuidv7().parse(id), body);
  }

  @Post("profiles")
  @RequiresPermission(Permission.DesignReview)
  profile(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    return this.work.saveProfile(context(request), body);
  }
  @Post("lines/:id/release")
  @RequiresPermission(Permission.OrderWrite)
  release(@Req() request: AuthenticatedRequest, @Param("id") value: string, @Body() body: unknown) {
    return this.production.releaseArtwork(context(request), id(value), body);
  }

  @Get("lines/:id/order-detail")
  @Header("Cache-Control", "private, no-store")
  @RequiresPermission(Permission.OrderRead, Permission.OrderPiiRead)
  orderDetail(@Req() request: AuthenticatedRequest, @Param("id") value: string) {
    return this.wholeDetail.get(context(request), id(value));
  }

  @Get("lines/:id/operations")
  @Header("Cache-Control", "private, no-store")
  @RequiresPermission(Permission.OrderPiiRead)
  async operations(@Req() request: AuthenticatedRequest, @Param("id") value: string) {
    const ctx = context(request),
      detail = await this.work.detail(ctx, id(value));
    const [production, shipments, cases] = await Promise.all([
      readOrderSection(async () => Promise.all((await this.production.list(ctx, detail.line.orderId)).filter(record => record.orderLineId === value).map(record => this.production.get(ctx, record.id))), "生产记录"),
      readOrderSection(async () => Promise.all((await this.shipments.list(ctx, detail.line.orderId)).map(record => this.shipments.get(ctx, record.id))), "包裹记录"),
      readOrderSection(async () => Promise.all((await this.afterSales.list(ctx, detail.line.orderId)).map(record => this.afterSales.getPrivate(ctx, record.id))), "售后记录"),
    ]);
    return { production: production.data ?? [], shipments: shipments.data ?? [], cases: cases.data ?? [],
      readErrors: { production: production.error, shipments: shipments.error, cases: cases.error } };
  }
  @Post("production/:id/milestones")
  @RequiresPermission(Permission.OrderWrite)
  milestone(
    @Req() request: AuthenticatedRequest,
    @Param("id") value: string,
    @Body() body: unknown,
  ) {
    return this.production.recordMilestone(
      context(request),
      id(value),
      RecordProductionMilestoneInputSchema.parse(body),
    );
  }
  @Post("production/:id/inspections")
  @RequiresPermission(Permission.OrderWrite)
  inspect(@Req() request: AuthenticatedRequest, @Param("id") value: string, @Body() body: unknown) {
    return this.production.inspect(
      context(request),
      id(value),
      RecordQualityInspectionInputSchema.parse(body),
    );
  }
  @Get("production/:id/quality-groups")
  @Header("Cache-Control", "private, no-store")
  @RequiresPermission(Permission.OrderRead)
  qualityGroups(@Req() request: AuthenticatedRequest, @Param("id") value: string) {
    return this.production.qualityGroups(context(request), id(value));
  }
  @Post("production/:id/quality-groups")
  @RequiresPermission(Permission.OrderWrite)
  inspectGroups(@Req() request: AuthenticatedRequest, @Param("id") value: string, @Body() body: unknown) {
    return this.production.inspectGroups(context(request), id(value), body);
  }
  @Post("quality-standards")
  @RequiresPermission(Permission.OrderWrite)
  standard(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    return this.production.createQualityStandard(
      context(request),
      CreateQualityStandardInputSchema.parse(body),
    );
  }
  @Post("recoveries")
  @RequiresPermission(Permission.OrderWrite)
  recovery(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    return this.production.recover(
      context(request),
      CreateProductionRecoveryInputSchema.parse(body),
    );
  }
  @Post("lines/:id/shipments")
  @RequiresPermission(Permission.OrderWrite)
  async createShipment(
    @Req() request: AuthenticatedRequest,
    @Param("id") value: string,
    @Body() body: unknown,
  ) {
    const ctx = context(request),
      detail = await this.work.detail(ctx, id(value));
    return this.shipments.create(ctx, detail.line.orderId, CreateShipmentInputSchema.parse(body));
  }
  @Get("shipments/:id/source-editor")
  @Header("Cache-Control", "private, no-store")
  @RequiresPermission(Permission.OrderRead)
  shipmentSourceEditor(@Req() request: AuthenticatedRequest, @Param("id") value: string) {
    return this.shipments.versionEditor(context(request), id(value));
  }

  @Post("shipments/:id/versions")
  @RequiresPermission(Permission.OrderWrite)
  reviseShipment(@Req() request: AuthenticatedRequest, @Param("id") value: string, @Body() body: unknown) {
    return this.shipments.appendVersion(context(request), id(value), AppendShipmentVersionInputSchema.parse(body));
  }

  @Post("shipments/:id/review")
  @RequiresPermission(Permission.OrderWrite)
  async reviewShipment(
    @Req() request: AuthenticatedRequest,
    @Param("id") value: string,
    @Body() body: unknown,
  ) {
    const ctx = context(request),
      detail = await this.shipments.get(ctx, id(value));
    const input = ReviewShipmentVersionInputSchema.parse(body),
      version = detail.versions.find(
        (entry) => entry.versionNumber === input.expectedCurrentVersion,
      );
    if (!version) throw new UnprocessableEntityException("包裹版本不存在");
    return this.shipments.reviewVersion(ctx, value, version.id, input);
  }
  @Post("shipments/:id/dispatch")
  @RequiresPermission(Permission.OrderWrite)
  dispatch(
    @Req() request: AuthenticatedRequest,
    @Param("id") value: string,
    @Body() body: unknown,
  ) {
    return this.shipments.dispatch(context(request), id(value), body);
  }
  @Post("shipments/:id/tracking")
  @RequiresPermission(Permission.OrderWrite)
  tracking(
    @Req() request: AuthenticatedRequest,
    @Param("id") value: string,
    @Body() body: unknown,
  ) {
    return this.shipments.recordTrackingEvent(
      context(request),
      id(value),
      RecordTrackingEventInputSchema.parse(body),
    );
  }
  @Post("lines/:id/cases")
  @RequiresPermission(Permission.OrderWrite)
  async createCase(
    @Req() request: AuthenticatedRequest,
    @Param("id") value: string,
    @Body() body: unknown,
  ) {
    const ctx = context(request),
      detail = await this.work.detail(ctx, id(value));
    return this.afterSales.create(
      ctx,
      detail.line.orderId,
      CreateAfterSalesCaseInputSchema.parse(body),
    );
  }
  @Post("cases/:id/decisions")
  @RequiresPermission(Permission.OrderWrite)
  decision(
    @Req() request: AuthenticatedRequest,
    @Param("id") value: string,
    @Body() body: unknown,
  ) {
    return this.afterSales.decide(
      context(request),
      id(value),
      DecideAfterSalesCaseInputSchema.parse(body),
    );
  }
  @Post("cases/:id/contacts")
  @RequiresPermission(Permission.OrderWrite)
  contact(@Req() request: AuthenticatedRequest, @Param("id") value: string, @Body() body: unknown) {
    return this.afterSales.recordContact(
      context(request),
      id(value),
      RecordCustomerContactInputSchema.parse(body),
    );
  }
  @Post("cases/:id/complete")
  @RequiresPermission(Permission.OrderWrite)
  complete(
    @Req() request: AuthenticatedRequest,
    @Param("id") value: string,
    @Body() body: unknown,
  ) {
    return this.afterSales.complete(context(request), id(value), body);
  }
}
function context(request: AuthenticatedRequest) {
  if (!request.tenantContext) throw new Error("Tenant context is required");
  return request.tenantContext;
}
