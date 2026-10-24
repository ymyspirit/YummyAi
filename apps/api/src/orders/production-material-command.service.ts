import { createHash } from "node:crypto";
import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { SecretVault } from "@yummyai/ai-core";
import { Permission, intersectPermissionContexts, requireTenantOrderPermissions } from "@yummyai/authz";
import { catalogContextAuthority } from "@yummyai/catalog-core";
import { createEntityId, TenantContextSchema, type TenantContext } from "@yummyai/contracts";
import { canonicalJson } from "@yummyai/contracts/common/canonical-json";
import { RecordProductionMaterialSchema, type RecordProductionMaterial } from "@yummyai/contracts/order/material-execution";
import { MaterialCommandListSchema, MaterialCommandViewSchema, type MaterialCommandView } from "@yummyai/contracts/order/material-command";
import { productionMaterialCommands as commands, productionMaterialEntries as entries, productionOrders, orders,
  withTenant, type DatabaseConnection, type TenantTransaction } from "@yummyai/database";
import { currentOrderAuthority, hasTenantOrderPermissions, expireMaterialCommandInputs } from "@yummyai/order-core";
import { and, eq, isNull, sql } from "drizzle-orm";
import { AuditService } from "../audit/audit.service.js";
import { DATABASE_CONNECTION, ORDER_PII_VAULT } from "../platform.tokens.js";
import { ProductionMaterialService } from "./production-material.service.js";

type Command = typeof commands.$inferSelect;
const readPermissions = [Permission.OrderRead, Permission.InventoryRead];
const writePermissions = [...readPermissions, Permission.OrderWrite, Permission.InventoryWrite];

@Injectable()
export class ProductionMaterialCommandService {
  constructor(@Inject(DATABASE_CONNECTION) private readonly database: DatabaseConnection,
    @Inject(ORDER_PII_VAULT) private readonly vault: SecretVault,
    @Inject(ProductionMaterialService) private readonly materials: ProductionMaterialService,
    @Inject(AuditService) private readonly audit: AuditService) {}

  prepare(context: TenantContext, productionOrderId: string, raw: unknown) {
    const input = RecordProductionMaterialSchema.parse(raw), checksum = hash(canonicalJson(input));
    return this.withOwner(context, productionOrderId, true, async (tx, current) => {
      await expireMaterialCommandInputs(tx, { actorId: current.userId, productionOrderId });
      const [old] = await tx.select().from(commands).where(and(eq(commands.productionOrderId, productionOrderId), eq(commands.requestKey, input.idempotencyKey)));
      if (old) {
        if (old.createdBy !== current.userId || old.requestChecksum !== checksum) throw new ConflictException("本次物料提交的原操作员或填写发生变化 请先核对原记录");
        return this.view(tx, current, old);
      }
      const [pending] = await tx.select({ id: commands.id }).from(commands).where(and(eq(commands.productionOrderId, productionOrderId), eq(commands.createdBy, current.userId), isNull(commands.acknowledgedAt)));
      if (pending) throw new ConflictException("请先核对上一笔物料提交的结果");
      const [receipt] = await tx.select().from(entries).where(and(eq(entries.productionOrderId, productionOrderId), eq(entries.idempotencyKey, input.idempotencyKey)));
      if (receipt) {
        if (receipt.createdBy !== current.userId || receipt.requestChecksum !== checksum) throw new ConflictException("原物料编号已经用于其他操作员或填写");
      } else await this.materials.validateCommandInTransaction(tx, current, productionOrderId, input);
      const [row] = await tx.insert(commands).values({ id: createEntityId(), tenantId: current.tenantId, productionOrderId, bindingId: input.bindingId,
        createdBy: current.userId, requestKey: input.idempotencyKey, requestChecksum: checksum, authoritySnapshot: current,
        encryptedInput: this.vault.encrypt(canonicalJson(input)), expiresAt: sql`clock_timestamp()+interval '7 days'`,
        status: receipt ? "succeeded" : "prepared", entryId: receipt?.id ?? null, completedAt: receipt ? sql`clock_timestamp()` : null }).returning();
      await this.audit.recordInTransaction(tx, current, { action: "production_material.command.prepare", resourceType: "production_material_command", resourceId: row!.id,
        result: "success", metadata: { productionOrderId, bindingId: input.bindingId, existingReceipt: Boolean(receipt) } });
      return this.view(tx, current, row!);
    });
  }

  list(context: TenantContext, productionOrderId: string) {
    return this.withOwner(context, productionOrderId, false, async (tx, current) => {
      await expireMaterialCommandInputs(tx, { actorId: current.userId, productionOrderId });
      const rows = await tx.select().from(commands).where(and(eq(commands.productionOrderId, productionOrderId), eq(commands.createdBy, current.userId), isNull(commands.acknowledgedAt)));
      return MaterialCommandListSchema.parse({ items: await Promise.all(rows.map(row => this.view(tx, current, row))), contextAuthority: catalogContextAuthority(current) });
    });
  }
  get(context: TenantContext, productionOrderId: string, commandId: string) {
    return this.withOwner(context, productionOrderId, false, async (tx, current) => {
      await expireMaterialCommandInputs(tx, { actorId: current.userId, productionOrderId });
      return this.view(tx, current, await this.row(tx, current, productionOrderId, commandId));
    });
  }
  execute(context: TenantContext, productionOrderId: string, commandId: string) {
    return this.withOwner(context, productionOrderId, true, async (tx, current) => {
      await expireMaterialCommandInputs(tx, { actorId: current.userId, productionOrderId });
      const row = await this.row(tx, current, productionOrderId, commandId);
      if (row.status !== "prepared") return this.view(tx, current, row);
      let input: RecordProductionMaterial;
      try { input = this.input(row); } catch {
        return this.reject(tx, current, row, "input_unavailable", true);
      }
      const ceiling = intersectPermissionContexts(TenantContextSchema.parse(row.authoritySnapshot), current);
      requireTenantOrderPermissions(ceiling, writePermissions);
      let entryId: string;
      try {
        // A domain rejection rolls back every possible stock/receipt write before
        // the command stores a rejected outcome. Transport/audit failures propagate.
        const result = await tx.transaction(nested => this.materials.recordInTransaction(nested, ceiling, productionOrderId, input, row.id));
        entryId = result.entry.id;
      } catch (error) {
        if (!(error instanceof ConflictException || error instanceof NotFoundException)) throw error;
        return this.reject(tx, current, row, "basis_changed");
      }
      const [saved] = await tx.update(commands).set({ status: "succeeded", entryId, completedAt: sql`clock_timestamp()` }).where(eq(commands.id, row.id)).returning();
      await this.audit.recordInTransaction(tx, current, { action: "production_material.command.execute", resourceType: "production_material_command", resourceId: row.id,
        result: "success", metadata: { productionOrderId, entryId } });
      return this.view(tx, current, saved!);
    });
  }
  cancel(context: TenantContext, productionOrderId: string, commandId: string) {
    return this.withOwner(context, productionOrderId, false, async (tx, current) => {
      await expireMaterialCommandInputs(tx, { actorId: current.userId, productionOrderId });
      const row = await this.row(tx, current, productionOrderId, commandId);
      if (row.status !== "prepared") return this.view(tx, current, row);
      const [saved] = await tx.update(commands).set({ status: "cancelled", completedAt: sql`clock_timestamp()`, encryptedInput: null, redactedAt: sql`clock_timestamp()` }).where(eq(commands.id, row.id)).returning();
      await this.audit.recordInTransaction(tx, current, { action: "production_material.command.cancel", resourceType: "production_material_command", resourceId: row.id,
        result: "success", metadata: { productionOrderId } });
      return this.view(tx, current, saved!);
    });
  }
  acknowledge(context: TenantContext, productionOrderId: string, commandId: string) {
    return this.withOwner(context, productionOrderId, false, async (tx, current) => {
      await expireMaterialCommandInputs(tx, { actorId: current.userId, productionOrderId });
      const row = await this.row(tx, current, productionOrderId, commandId);
      if (row.status === "prepared") throw new ConflictException("本次物料提交仍待核对 请先执行或取消");
      if (row.acknowledgedAt) return this.view(tx, current, row);
      const [saved] = await tx.update(commands).set({ acknowledgedAt: sql`clock_timestamp()`, encryptedInput: null,
        redactedAt: sql`coalesce(${commands.redactedAt},clock_timestamp())` }).where(eq(commands.id, row.id)).returning();
      await this.audit.recordInTransaction(tx, current, { action: "production_material.command.acknowledge", resourceType: "production_material_command", resourceId: row.id,
        result: "success", metadata: { productionOrderId } });
      return this.view(tx, current, saved!);
    });
  }
  private async reject(tx: TenantTransaction, current: TenantContext, row: Command, errorCode: MaterialCommandView["errorCode"], redact = false) {
    const [saved] = await tx.update(commands).set({ status: "rejected", errorCode, completedAt: sql`clock_timestamp()`,
      ...(redact ? { encryptedInput: null, redactedAt: sql`clock_timestamp()` } : {}) }).where(eq(commands.id, row.id)).returning();
    await this.audit.recordInTransaction(tx, current, { action: "production_material.command.reject", resourceType: "production_material_command", resourceId: row.id,
      result: "success", metadata: { productionOrderId: row.productionOrderId, errorCode } });
    return this.view(tx, current, saved!);
  }
  private input(row: Command) {
    if (!row.encryptedInput || row.contractVersion !== "material-command-v1") throw new Error("Original material input unavailable");
    const input = this.vault.withSecret(row.encryptedInput, text => RecordProductionMaterialSchema.parse(JSON.parse(text)));
    if (hash(canonicalJson(input)) !== row.requestChecksum || input.bindingId !== row.bindingId || input.idempotencyKey !== row.requestKey) throw new Error("Original material checksum differs");
    return input;
  }
  private async view(tx: TenantTransaction, current: TenantContext, row: Command) {
    let input: RecordProductionMaterial | null = null;
    if (row.encryptedInput) { try { input = this.input(row); } catch { /* Unavailable original data is never replaced with caller input. */ } }
    const ceiling = intersectPermissionContexts(TenantContextSchema.parse(row.authoritySnapshot), current);
    return MaterialCommandViewSchema.parse({ id: row.id, productionOrderId: row.productionOrderId, bindingId: row.bindingId, requestKey: row.requestKey, status: row.status,
      contextAuthority: catalogContextAuthority(current), createdAt: row.createdAt.toISOString(), expiresAt: row.expiresAt.toISOString(), acknowledged: Boolean(row.acknowledgedAt),
      canExecute: row.status === "prepared" && Boolean(input) && hasTenantOrderPermissions(ceiling, writePermissions), canCancel: row.status === "prepared",
      input, receipt: row.entryId ? await this.materials.entryInTransaction(tx, ceiling, row.entryId) : null, errorCode: row.errorCode });
  }
  private async row(tx: TenantTransaction, current: TenantContext, productionOrderId: string, commandId: string) {
    const [row] = await tx.select().from(commands).where(and(eq(commands.id, commandId), eq(commands.productionOrderId, productionOrderId), eq(commands.createdBy, current.userId))).for("update");
    if (!row) throw new NotFoundException("本人的原物料提交不存在");
    return row;
  }
  private withOwner<T>(context: TenantContext, productionOrderId: string, write: boolean, apply: (tx: TenantTransaction, current: TenantContext) => Promise<T>) {
    return withTenant(this.database.db, context, async tx => {
      const current = await currentOrderAuthority(tx, context, write ? writePermissions : readPermissions, { requireMembership: true });
      const [owner] = await tx.select({ orderId: productionOrders.orderId }).from(productionOrders).where(eq(productionOrders.id, productionOrderId));
      if (!owner) throw new NotFoundException("Production order not found");
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${owner.orderId},0))`);
      await tx.select({ id: orders.id }).from(orders).where(eq(orders.id, owner.orderId)).for("update");
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'production-order:'+productionOrderId},0))`);
      return apply(tx, current);
    });
  }
}
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
