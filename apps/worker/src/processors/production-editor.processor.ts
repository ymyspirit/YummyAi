import { createHash } from "node:crypto";
import type { SecretVault } from "@yummyai/ai-core";
import { createEntityId, ProductionEditorDocumentSchema, ProductionEditorExportOptionsSchema, type TenantContext, type ProductionEditorExportOptions } from "@yummyai/contracts";
import { productionEditorProjects as projects, productionEditorVersions as versions, productionEditorImages as images, productionEditorRenders as renders, amazonOrderReportLines, orders, withTenant, type DatabaseConnection } from "@yummyai/database";
import { ProductionEditorRenderJobPayloadSchema, type JobEnvelope } from "@yummyai/jobs";
import { decryptProductionBytes, encryptProductionBytes, getBuiltinFont, renderProductionDocument } from "@yummyai/production-editor";
import type { Storage, AssetDomain } from "@yummyai/storage";
import { and, eq } from "drizzle-orm";

type Project = typeof projects.$inferSelect;

/** Queue data contains only immutable task identity. Customer documents and files are hydrated inside RLS. */
export class ProductionEditorRenderProcessor {
  constructor(private readonly database: DatabaseConnection, private readonly storage: Storage, private readonly vault: SecretVault) {}

  async process(envelope: JobEnvelope, signal = new AbortController().signal) {
    const { renderId } = ProductionEditorRenderJobPayloadSchema.parse(envelope.payload);
    const context: TenantContext = { tenantId: envelope.tenantId, userId: envelope.requestedBy, dataScope: "tenant", permissions: ["design:read", "asset:read", "order:read", "order:pii:read"] };
    const token = createEntityId();
    const claimed = await withTenant(this.database.db, context, async (tx) => {
      const [row] = await tx.select().from(renders).where(eq(renders.id, renderId)).for("update");
      if (!row) throw new Error("production_render_not_found");
      if (row.status === "completed") return null;
      // BullMQ may redeliver a stalled job without incrementing attempts. Its queue lock
      // owns delivery; replacing the token also prevents an older process from committing.
      await tx.update(renders).set({ status: "processing", processingToken: token, startedAt: new Date(), attempt: envelope.attempt, errorCode: null, updatedAt: new Date() }).where(eq(renders.id, renderId));
      return row;
    });
    if (!claimed) return { renderId, disposition: "already_claimed" as const };
    let activeKey: Buffer | undefined;
    try {
      if (signal.aborted) throw new Error("production_render_aborted");
      const project = await this.project(context, claimed.projectId), key = this.key(project);
      activeKey = key;
      const options = ProductionEditorExportOptionsSchema.parse(openJson(key, claimed.encryptedOptions));
      this.assertVersion(project, claimed.versionId, options);
      const [version] = await withTenant(this.database.db, context, (tx) => tx.select().from(versions).where(and(eq(versions.id, claimed.versionId), eq(versions.projectId, project.id))));
      if (!version) throw new Error("production_version_not_found");
      const document = ProductionEditorDocumentSchema.parse(openJson(key, version.encryptedDocument));
      if (createHash("sha256").update(JSON.stringify(document)).digest("hex") !== version.checksum) throw new Error("production_version_checksum_mismatch");
      const resolve = async (assetId: string, kind: "image" | "font") => {
        const [asset] = await withTenant(this.database.db, context, (tx) => tx.select().from(images).where(and(eq(images.id, assetId), eq(images.projectId, project.id))));
        if (!asset) throw new Error("production_asset_not_found");
        const metadata = openJson<{ kind: string }>(key, asset.encryptedMetadata);
        if (metadata.kind !== kind) throw new Error("production_asset_type_mismatch");
        const bytes = await this.read(context, project, asset.originalObjectKey);
        if (createHash("sha256").update(bytes).digest("hex") !== asset.checksum) throw new Error("production_asset_checksum_mismatch");
        return { bytes };
      };
      const result = await renderProductionDocument(document, options, {
        resolveAsset: async (id, version) => { if (version !== 1) throw new Error("production_asset_version_mismatch"); return resolve(id, "image"); },
        resolveFont: (id) => id === "geist_regular" ? getBuiltinFont(id) : resolve(id, "font"),
      });
      if (signal.aborted) throw new Error("production_render_aborted");
      if (options.purpose === "production" && !result.preflight.productionReady) throw new Error("production_preflight_failed");
      this.assertVersion(await this.project(context, project.id), claimed.versionId, options);
      const domain = this.domain(project), extension = options.format === "jpeg" ? "jpg" : options.format === "tiff" ? "tif" : "png";
      const object = await this.storage.putPrivate(context, { body: encryptProductionBytes(key, result.bytes), domain, fileName: `${renderId}-result.pe`, mediaType: "application/octet-stream" });
      const manifest = { files: [{ key: "result", name: `${options.purpose}-${renderId}.${extension}`, mediaType: result.mediaType, byteSize: result.bytes.byteLength, objectKey: object.objectKey }], preflight: result.preflight };
      // Revalidate source and retention after storage I/O and before committing a downloadable result.
      this.assertVersion(await this.project(context, project.id), claimed.versionId, options);
      await withTenant(this.database.db, context, async (tx) => {
        const [locked] = await tx.select().from(projects).where(eq(projects.id, project.id)).for("update");
        if (!locked?.encryptedDataKey || locked.status !== "active" || locked.expiresAt && locked.expiresAt <= new Date()) throw new Error("production_project_expired");
        this.assertVersion(locked, claimed.versionId, options);
        const updated = await tx.update(renders).set({ status: "completed", encryptedManifest: encryptProductionBytes(key, Buffer.from(JSON.stringify(manifest))).toString("base64"), processingToken: null, startedAt: null, errorCode: null, updatedAt: new Date() }).where(and(eq(renders.id, renderId), eq(renders.processingToken, token))).returning({ id: renders.id });
        if (!updated.length) throw new Error("production_claim_lost");
      });
      return { renderId, disposition: "completed" as const };
    } catch (error) {
      // Never persist exception text: renderer/library errors can include customer text or filenames.
      const code = error instanceof Error && /^production_[a-z_]+$/.test(error.message) ? error.message : "production_render_failed";
      await withTenant(this.database.db, context, (tx) => tx.update(renders).set({ status: "failed", errorCode: code, processingToken: null, startedAt: null, updatedAt: new Date() }).where(and(eq(renders.id, renderId), eq(renders.processingToken, token))));
      throw new Error(code);
    } finally { activeKey?.fill(0); }
  }

  private async project(context: TenantContext, id: string): Promise<Project> {
    const [row] = await withTenant(this.database.db, context, (tx) => tx.select().from(projects).where(eq(projects.id, id)));
    if (!row?.encryptedDataKey || row.status !== "active") throw new Error("production_project_unavailable");
    if (row.expiresAt && row.expiresAt <= new Date()) { await this.erase(context, id); throw new Error("production_project_expired"); }
    if (row.sourceReportLineId) {
      const [source] = await withTenant(this.database.db, context, (tx) => tx.select({ report: amazonOrderReportLines, order: orders }).from(amazonOrderReportLines).innerJoin(orders, eq(orders.id, amazonOrderReportLines.orderId)).where(eq(amazonOrderReportLines.id, row.sourceReportLineId!)));
      if (!source || source.report.state === "expired" || source.report.expiresAt <= new Date() || source.order.addressStatus === "anonymized") { await this.erase(context, id); throw new Error("production_source_expired"); }
      if (source.report.currentVersionId !== row.sourceReportVersionId || source.report.reviewedVersionId !== row.sourceReportVersionId || !["ready", "partial"].includes(source.report.state)) throw new Error("production_source_changed");
    }
    return row;
  }
  private assertVersion(project: Project, versionId: string, options: ProductionEditorExportOptions) { if (project.currentVersionId !== versionId || options.purpose === "production" && project.reviewedVersionId !== versionId) throw new Error("production_version_changed"); }
  private key(project: Project) { if (!project.encryptedDataKey) throw new Error("production_project_expired"); return this.vault.withSecret(project.encryptedDataKey, (value) => Buffer.from(value, "base64")); }
  private domain(project: Project): AssetDomain { return project.sourceReportLineId ? "order" : "authorized"; }
  private async read(context: TenantContext, project: Project, objectKey: string) { const domain = this.domain(project); return decryptProductionBytes(this.key(project), await this.storage.readPrivate(context, { id: project.id, tenantId: context.tenantId, assetDomain: domain, objectKey }, { requiredDomain: domain })); }
  private async erase(context: TenantContext, id: string) { await withTenant(this.database.db, context, (tx) => tx.update(projects).set({ encryptedDataKey: null, name: "", status: "expired", updatedAt: new Date() }).where(eq(projects.id, id))); }
}
function openJson<T>(key: Uint8Array, value: string): T { return JSON.parse(decryptProductionBytes(key, Buffer.from(value, "base64")).toString("utf8")) as T; }
