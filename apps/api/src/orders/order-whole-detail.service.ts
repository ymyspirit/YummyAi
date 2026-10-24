import { Inject, Injectable } from "@nestjs/common";
import type { TenantContext } from "@yummyai/contracts";
import { WholeOrderDetailViewSchema } from "@yummyai/contracts/order/whole-detail";
import { OrderOperationsViewSchema } from "@yummyai/contracts/order/workspace";
import { OrderWorkspaceService } from "./order-workspace.service.js";
import { OrderProductionService } from "./order-production.service.js";
import { OrderShipmentService } from "./order-shipment.service.js";
import { OrderAfterSalesService } from "./order-after-sales.service.js";
import { ProductionEditorService } from "../design/production-editor.service.js";
import { ShiposService } from "../suppliers/shipos.service.js";
import { readOrderSection as readSection } from "./order-read-section.js";

/** Read composition reuses module services and preserves independent failures. */
@Injectable()
export class OrderWholeDetailService {
  constructor(
    @Inject(OrderWorkspaceService) private readonly work: OrderWorkspaceService,
    @Inject(OrderProductionService) private readonly production: OrderProductionService,
    @Inject(OrderShipmentService) private readonly shipments: OrderShipmentService,
    @Inject(OrderAfterSalesService) private readonly cases: OrderAfterSalesService,
    @Inject(ProductionEditorService) private readonly editor: ProductionEditorService,
    @Inject(ShiposService) private readonly shipos: ShiposService,
  ) {}

  async get(context: TenantContext, lineId: string) {
    const source = await this.work.orderItems(context, lineId);
    const orderId = source.orderId;
    const [summaries, fulfillment, production, shipments, cases, shipos] = await Promise.all([
      readSection(() => this.work.summaries(context, { ids: source.items.map(item => item.line.id) }), "定制要求"),
      readSection(() => this.production.wholeOrderFulfillment(context, orderId), "整单操作条件"),
      readSection(async () => OrderOperationsViewSchema.shape.production.parse(transport(await Promise.all((await this.production.list(context, orderId)).map(row => this.production.get(context, row.id))))), "生产记录"),
      readSection(async () => OrderOperationsViewSchema.shape.shipments.parse(transport(await Promise.all((await this.shipments.list(context, orderId)).map(row => this.shipments.get(context, row.id))))), "运单记录"),
      readSection(async () => OrderOperationsViewSchema.shape.cases.parse(transport(await Promise.all((await this.cases.list(context, orderId)).map(row => this.cases.getPrivate(context, row.id))))), "售后记录"),
      readSection(() => this.shipos.orderEvidence(context, orderId), "ShipOS 已同步运单"),
    ]);
    const items = [];
    // Bound concurrency: each editor read owns tenant transactions and private assets.
    for (const item of source.items) {
      const artwork = await readSection(async () => {
        if (!item.line.editorProjectId) return null;
        const editor = await this.editor.get(context, item.line.editorProjectId);
        const approved = item.approvedEditorVersionId === editor.version.id && editor.versions.some(row => row.id === editor.version.id && row.reviewed);
        const renders = editor.renders.filter(row => row.versionId === editor.version.id).toSorted((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
        const previewRender = renders.find(row => ["production", "preview"].includes(row.purpose) && row.status === "completed" && row.files.some(file => ["image/png", "image/jpeg", "image/webp"].includes(file.mediaType)));
        const file = previewRender?.files.find(file => ["image/png", "image/jpeg", "image/webp"].includes(file.mediaType));
        const formal = approved ? renders.find(row => row.purpose === "production" && row.status === "completed" && row.preflight?.productionReady && row.files.length) : null;
        const link = (renderId: string, key: string, name: string) => ({ name, path: `/api/production-editor/projects/${editor.project.id}/renders/${renderId}/files/${encodeURIComponent(key)}` });
        return {
          versionId: editor.version.id, versionNumber: editor.version.versionNumber, approved,
          approvedVersionNumber: editor.versions.find(row => row.id === item.approvedEditorVersionId)?.versionNumber ?? null,
          preview: previewRender && file ? link(previewRender.id, file.key, file.name) : null,
          productionFile: formal ? link(formal.id, formal.files[0]!.key, formal.files[0]!.name) : null,
          productionPending: renders.some(row => row.purpose === "production" && ["queued", "processing"].includes(row.status)),
        };
      }, "审核稿");
      items.push({ line: item.line, artwork, summary: { data: summaries.data?.items.find(row => row.id === item.line.id) ?? null, error: summaries.error } });
    }
    return WholeOrderDetailViewSchema.parse({ orderId, orderSequence: source.orderSequence, items, fulfillment, production, shipments, cases, shipos });
  }
}

/** Module reads contain Dates; match the existing REST serialization before validation. */
function transport(value: unknown): unknown { return JSON.parse(JSON.stringify(value)); }
