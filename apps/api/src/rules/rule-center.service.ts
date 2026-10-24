import { createHash, randomUUID } from "node:crypto";
import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { authorize, Permission } from "@yummyai/authz";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { SHAPED_PILLOW_FACTORY_STANDARD, ProductionProductTypeSchema } from "@yummyai/contracts/pod/production-editor";
import {
  INITIAL_RULES, RULE_BINDINGS, RuleDefinitionSchema, RuleHistorySchema, RuleVersionSchema, RuleWorkspaceSchema,
  SaveRuleInputSchema, ChangeRuleStateSchema, OrderRuleSnapshotSchema, canEditRuleText, type RuleDefinition,
} from "@yummyai/contracts/rules";
import { businessRules as rules, businessRuleVersions as versions, businessRuleEvents as events, spus, productPlans, productSpecifications, productSpecificationVersions, printProfileVersions, withTenant, type DatabaseConnection, type TenantTransaction } from "@yummyai/database";
import { and, asc, desc, eq, isNotNull, sql } from "drizzle-orm";
import { DATABASE_CONNECTION } from "../platform.tokens.js";
import { AuditService } from "../audit/audit.service.js";

function versionView(row: typeof versions.$inferSelect) {
  const definition = RuleDefinitionSchema.parse(row.definition);
  const execution = RULE_BINDINGS[definition.binding];
  return RuleVersionSchema.parse({ ...definition, id: row.id, ruleId: row.ruleId, version: row.version, createdAt: row.createdAt.toISOString(),
    changeReason: row.changeReason, execution: execution.execution, executionLocation: execution.location });
}
async function writeEvent(tx: TenantTransaction, context: TenantContext, ruleId: string, version: number, action: typeof events.$inferInsert.action, reason: string) {
  await tx.insert(events).values({ id: createEntityId(), tenantId: context.tenantId, createdBy: context.userId, ruleId, version, action, reason });
}
/** Called only when creating a new order design snapshot; resumes use its encrypted copy. */
export async function resolveOrderRules(tx: TenantTransaction, productType: string, spuId: string | null) {
  const rows = await tx.select({ rule: rules, version: versions }).from(rules)
    .innerJoin(versions, and(eq(versions.ruleId, rules.id), eq(versions.version, rules.activeVersion)))
    .where(isNotNull(rules.activeVersion)).orderBy(asc(rules.code));
  return OrderRuleSnapshotSchema.parse({ schemaVersion: 1, capturedAt: new Date().toISOString(), rules: rows.flatMap(({ rule, version }) => {
    const definition = RuleDefinitionSchema.parse(version.definition);
    const matches = definition.appliesTo === "order_design" && (definition.scopeKind === "all" ||
      definition.scopeKind === "product_type" && definition.productType === productType || definition.scopeKind === "spu" && definition.spuId === spuId);
    return matches ? [{ ...versionView(version), code: rule.code }] : [];
  }) });
}

@Injectable()
export class RuleCenterService {
  constructor(@Inject(DATABASE_CONNECTION) private readonly database: DatabaseConnection, @Inject(AuditService) private readonly audit: AuditService) {}

  async workspace(context: TenantContext) {
    authorize(context, Permission.WorkflowRead);
    return withTenant(this.database.db, context, async tx => {
      const rows = await tx.select().from(rules).orderBy(desc(rules.updatedAt), asc(rules.code));
      const versionRows = rows.length ? await tx.select().from(versions).innerJoin(rules, and(eq(rules.id, versions.ruleId),
        sql`(${versions.version} = ${rules.latestVersion} OR ${versions.version} = ${rules.activeVersion})`)) : [];
      const products = await tx.select({ id: spus.id, code: spus.code, name: spus.name }).from(spus).innerJoin(productPlans, eq(productPlans.id, spus.productPlanId)).where(sql`${spus.status} <> 'archived' and ${productPlans.status} <> 'archived'`).orderBy(asc(spus.code));
      const productProcesses = await tx.selectDistinct({ spuId: productSpecifications.spuId, productType: printProfileVersions.productType })
        .from(productSpecifications).innerJoin(productSpecificationVersions, and(eq(productSpecificationVersions.specificationId, productSpecifications.id), eq(productSpecificationVersions.versionNumber, productSpecifications.versionNumber)))
        .innerJoin(printProfileVersions, eq(printProfileVersions.id, productSpecificationVersions.processProfileVersionId));
      return RuleWorkspaceSchema.parse({ rules: rows.map(row => {
        const own = versionRows.filter(v => v.business_rule_versions.ruleId === row.id).map(v => v.business_rule_versions);
        const latest = own.find(v => v.version === row.latestVersion)!;
        const active = own.find(v => v.version === row.activeVersion);
        return { ...row, builtIn: row.code.startsWith("system:"), updatedAt: row.updatedAt.toISOString(), latest: versionView(latest), active: active ? versionView(active) : null };
      }), spus: products.map(product => ({ ...product, productTypes: productProcesses.filter(process => process.spuId === product.id).flatMap(process => {
        const parsed = ProductionProductTypeSchema.safeParse(process.productType); return parsed.success ? [parsed.data] : [];
      }) })), canManage: context.permissions.includes(Permission.WorkflowManage), canPublish: context.permissions.includes(Permission.WorkflowApprove), factoryStandard: SHAPED_PILLOW_FACTORY_STANDARD });
    });
  }

  async history(context: TenantContext, id: string) {
    authorize(context, Permission.WorkflowRead);
    return withTenant(this.database.db, context, async tx => {
      if (!(await tx.select({ id: rules.id }).from(rules).where(eq(rules.id, id)))[0]) throw new NotFoundException("规则不存在");
      const history = await tx.select().from(versions).where(eq(versions.ruleId, id)).orderBy(desc(versions.version));
      const changes = await tx.select().from(events).where(eq(events.ruleId, id)).orderBy(desc(events.createdAt), desc(events.id));
      return RuleHistorySchema.parse({ versions: history.map(versionView), events: changes.map(row => ({ ...row, createdAt: row.createdAt.toISOString() })) });
    });
  }

  async save(context: TenantContext, id: string | null, raw: unknown) {
    authorize(context, Permission.WorkflowManage);
    const input = SaveRuleInputSchema.parse(raw), digest = createHash("sha256").update(JSON.stringify({ id, input })).digest("hex");
    return withTenant(this.database.db, context, async tx => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`rule-save:${context.tenantId}:${input.idempotencyKey}`},0))`);
      const [prior] = await tx.select().from(versions).where(eq(versions.idempotencyKey, input.idempotencyKey));
      if (prior) { if (prior.requestChecksum !== digest) throw new ConflictException("同一保存请求的内容已变化，请刷新"); return { id: prior.ruleId, version: prior.version }; }
      if (input.fields.spuId && !(await tx.select({ id: spus.id }).from(spus).innerJoin(productPlans, eq(productPlans.id, spus.productPlanId)).where(and(eq(spus.id, input.fields.spuId), sql`${spus.status} <> 'archived' and ${productPlans.status} <> 'archived'`)))[0]) throw new NotFoundException("适用 SPU 不存在或已归档");
      const ruleId = id ?? createEntityId();
      let version = 1;
      if (id) {
        const [row] = await tx.select().from(rules).where(eq(rules.id, id)).for("update");
        if (!row) throw new NotFoundException("规则不存在");
        if (row.code.startsWith("system:")) {
          const [latest] = await tx.select().from(versions).where(and(eq(versions.ruleId, id), eq(versions.version, row.latestVersion)));
          if (!latest || !canEditRuleText({ builtIn: true, latest: RuleDefinitionSchema.parse(latest.definition) }))
            throw new ConflictException("内置自动规则由对应工艺和程序维护；文字要求不能改写自动执行能力");
        }
        if (row.revision !== input.expectedRevision) throw new ConflictException("规则已更新，请刷新后重新编辑");
        version = row.latestVersion + 1;
        await tx.update(rules).set({ latestVersion: version, revision: row.revision + 1, updatedAt: new Date() }).where(eq(rules.id, id));
      } else {
        if (input.expectedRevision !== 0) throw new ConflictException("新规则不应带有历史版本");
        await tx.insert(rules).values({ id: ruleId, tenantId: context.tenantId, code: `custom:${ruleId}`, createdBy: context.userId });
      }
      const definition: RuleDefinition = { ...input.fields, binding: "manual" };
      await tx.insert(versions).values({ id: createEntityId(), tenantId: context.tenantId, ruleId, version, definition, scopeSpuId: definition.spuId,
        changeReason: input.changeReason, idempotencyKey: input.idempotencyKey, requestChecksum: digest, createdBy: context.userId });
      await writeEvent(tx, context, ruleId, version, id ? "revise" : "create", input.changeReason);
      await this.audit.recordInTransaction(tx, context, { action: "business_rule.save", resourceType: "business_rule", resourceId: ruleId, result: "success", metadata: { version } });
      return { id: ruleId, version };
    });
  }

  async changeState(context: TenantContext, id: string, action: "publish" | "disable", raw: unknown) {
    authorize(context, Permission.WorkflowApprove);
    const input = ChangeRuleStateSchema.parse(raw);
    return withTenant(this.database.db, context, async tx => {
      const [row] = await tx.select().from(rules).where(eq(rules.id, id)).for("update");
      if (!row) throw new NotFoundException("规则不存在");
      if (row.revision !== input.expectedRevision || (action === "publish" ? row.latestVersion : row.activeVersion) !== input.version) throw new ConflictException("规则或启用状态已更新，请刷新");
      await tx.update(rules).set({ activeVersion: action === "publish" ? input.version : null, revision: row.revision + 1, updatedAt: new Date() }).where(eq(rules.id, id));
      await writeEvent(tx, context, id, input.version, action, input.changeReason);
      await this.audit.recordInTransaction(tx, context, { action: `business_rule.${action}`, resourceType: "business_rule", resourceId: id, result: "success", metadata: { version: input.version } });
      return { id };
    });
  }

  /** Explicit, tenant-authorized and repeatable; GET never seeds or changes state. */
  async initialize(context: TenantContext) {
    authorize(context, Permission.WorkflowManage); authorize(context, Permission.WorkflowApprove);
    return withTenant(this.database.db, context, async tx => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`rule-baseline:${context.tenantId}`},0))`);
      let created = 0;
      for (const { code, ...definition } of INITIAL_RULES) {
        const systemCode = `system:${code}`;
        if ((await tx.select({ id: rules.id }).from(rules).where(eq(rules.code, systemCode)))[0]) continue;
        const requiresPublish = definition.binding === "pillow_pipeline_v1";
        const id = createEntityId(), reason = requiresPublish ? "登记新版抱枕能力草稿；核对配方后显式发布，不升级旧规则或订单" : "登记已确认的制作规范；执行状态以已接入能力为准";
        await tx.insert(rules).values({ id, tenantId: context.tenantId, code: systemCode, activeVersion: requiresPublish ? null : 1, createdBy: context.userId });
        await tx.insert(versions).values({ id: createEntityId(), tenantId: context.tenantId, ruleId: id, version: 1, definition,
          scopeSpuId: null, changeReason: reason, idempotencyKey: randomUUID(), requestChecksum: createHash("sha256").update(JSON.stringify(definition)).digest("hex"), createdBy: context.userId });
        await writeEvent(tx, context, id, 1, "create", reason);
        if (!requiresPublish) await writeEvent(tx, context, id, 1, "publish", reason);
        created++;
      }
      await this.audit.recordInTransaction(tx, context, { action: "business_rule.initialize", resourceType: "business_rule", result: "success", metadata: { created } });
      return { created };
    });
  }
}
