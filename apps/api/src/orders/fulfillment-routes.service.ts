import { createHash } from "node:crypto";
import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { Permission } from "@yummyai/authz";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { canonicalJson } from "@yummyai/contracts/common/canonical-json";
import { FulfillmentRouteWorkspaceSchema, SaveFulfillmentRouteSchema, type FulfillmentRouteView } from "@yummyai/contracts/order/fulfillment-flow";
import { factoryCapabilities, factoryCapabilityVersions, fulfillmentRoutes, fulfillmentRouteVersions, fulfillmentFactories, fulfillmentSuppliers, type DatabaseConnection } from "@yummyai/database";
import { withOrderAuthority } from "@yummyai/order-core";
import { asc, eq, sql } from "drizzle-orm";
import { LogisticsDocumentsService } from "../logistics/logistics-documents.service.js";
import { LogisticsService } from "../logistics/logistics.service.js";
import { AuditService } from "../audit/audit.service.js";
import { DATABASE_CONNECTION } from "../platform.tokens.js";

@Injectable()
export class FulfillmentRoutesService {
  constructor(@Inject(DATABASE_CONNECTION) private readonly database: DatabaseConnection,
    @Inject(LogisticsDocumentsService) private readonly documents: LogisticsDocumentsService,
    @Inject(LogisticsService) private readonly logistics: LogisticsService,
    @Inject(AuditService) private readonly audit: AuditService) {}

  async workspace(context: TenantContext) {
    const [documents, connections, records] = await Promise.all([
      this.documents.options(context, {}, "configuration"),
      this.logistics.routingConnections(context),
      withOrderAuthority(this.database.db, context, [Permission.OrderRead], async tx => ({
        routes: await tx.select().from(fulfillmentRoutes).orderBy(asc(fulfillmentRoutes.id)).limit(201),
        factories: await tx.select({ id: fulfillmentFactories.id, name: fulfillmentFactories.name, version: fulfillmentFactories.currentVersionNumber,
          supplierName: fulfillmentSuppliers.name, supplierStatus: fulfillmentSuppliers.status, status: fulfillmentFactories.status,
          hasPillowCapability: sql<boolean>`exists(select 1 from ${factoryCapabilities} c join ${factoryCapabilityVersions} v
            on v.capability_id=c.id and v.version_number=c.current_version_number
            where c.factory_id=${fulfillmentFactories.id} and c.status='active'
            and v.profile->>'productType'='shaped_pillow' and v.profile->>'fulfillmentScope'='full_product'
            and v.profile->>'verificationStatus'='confirmed' and v.profile->>'sampleStatus'<>'failed'
            and (v.profile->>'validFrom')::timestamptz <= transaction_timestamp()
            and ((v.profile->>'validUntil') is null or (v.profile->>'validUntil')::timestamptz > transaction_timestamp()))` })
          .from(fulfillmentFactories).innerJoin(fulfillmentSuppliers,eq(fulfillmentSuppliers.id,fulfillmentFactories.supplierId)),
      })),
    ]);
    if (records.routes.length > 200 || documents.truncated) throw new ConflictException("配置数量超出本页范围 请先按工厂整理配置");
    const profiles = documents.profiles.map(profile => {
      const factory = records.factories.find(factory => factory.id === profile.factoryId);
      return { id: profile.id, name: profile.profile.name, factoryId: profile.factoryId, factoryName: factory?.name ?? "工厂不可用",
        countries: profile.profile.destinationCountries,
        products: [...new Set(profile.profile.specifications.map(spec => documents.specifications.find(item => item.id === spec.specificationVersionId)?.spuName ?? "规格旧版本"))] };
    });
    const routes: FulfillmentRouteView[] = records.routes.map(row => {
      const profile = documents.profiles.find(profile => profile.id === row.profile.documentProfileVersionId);
      const factory = records.factories.find(factory => factory.id === profile?.factoryId);
      const connection = connections.connections.find(connection => connection.id === row.profile.connectionId);
      const blockers: string[] = [];
      if (!profile) blockers.push("包裹与导单规则已有新版本 请重新选择");
      if (!factory || factory.status !== "active" || factory.supplierStatus !== "active") blockers.push("承接工厂或供应商尚未启用");
      if (!connection || connection.profile.factoryId !== profile?.factoryId) blockers.push("物流账户未关联到该工厂");
      if (!connection?.verifiedAt) blockers.push("物流接口尚未验证");
      if (!connection?.rule) blockers.push("物流渠道与费用规则尚未配置");
      if (row.profile.mode === "purchase" && !connection?.rule?.autoPurchase) blockers.push("物流连接尚未授权自动购单");
      const needsPillowCapability = factory?.status === "active" && !factory.hasPillowCapability && profile?.profile.productionAdapter !== "none"
        && profile?.profile.specifications.every(spec => spec.productKind === "shaped_pillow");
      return { id: row.id, version: row.version, profile: row.profile,
        factoryId: profile?.factoryId ?? connection?.profile.factoryId ?? row.id,
        factoryName: factory?.name ?? "工厂不可用", supplierName: factory?.supplierName ?? "",
        countries: profile?.profile.destinationCountries ?? [], products: profiles.find(profile => profile.id === row.profile.documentProfileVersionId)?.products ?? [],
        connectionName: connection?.profile.name ?? "物流连接不可用", blockers,
        ...(needsPillowCapability ? { factorySetupIssue: "工厂尚无已核验且生效的抱枕整件制作能力" } : {}) };
    });
    return { view: FulfillmentRouteWorkspaceSchema.parse({
      canConfigure: context.permissions.includes(Permission.IntegrationManage), routes, profiles,
      connections: connections.connections.map(connection => ({ id: connection.id, name: connection.profile.name,
        factoryId: connection.profile.factoryId, autoPurchase: connection.rule?.autoPurchase ?? false })),
    }), documents, connections: connections.connections };
  }

  async save(context: TenantContext, raw: unknown) {
    const input = SaveFulfillmentRouteSchema.parse(raw);
    const requestHash = createHash("sha256").update(canonicalJson(input)).digest("hex");
    return withOrderAuthority(this.database.db, context, [Permission.OrderRead, Permission.IntegrationManage], async tx => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${context.tenantId + ":fulfillment-routes"}))`);
      const [replay] = await tx.select().from(fulfillmentRouteVersions).where(eq(fulfillmentRouteVersions.requestKey,input.idempotencyKey));
      if (replay) {
        if (replay.requestHash !== requestHash || replay.createdBy !== context.userId) throw new ConflictException("同一次保存的内容不能改变");
        return { id: replay.routeId, version: replay.version };
      }
      const current = input.id ? (await tx.select().from(fulfillmentRoutes).where(eq(fulfillmentRoutes.id,input.id)))[0] : undefined;
      if (input.id && !current) throw new NotFoundException("发货规则不存在");
      if ((current?.version ?? 0) !== input.expectedVersion) throw new ConflictException("发货规则已更新 请刷新");
      // The existing owners validate tenancy, factory binding and API account.
      const workspace = await this.workspace(context);
      const profile = workspace.documents.profiles.find(profile => profile.id === input.profile.documentProfileVersionId);
      const connection = workspace.connections.find(connection => connection.id === input.profile.connectionId);
      if (!profile || !connection || connection.profile.factoryId !== profile.factoryId) throw new ConflictException("请选择同一工厂的包裹规则和物流连接");
      if (input.profile.mode === "purchase" && (!connection.verifiedAt || !connection.rule?.autoPurchase)) throw new ConflictException("请先在物流账户中确认渠道与费用异常规则，再开启审核后自动购单");
      if (input.profile.mode !== "disabled") {
        for (const other of workspace.view.routes.filter(route => route.id !== input.id && route.profile.mode !== "disabled")) {
          const otherProfile = workspace.documents.profiles.find(item => item.id === other.profile.documentProfileVersionId);
          if (otherProfile && profile.profile.destinationCountries.some(country => otherProfile.profile.destinationCountries.includes(country))
            && profile.profile.specifications.some(spec => otherProfile.profile.specifications.some(otherSpec => otherSpec.specificationVersionId === spec.specificationVersionId)))
            throw new ConflictException("同一商品规格与收货国家已有启用规则 请先停用旧规则");
        }
      }
      const id = current?.id ?? createEntityId(), version = input.expectedVersion + 1;
      const values = { version, profile: input.profile, requestKey: input.idempotencyKey, requestHash, createdBy: context.userId, updatedAt: new Date() };
      if (current) await tx.update(fulfillmentRoutes).set(values).where(eq(fulfillmentRoutes.id,id));
      else await tx.insert(fulfillmentRoutes).values({ id, tenantId: context.tenantId, ...values });
      await tx.insert(fulfillmentRouteVersions).values({ id: createEntityId(), tenantId: context.tenantId, routeId: id, version,
        profile: input.profile, requestKey: input.idempotencyKey, requestHash, createdBy: context.userId });
      await this.audit.recordInTransaction(tx,context,{ action:"fulfillment.route.saved",resourceType:"fulfillment_route",resourceId:id,result:"success",metadata:{version,mode:input.profile.mode} });
      return { id, version };
    });
  }
}
