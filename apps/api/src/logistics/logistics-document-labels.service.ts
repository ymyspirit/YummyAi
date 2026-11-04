import { createHash } from "node:crypto";
import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { Permission } from "@yummyai/authz";
import type { SecretVault } from "@yummyai/ai-core";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { canonicalJson } from "@yummyai/contracts/common/canonical-json";
import { RegisterDocumentLabelSchema, DownloadYicaiHandoffSchema, PreviewOrderDocumentsSchema,
  type PreviewOrderDocuments, type DocumentLabelView } from "@yummyai/contracts/logistics/documents";
import { logisticsDocumentLabels as labels, type DatabaseConnection, type TenantTransaction } from "@yummyai/database";
import { currentOrderAuthority, withOrderAuthority } from "@yummyai/order-core";
import { logisticsLock, purgeDocumentExports } from "@yummyai/logistics";
import { ClamAvScanner } from "@yummyai/storage";
import { desc, eq } from "drizzle-orm";
import JSZip from "jszip";
import { z } from "zod";
import { AuditService } from "../audit/audit.service.js";
import { OrderProductionDeliveryService } from "../orders/order-production-delivery.service.js";
import { DATABASE_CONNECTION, ORDER_PII_VAULT, DOCUMENT_FILE_SCANNER } from "../platform.tokens.js";
import { originalOwnerOperation } from "../shared/original-owner-error.js";
import { LogisticsDocumentsService } from "./logistics-documents.service.js";

const permissions = [Permission.OrderRead, Permission.OrderPiiRead];
const sha = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
type PrivateLabel = { version: 1; input: PreviewOrderDocuments; trackingNumber: string; fileName: string; pdf: string };

@Injectable()
export class LogisticsDocumentLabelsService {
  constructor(@Inject(DATABASE_CONNECTION) private readonly database: DatabaseConnection,
    @Inject(ORDER_PII_VAULT) private readonly vault: SecretVault,
    @Inject(LogisticsDocumentsService) private readonly documents: LogisticsDocumentsService,
    @Inject(OrderProductionDeliveryService) private readonly delivery: OrderProductionDeliveryService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(DOCUMENT_FILE_SCANNER) private readonly scanner: Pick<ClamAvScanner, "scan"> = new ClamAvScanner()) {}

  async register(context: TenantContext, raw: unknown) {
    const input = RegisterDocumentLabelSchema.parse(raw), bytes = Buffer.from(input.base64, "base64");
    try {
      if (bytes.byteLength > 5 * 1024 * 1024 || bytes.subarray(0, 5).toString() !== "%PDF-" || !bytes.subarray(-2048).includes(Buffer.from("%%EOF")))
        throw new ConflictException("请上传不超过 5 MiB 的完整 PDF 面单");
      const checksum = sha(bytes), digest = sha(canonicalJson({ exportId: input.exportId, orderId: input.orderId,
        expectedFingerprint: input.expectedFingerprint, trackingNumber: input.trackingNumber, fileName: input.fileName, checksum, verified: true }));
      await withOrderAuthority(this.database.db, context, [...permissions, Permission.OrderWrite], async tx => {
        const source = await this.documents.currentExportInTransaction(tx, context, input.exportId, input.orderId);
        this.assertCurrent(source.preview.ready, source.preview.fingerprint, input.expectedFingerprint);
      });
      const scan = await this.scanner.scan({ body: bytes, fileName: input.fileName, mediaType: "application/pdf" });
      if (scan.result !== "clean" || scan.signatureVersion === "unavailable") throw new ConflictException("面单文件扫描未通过 请核对文件后重试");
      return await originalOwnerOperation(() => withOrderAuthority(this.database.db, context, [...permissions, Permission.OrderWrite], async tx => {
        await logisticsLock(tx, context, `document-label:${input.orderId}`);
        const source = await this.documents.currentExportInTransaction(tx, context, input.exportId, input.orderId);
        this.assertCurrent(source.preview.ready, source.preview.fingerprint, input.expectedFingerprint);
        const [replay] = await tx.select().from(labels).where(eq(labels.requestKey, input.idempotencyKey));
        if (replay) {
          if (replay.requestHash !== digest || replay.createdBy !== context.userId) throw new ConflictException("请求编号已用于其他面单登记");
          return { id: replay.id, reused: true };
        }
        const [latest] = await tx.select().from(labels).where(eq(labels.orderId, input.orderId)).orderBy(desc(labels.createdAt), desc(labels.id)).limit(1);
        if (latest?.requestHash === digest && latest.encryptedSnapshot) return { id: latest.id, reused: true };
        const id = createEntityId();
        await tx.insert(labels).values({ id, tenantId: context.tenantId, createdBy: context.userId, exportId: input.exportId, orderId: input.orderId,
          requestKey: input.idempotencyKey, requestHash: digest, sourceFingerprint: source.preview.fingerprint, fileChecksum: checksum, byteSize: bytes.byteLength,
          encryptedSnapshot: this.vault.encrypt(JSON.stringify({ version: 1, input: source.input, trackingNumber: input.trackingNumber, fileName: input.fileName, pdf: bytes.toString("base64") } satisfies PrivateLabel)),
          scanEvidence: { engine: scan.engine, signatureVersion: scan.signatureVersion, scannedAt: scan.scannedAt }, expiresAt: source.expiresAt });
        await this.audit.recordInTransaction(tx, context, { action: "logistics.documents.label_registered", resourceType: "logistics_document_label", resourceId: id, result: "success",
          metadata: { exportId: input.exportId, orderId: input.orderId, checksum, scanEngine: scan.engine, operatorVerified: true } });
        return { id, reused: false };
      }));
    } finally { bytes.fill(0); }
  }

  async list(context: TenantContext, raw: unknown) {
    const query = z.object({ orderId: z.uuidv7() }).strict().parse(raw);
    return originalOwnerOperation(() => withOrderAuthority(this.database.db, context, permissions, async tx => {
      await purgeDocumentExports(tx);
      const rows = await tx.select().from(labels).where(eq(labels.orderId, query.orderId)).orderBy(desc(labels.createdAt), desc(labels.id)).limit(30);
      const result: DocumentLabelView[] = [];
      for (const [index, row] of rows.entries()) {
        if (!row.encryptedSnapshot || row.expiresAt <= new Date()) continue;
        const data = this.open(row.encryptedSnapshot);
        let available = index === 0, reason: string | null = index === 0 ? null : "已有更新的面单记录";
        let orderNumber = "资料不可用";
        try {
          const source = await this.documents.currentSelectionInTransaction(tx, context, data.input);
          orderNumber = source.preview.orders[0]!.orderNumber;
          if (!source.preview.ready || source.preview.fingerprint !== row.sourceFingerprint) { available = false; reason = "订单或包裹资料已变化 请核对云途原订单后重新登记"; }
        } catch { available = false; reason = "原订单或工厂配置当前不可用"; }
        result.push({ id: row.id, orderId: row.orderId, orderNumber, trackingNumber: data.trackingNumber, fileName: data.fileName, createdAt: row.createdAt.toISOString(), available, reason });
      }
      return { labels: result };
    }));
  }

  async basis(context: TenantContext, exportId: string, orderId: string) {
    return originalOwnerOperation(() => withOrderAuthority(this.database.db, context, permissions, async tx => {
      const source = await this.documents.currentExportInTransaction(tx, context, exportId, orderId);
      return source.preview;
    }));
  }

  async download(context: TenantContext, id: string) {
    await withOrderAuthority(this.database.db, context, permissions, tx => purgeDocumentExports(tx));
    return originalOwnerOperation(() => withOrderAuthority(this.database.db, context, permissions, async tx => {
      const source = await this.current(tx, context, id), body = Buffer.from(source.data.pdf, "base64");
      if (body.byteLength !== source.row.byteSize || sha(body) !== source.row.fileChecksum) { body.fill(0); throw new ConflictException("面单完整性校验失败"); }
      await this.audit.recordInTransaction(tx, context, { action: "logistics.documents.label_downloaded", resourceType: "logistics_document_label", resourceId: id, result: "success" });
      return { body, name: `yunexpress-${id}.pdf`, mediaType: "application/pdf" };
    }));
  }

  async handoff(context: TenantContext, raw: unknown) {
    const input = DownloadYicaiHandoffSchema.parse(raw);
    const readSource = (tx: TenantTransaction) => this.handoffSource(tx, context, input.labelId, input.deliveryPackageIds);
    const source = await originalOwnerOperation(() => withOrderAuthority(this.database.db, context, permissions, readSource));
    const zip = new JSZip(), buffers: Buffer[] = [], created = source.row.createdAt;
    const orderNumber = source.source.preview.orders[0]!.orderNumber;
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/.test(orderNumber)) throw new ConflictException("订单编号不适合直接作为交付目录名 请核对原订单编号");
    let total = 0, expanded = 0;
    try {
      const manifest = [];
      for (const packageId of input.deliveryPackageIds) {
        const original = await this.delivery.download(context, packageId); buffers.push(original.body);
        total += original.body.byteLength; if (total > 256 * 1024 * 1024) throw new ConflictException("交付包超过 256 MiB 请拆分订单交付");
        const approved = await JSZip.loadAsync(original.body);
        const originalManifest = approved.file("manifest.json");
        if (!originalManifest) throw new ConflictException("原正式生产交付清单缺失");
        zip.file(`原生产交付清单/${packageId}.json`, await originalManifest.async("nodebuffer"), { date: created });
        for (const pin of source.pins) {
          const originalFile = approved.file(pin.file.path); if (!originalFile) continue;
          const bytes = await originalFile.async("nodebuffer"); buffers.push(bytes);
          expanded += bytes.byteLength;
          if (expanded > 256 * 1024 * 1024) throw new ConflictException("生产文件合计超过 256 MiB 请拆分订单交付");
          if (sha(bytes) !== pin.file.checksum) throw new ConflictException("正式生产文件完整性校验失败");
          const cm = Number((pin.sizeMm / 10).toFixed(3)), name = `${orderNumber}/${cm}cm_${pin.orderLineId}.jpg`;
          zip.file(name, bytes, { date: created });
          manifest.push({ name, orderNumber, orderLineId: pin.orderLineId, quantity: pin.quantity, declaredLongestCm: cm,
            sizeBasis: pin.sizeBasis, sideMode: pin.sideMode, factoryStandardId: pin.factoryStandardId, ruleSnapshotChecksum: pin.ruleSnapshotChecksum,
            originalPackageId: packageId, originalPath: pin.file.path, sha256: pin.file.checksum });
        }
      }
      if (manifest.length !== source.pins.length) throw new ConflictException("原交付包未完整提供所有商品文件");
      const pdf = Buffer.from(source.data.pdf, "base64"); buffers.push(pdf);
      if (sha(pdf) !== source.row.fileChecksum) throw new ConflictException("面单完整性校验失败");
      zip.file(`${orderNumber}/云途面单.pdf`, pdf, { date: created });
      zip.file(`${orderNumber}/交付清单.json`, canonicalJson({ version: 1, labelId: source.row.id, trackingNumber: source.data.trackingNumber,
        labelSha256: source.row.fileChecksum, items: manifest }), { date: created });
      zip.file(`${orderNumber}/生产说明.txt`, "按原正式交付清单中的工艺、尺寸口径、数量和单双面制作。文件名的 cm 是已审核稿声明的最长边，具体口径见交付清单 sizeBasis。已保留原 JPG 字节，不得擅自缩放、改 DPI 或改动图案。面单来自运营核对的云途 PDF。下载本包不代表工厂接单、开产或已经交运。", { date: created });
      const body = await zip.generateAsync({ type: "nodebuffer", compression: "STORE" });
      try {
        if (body.byteLength > 256 * 1024 * 1024) throw new ConflictException("交付文件夹超过 256 MiB 请拆分订单交付");
        await originalOwnerOperation(() => withOrderAuthority(this.database.db, context, permissions, async tx => {
          const current = await readSource(tx);
          if (current.digest !== source.digest) throw new ConflictException("生产文件或面单版本已变化 请重新下载");
          await this.audit.recordInTransaction(tx, context, { action: "logistics.documents.yicai_downloaded", resourceType: "logistics_document_label", resourceId: input.labelId,
            result: "success", metadata: { deliveryPackageIds: input.deliveryPackageIds, checksum: sha(body), sourceFingerprint: current.digest } });
        }));
      } catch (error) { body.fill(0); throw error; }
      return { body, name: `yicai-${input.labelId}.zip`, mediaType: "application/zip" };
    } finally { buffers.forEach(buffer => buffer.fill(0)); }
  }

  private async handoffSource(tx: TenantTransaction, context: TenantContext, id: string, packageIds: string[]) {
    await currentOrderAuthority(tx, context, [...permissions, Permission.DesignRead, Permission.AssetRead]);
    const pins = await this.delivery.documentItemsInTransaction(tx, context, packageIds);
    const current = await this.current(tx, context, id);
    if (current.source.profile.profile.productionAdapter !== "yicai_folder") throw new ConflictException("此工厂未配置义彩交付方式");
    const lines = current.source.sources[0]!.source.lines;
    if (pins.length !== lines.length || pins.some(pin => !lines.some(line => line.id === pin.orderLineId && line.quantity === pin.quantity) || pin.factory?.factoryId !== current.source.profile.factoryId))
      throw new ConflictException("交付包必须完整匹配本单全部商品、数量与实际工厂");
    return { ...current, pins, digest: sha(canonicalJson({ label: current.row.id, source: current.row.sourceFingerprint,
      pins: pins.map(pin => ({ line: pin.orderLineId, version: pin.productionVersionId, checksum: pin.file.checksum, path: pin.file.path })) })) };
  }
  private async current(tx: TenantTransaction, context: TenantContext, id: string) {
    const [row] = await tx.select().from(labels).where(eq(labels.id, id)).for("share");
    if (!row) throw new NotFoundException("面单不存在或无权访问");
    await logisticsLock(tx, context, `document-label:${row.orderId}`);
    const [latest] = await tx.select({ id: labels.id }).from(labels).where(eq(labels.orderId, row.orderId)).orderBy(desc(labels.createdAt), desc(labels.id)).limit(1);
    if (latest?.id !== id) throw new ConflictException("已有更新的面单记录 请使用最新版本");
    if (!row.encryptedSnapshot || row.expiresAt <= new Date()) throw new ConflictException("面单资料已到期或清理");
    const data = this.open(row.encryptedSnapshot), source = await this.documents.currentSelectionInTransaction(tx, context, data.input);
    this.assertCurrent(source.preview.ready, source.preview.fingerprint, row.sourceFingerprint);
    return { row, data, source };
  }
  private open(cipher: string): PrivateLabel {
    const value = this.vault.withSecret(cipher, secret => JSON.parse(secret) as PrivateLabel);
    if (value.version !== 1 || typeof value.pdf !== "string" || value.pdf.length > 7_000_000) throw new ConflictException("面单资料格式错误");
    return { ...value, input: PreviewOrderDocumentsSchema.parse(value.input) };
  }
  private assertCurrent(ready: boolean, actual: string, expected: string) { if (!ready || actual !== expected) throw new ConflictException("订单或包裹资料已变化 请核对云途原订单与当前地址后重新登记"); }
}
