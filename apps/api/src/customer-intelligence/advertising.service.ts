import {
ConflictException,
Inject,
Injectable,
NotFoundException,
PayloadTooLargeException,
UnprocessableEntityException,
} from "@nestjs/common";
import { AdvertisingReadOwner,readAdvertisingAccounts } from "@yummyai/advertising-core";
import { authorize,Permission } from "@yummyai/authz";
import { createEntityId,type TenantContext } from "@yummyai/contracts";
import {
AD_MEASUREMENT_ADAPTER,
AdActionEventInputSchema,
AdAnalysisInputSchema,
AdAnalysisResultSchema,
AdArchiveInputSchema,
AdCommitImportResultSchema,
AdCommitImportSchema,
adCurrencyBasis,
AdExportInputSchema,
AdFactPageSchema,
AdFactQuerySchema,
AdGoalVersionSchema,
AdImportInputSchema,
AdImportPreviewSchema,
AdObservationInputSchema,
AdObservationSchema,
AdSaveGoalInputSchema,
AdStoredFactSchema,
AdvertisingWorkspaceSchema,
type AdActionEventInput,
type AdActionView,
type AdAnalysisInput,
type AdCommitImport,
type AdExportInput,
type AdFactQuery,
type AdImportInput,
type AdObservationInput,
type AdSaveGoalInput,
type AdStoredFact,
} from "@yummyai/contracts/advertising";
import { isAdExecutionTimeExact,type AdCommandKind,type PrepareAdCommand } from "@yummyai/contracts/advertising/command";
import { type AdHistoryQuery,type AdHistoryRecordQuery } from "@yummyai/contracts/advertising/history";
import {
adActionEvents,
adActions,
adAnalysisRuns,
adExports,
adFacts,
adGoalVersions,
adImportBatches,
adImportEvents,
adImports,
adObservations,
adProducts,
withTenant,
type DatabaseConnection,
type TenantTransaction
} from "@yummyai/database";
import { and,desc,eq,gt,inArray,isNull,lte,or,sql } from "drizzle-orm";
import { AuditService } from "../audit/audit.service.js";
import { DATABASE_CONNECTION } from "../platform.tokens.js";
import { originalOwnerOperation } from "../shared/original-owner-error.js";
import { analyzeAdvertising,validAdTransition } from "./ad-analysis.js";
import { adHash,parseAdCsv } from "./ad-csv-parser.js";
import { AdSourceGateway } from "./ad-source.gateway.js";
import {
advertisingAccess,advertisingContextAuthority,currentAdvertisingAuthority,
requireAdvertisingAccount,requireAnyAdvertisingPermission,type AdvertisingOperation,
} from "./advertising-authority.js";
import { advertisingCommandAuthority,advertisingCommandPermission,advertisingCommandWrite } from "./advertising-command-transaction.js";
import { actionView,exportView,goalView,importView,observationView,runView } from "./advertising-views.js";

type ImportRow = typeof adImports.$inferSelect;
type ActionRow = typeof adActions.$inferSelect;
const pendingStates = ["pending", "adopted", "deferred"] as const;
const iso = (v: string) => new Date(v).toISOString();
const requestHash = (v: { idempotencyKey: string }) => adHash({ ...v, idempotencyKey: undefined });
function replay(saved: { inputChecksum: string }, hash: string) {
  if (saved.inputChecksum !== hash)
    throw new ConflictException("请求编号已用于不同内容，请刷新后重试");
}
function timestamp(value: string) {
  if (Date.parse(value) > Date.now() + 30000)
    throw new UnprocessableEntityException("证据或执行时间不能晚于当前时间");
}
function base(context: TenantContext, accountId: string, id = createEntityId()) {
  return {
    id,
    tenantId: context.tenantId,
    accountId,
    createdBy: context.userId,
    createdAt: new Date(),
  };
}
async function lock(tx: TenantTransaction, context: TenantContext, account: string) {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`advertising:${context.tenantId}:${account}`},0))`,
  );
}
async function requireActionParent(tx:TenantTransaction,action:ActionRow){
  if(action.recommendation.accountId.toLowerCase()!==action.accountId||action.recommendation.scope&&action.recommendation.scope.accountId.toLowerCase()!==action.accountId)
    throw new NotFoundException("调整记录不存在或不可访问");
  const [run]=await tx.select({id:adAnalysisRuns.id,accountId:adAnalysisRuns.accountId,
    evidenceImportIds:sql<unknown>`${adAnalysisRuns.result}->'evidenceImportIds'`}).from(adAnalysisRuns)
    .where(and(eq(adAnalysisRuns.id,action.runId),eq(adAnalysisRuns.accountId,action.accountId))).limit(1);
  if(!run)throw new NotFoundException("调整记录不存在或不可访问");
  return {...run,evidenceImportIds:AdAnalysisResultSchema.shape.evidenceImportIds.parse(run.evidenceImportIds)};
}
async function goals(tx: TenantTransaction, accountId?: string | string[], options: {previewLimit?:number;id?:string;productId?:string;latest?:boolean} = {}) {
  const rows = await tx
    .select({ goal: adGoalVersions, product: adProducts })
    .from(adGoalVersions)
    .innerJoin(
      adProducts,
      and(
        eq(adProducts.tenantId, adGoalVersions.tenantId),
        eq(adProducts.id, adGoalVersions.productId),
        eq(adProducts.accountId, adGoalVersions.accountId),
      ),
    )
    .where(and(typeof accountId === "string" ? eq(adGoalVersions.accountId, accountId)
      : accountId ? inArray(adGoalVersions.accountId, accountId) : undefined,
      options.id?eq(adGoalVersions.id,options.id):undefined,options.productId?eq(adGoalVersions.productId,options.productId):undefined))
    .orderBy(...(options.latest?[desc(adGoalVersions.revision),desc(adGoalVersions.createdAt)]:[desc(adGoalVersions.createdAt),desc(adGoalVersions.revision)]),desc(adGoalVersions.id))
    .limit(options.id||options.latest?1:options.previewLimit?options.previewLimit+1:10001);
  if (!options.previewLimit&&rows.length > 10000) throw new PayloadTooLargeException("本次分析目标过多，请缩小店铺范围；完整历史仍可分页读取");
  return rows.map(({ goal, product }) => goalView(goal, product));
}
async function observations(tx: TenantTransaction, accountId?: string | string[], previewLimit?:number) {
  const rows = await tx
    .select()
    .from(adObservations)
    .where(typeof accountId === "string" ? eq(adObservations.accountId, accountId)
      : accountId ? inArray(adObservations.accountId, accountId) : undefined)
    .orderBy(desc(adObservations.createdAt),desc(adObservations.id))
    .limit(previewLimit?previewLimit+1:10001);
  if (!previewLimit&&rows.length > 10000) throw new PayloadTooLargeException("本次分析观察记录过多，请缩小店铺范围；完整历史仍可分页读取");
  return rows.map(observationView);
}
async function actions(
  tx: TenantTransaction,
  accountId?: string | string[],
  actionId?: string,
  options: {previewLimit?:number;ids?:string[]} = {},
): Promise<AdActionView[]> {
  const rows = await tx
    .select()
    .from(adActions)
    .where(
      and(
        typeof accountId === "string" ? eq(adActions.accountId, accountId)
          : accountId ? inArray(adActions.accountId, accountId) : undefined,
        actionId ? eq(adActions.id, actionId) : undefined,
        options.ids?inArray(adActions.id,options.ids):undefined,
        sql`exists(select 1 from ${adAnalysisRuns} where ${adAnalysisRuns.tenantId}=${adActions.tenantId}
          and ${adAnalysisRuns.id}=${adActions.runId} and ${adAnalysisRuns.accountId}=${adActions.accountId})`,
        sql`lower(${adActions.recommendation}->>'accountId')=${adActions.accountId}::text`,
      ),
    )
    .orderBy(desc(adActions.updatedAt),desc(adActions.id))
    .limit(actionId?1:options.previewLimit?options.previewLimit+1:options.ids?options.ids.length+1:10001);
  if (!options.previewLimit&&rows.length > 10000) throw new PayloadTooLargeException("本次分析调整记录过多，请缩小店铺范围；完整历史仍可分页读取");
  if (!rows.length) return [];
  if(options.previewLimit)return rows.map(row=>({...actionView(row,[]),eventsComplete:false}));
  const events = await tx
    .select()
    .from(adActionEvents)
    .where(
      and(inArray(
        adActionEvents.actionId,
        rows.map((r) => r.id),
      ),inArray(adActionEvents.accountId,[...new Set(rows.map(row=>row.accountId))])),
    )
    .orderBy(adActionEvents.createdAt, adActionEvents.id);
  return rows.map(row => actionView(row, events));
}
function storedFact(r: { fact: typeof adFacts.$inferSelect; source: ImportRow }): AdStoredFact {
  return AdStoredFactSchema.parse({
    id: r.fact.id,
    importId: r.source.id,
    accountId: r.source.accountId,
    observedAt: iso(r.source.metadata.observedAt),
    recordedAt: r.source.createdAt.toISOString(),
    timezone: r.source.metadata.timezone,
    attributionWindowDays: r.source.metadata.attributionWindowDays,
    attributionBasis: r.source.metadata.attributionBasis,
    fact: r.fact.fact,
    sourceChecksum: r.source.checksum,
    sourceArchivedAt: r.source.archivedAt?.toISOString() ?? null,
  });
}
async function evidence(tx: TenantTransaction, input: AdAnalysisInput) {
  const rows = await tx
    .select({ fact: adFacts, source: adImports })
    .from(adFacts)
    .innerJoin(
      adImports,
      and(eq(adImports.tenantId, adFacts.tenantId), eq(adImports.id, adFacts.importId)),
    )
    .where(
      and(
        eq(adImports.accountId, input.accountId),
        or(isNull(adImports.archivedAt), gt(adImports.archivedAt, new Date(input.evidenceCutoffAt))),
        lte(adImports.createdAt, new Date(input.evidenceCutoffAt)),
        sql`(${adFacts.fact}->>'periodStart' is null or (${adFacts.fact}->>'periodStart' <= ${input.periodEnd} and ${adFacts.fact}->>'periodEnd' >= ${input.periodStart}))`,
      ),
    )
    .limit(100001);
  if (rows.length > 100000)
    throw new PayloadTooLargeException("本次事实超过 10 万行，请按日期缩小分析范围");
  return rows.map(storedFact);
}

@Injectable()
export class AdvertisingService {
  constructor(
    @Inject(DATABASE_CONNECTION) private readonly database: DatabaseConnection,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(AdSourceGateway) private readonly sources: AdSourceGateway,
  ) {}
  private withCurrent<T>(context: TenantContext, operation: AdvertisingOperation | null,
    apply: (tx: TenantTransaction, current: TenantContext) => Promise<T>, immutableRead = false) {
    return withTenant(this.database.db, context, async (tx) => {
      const current = await currentAdvertisingAuthority(tx, context);
      if (operation) authorize(current, operation);
      else requireAnyAdvertisingPermission(current);
      return apply(tx, current);
    }, immutableRead ? { isolationLevel: "repeatable read", accessMode: "read write" } : undefined);
  }
  private normalizeImport(raw: AdImportInput) {
    const input = AdImportInputSchema.parse(raw);
    timestamp(input.observedAt);
    input.observedAt = iso(input.observedAt);
    const total = input.files.reduce((n, f) => n + Buffer.byteLength(f.content, "utf8"), 0);
    if (
      total > 20 * 1024 * 1024 ||
      input.files.some((f) => Buffer.byteLength(f.content, "utf8") > 5 * 1024 * 1024)
    )
      throw new PayloadTooLargeException("单文件最多 5 MiB，整批最多 20 MiB");
    return input;
  }
  private withWrite<T>(context:TenantContext,kind:AdCommandKind,original:PrepareAdCommand|((tx:TenantTransaction)=>Promise<PrepareAdCommand>),apply:(tx:TenantTransaction,current:TenantContext)=>Promise<T>){
    return this.withCurrent(context,advertisingCommandPermission(kind),async(tx,current)=>{
      // Raw transports retain their old schemas and hashes. New command-only
      // restrictions must not reinterpret or reject a valid legacy replay.
      const parsed=typeof original==="function"?await original(tx):original;
      if(parsed.kind!==kind)throw new ConflictException("原写入类型不一致");
      return advertisingCommandWrite(tx,current,parsed,ceiling=>apply(tx,ceiling),this.audit);
    });
  }
  private async targetOriginal(tx:TenantTransaction,kind:"action_transition"|"import_archive"|"export_seal",targetId:string,input:unknown):Promise<PrepareAdCommand>{
    const table=kind==="action_transition"?adActions:kind==="import_archive"?adImports:adAnalysisRuns;
    const [row]=await tx.select({accountId:table.accountId}).from(table).where(eq(table.id,targetId)).limit(1);
    if(!row)throw new NotFoundException("原业务对象不存在或不可访问");
    if(kind==="action_transition")return {kind,accountId:row.accountId,targetId:targetId.toLowerCase(),input:AdActionEventInputSchema.parse(input)};
    if(kind==="import_archive")return {kind,accountId:row.accountId,targetId:targetId.toLowerCase(),input:AdArchiveInputSchema.parse(input)};
    return {kind,accountId:row.accountId,targetId:targetId.toLowerCase(),input:AdExportInputSchema.parse(input)};
  }
  private importMetadata(input:AdImportInput,rawInputChecksum:string){
    return {timezone:input.timezone,observedAt:input.observedAt,attributionWindowDays:input.attributionWindowDays,
      attributionBasis:input.attributionBasis,marketplaceByCurrency:input.marketplaceByCurrency,dateOrder:input.dateOrder,
      ...(input.conversionDefinition?{conversionDefinition:input.conversionDefinition}:{}),rawInputChecksum};
  }
  /** Expected actual owner projection, independently checked against DB columns at commit. */
  commandProjection(original:PrepareAdCommand):unknown{
    switch(original.kind){
      case "import_commit":{
        const {previewChecksum,...data}=original.input,parsed=this.parseImport(data);
        if(previewChecksum!==parsed.checksum||!parsed.canCommit)throw new ConflictException("原预览或导入依据已变化 请保留原提交并核对");
        const metadata=this.importMetadata(parsed.input,parsed.rawInputChecksum);
        return {batchInputChecksum:adHash({previewChecksum,allowPartial:parsed.input.allowPartial}),rawInputChecksum:parsed.rawInputChecksum,
          fileManifest:parsed.files.map(file=>({fileName:file.fileName,checksum:file.checksum,byteSize:file.byteSize,reportType:file.reportType,
            metadata:{...metadata,...(file.measurement?{measurement:file.measurement}:{})}})).sort((a,b)=>a.checksum<b.checksum?-1:a.checksum>b.checksum?1:a.fileName<b.fileName?-1:a.fileName>b.fileName?1:0)};
      }
      case "goal_save":{
        const input=original.input,basis=adCurrencyBasis(input.scope.currency);
        if(!basis||input.fields.monetaryBasis&&input.fields.monetaryBasis.currency!==input.scope.currency)throw new UnprocessableEntityException("原目标缺少同币种固定精度依据");
        return {scope:input.scope,fields:{...input.fields,monetaryBasis:basis},revision:input.expectedRevision+1};
      }
      case "observation_record":{
        const data={...original.input,idempotencyKey:undefined},basis=adCurrencyBasis(data.scope.currency);
        if((!basis&&data.kind==="commerce")||data.monetaryBasis&&data.monetaryBasis.currency!==data.scope.currency)throw new UnprocessableEntityException("原经营证据缺少同币种固定精度依据");
        return {data:{...data,...(basis?{monetaryBasis:basis}:{})}};
      }
      case "analysis_run":return {input:original.input};
      case "action_transition":return {actionId:original.targetId,status:original.input.status,reason:original.input.reason,data:original.input,revision:original.input.expectedRevision+1};
      case "import_archive":return {importId:original.targetId,reason:original.input.reason};
      case "export_seal":return {runId:original.input.runId,actionIds:[...original.input.actionIds].sort(),reviewReason:original.input.reviewReason};
      default:throw new ConflictException("原写入类型不支持");
    }
  }
  private importInputChecksum(input: AdImportInput) {
    return adHash({ ...input, files: input.files.map(file => ({ ...file, content: adHash(file.content) })),
      idempotencyKey: undefined, allowPartial: undefined });
  }
  private parseImport(raw: AdImportInput) {
    const input = this.normalizeImport(raw);
    const files = input.files.map((f) =>
      parseAdCsv(f.fileName, f.content, {
        marketplaceByCurrency: input.marketplaceByCurrency,
        dateOrder: input.dateOrder,
        reportTypeHint: f.reportTypeHint,
        adProductHint: f.adProductHint,
        metricColumns: f.metricColumns,
        attributionWindowDays: input.attributionWindowDays,
        attributionBasis: input.attributionBasis,
        conversionDefinition: input.conversionDefinition,
      }),
    );
    const seen = new Set<string>();
    for (const f of files) {
      if (seen.has(f.checksum)) {
        f.diagnostics.push({
          code: "DUPLICATE_FILE",
          severity: "error",
          message: "同一批次包含完全相同的文件",
          row: null,
          column: null,
        });
        f.reportType = null;
      }
      seen.add(f.checksum);
    }
    const rawInputChecksum = this.importInputChecksum(input);
    const checksum = adHash({ adapterVersion: AD_MEASUREMENT_ADAPTER, rawInputChecksum, allowPartial: input.allowPartial,
      files: files.map(file => ({ checksum: file.checksum, reportType: file.reportType, measurement: file.measurement })) });
    const canCommit = files.every(
      (f) =>
        f.reportType !== null &&
        f.facts.length > 0 &&
        f.measurement?.conversion.state !== "conflict" &&
        !f.facts.some(fact => fact.measurement?.conversion.state === "conflict") &&
        (input.allowPartial ||
          (!f.rejectedRowCount && !f.diagnostics.some((d) => d.severity === "error"))),
    );
    return { input, files, checksum, rawInputChecksum, canCommit };
  }
  async preview(context: TenantContext, raw: AdImportInput) {
    const parsed = this.parseImport(raw);
    return this.withCurrent(context, Permission.CustomerIntelligenceWrite, async (tx, current) => {
      await requireAdvertisingAccount(tx, current, parsed.input.accountId, Permission.CustomerIntelligenceWrite);
      return AdImportPreviewSchema.parse({
        previewChecksum: parsed.checksum,
        canCommit: parsed.canCommit,
        files: parsed.files.map(({ facts, ...f }) => ({ ...f, sample: facts.slice(0, 20) })),
      });
    });
  }
  async commit(context: TenantContext, raw: AdCommitImport) {
    const { previewChecksum, ...rawData } = AdCommitImportSchema.parse(raw),
      data = this.normalizeImport(rawData), rawInputChecksum = this.importInputChecksum(data);
    const hash = adHash({ previewChecksum, allowPartial: data.allowPartial });
    const original:PrepareAdCommand={kind:"import_commit",accountId:data.accountId,targetId:null,input:{...data,previewChecksum}};
    const previously = await this.withCurrent(context, Permission.CustomerIntelligenceWrite, async (tx, current) => {
      current=await advertisingCommandAuthority(tx,current,original);
      await requireAdvertisingAccount(tx, current, data.accountId, Permission.CustomerIntelligenceWrite);
      const [saved] = await tx
        .select()
        .from(adImportBatches)
        .where(
          and(
            eq(adImportBatches.accountId, data.accountId),
            eq(adImportBatches.idempotencyKey, data.idempotencyKey),
          ),
        )
        .limit(1);
      if (!saved) return null;
      replay(saved, hash);
      const rows = await tx.select().from(adImports).where(eq(adImports.batchId, saved.id));
      if (!rows.length || !rows.every(row => row.metadata.rawInputChecksum
        ? row.metadata.rawInputChecksum === rawInputChecksum
        : previewChecksum === rawInputChecksum && !data.conversionDefinition && data.files.every(file => !file.metricColumns)))
        throw new ConflictException("原请求正文与已保存凭据不一致 请核对原提交");
      return rows.map(importView);
    });
    if (previously) return AdCommitImportResultSchema.parse({ imports: previously, replayed: true });
    const parsed = this.parseImport(data);
    if (previewChecksum !== parsed.checksum || !parsed.canCommit)
      throw new ConflictException("导入内容或设置已变化，请重新预览并解决错误");
    const uploaded: { id: string; objectKey: string }[] = [];
    const uploadAuthority = () => this.withCurrent(context, Permission.CustomerIntelligenceWrite,
      async (tx, current) => {
        return advertisingCommandAuthority(tx,current,original);
      });
    try {
      const stored: Array<Awaited<ReturnType<AdSourceGateway["store"]>> & { id: string }> = [];
      for (const f of data.files) {
        const id = createEntityId(),
          beforeScan = await uploadAuthority(),
          result = await this.sources.store(beforeScan, id, f.content, uploadAuthority);
        uploaded.push({ id, objectKey: result.objectKey });
        stored.push({ id, ...result });
        // No membership or account lock spans scanning or private storage I/O.
        // A revoked writer may only discard this request's unreferenced upload.
        await uploadAuthority();
      }
      const result = await this.withWrite(context,"import_commit",original,async (tx, current) => {
        await requireAdvertisingAccount(tx, current, data.accountId, Permission.CustomerIntelligenceWrite);
        await lock(tx, current, data.accountId);
        const [saved] = await tx
          .select()
          .from(adImportBatches)
          .where(
            and(
              eq(adImportBatches.accountId, data.accountId),
              or(
                eq(adImportBatches.idempotencyKey, data.idempotencyKey),
                eq(adImportBatches.inputChecksum, hash),
              ),
            ),
          )
          .limit(1);
        if (saved) {
          replay(saved, hash);
          return {
            imports: (await tx.select().from(adImports).where(eq(adImports.batchId, saved.id))).map(
              importView,
            ),
            replayed: true,
          };
        }
        const batch = base(current, data.accountId);
        await tx
          .insert(adImportBatches)
          .values({ ...batch, idempotencyKey: data.idempotencyKey, inputChecksum: hash });
        const metadata = this.importMetadata(parsed.input,parsed.rawInputChecksum);
        const imports = [];
        for (let i = 0; i < parsed.files.length; i++) {
          const f = parsed.files[i]!,
            asset = stored[i]!;
          if (asset.checksumSha256 !== f.checksum) throw new Error("CSV storage checksum mismatch");
          const starts = f.facts
              .flatMap((fact) => (fact.periodStart ? [fact.periodStart] : []))
              .sort(),
            ends = f.facts.flatMap((fact) => (fact.periodEnd ? [fact.periodEnd] : [])).sort();
          const [row] = await tx
            .insert(adImports)
            .values({
              ...base(current, data.accountId, asset.id),
              batchId: batch.id,
              fileName: f.fileName,
              periodStart: starts[0] ?? null,
              periodEnd: ends.at(-1) ?? null,
              checksum: f.checksum,
              objectKey: asset.objectKey,
              byteSize: f.byteSize,
              reportType: f.reportType!,
              metadata: { ...metadata, ...(f.measurement ? { measurement: f.measurement } : {}) },
              sourceRowCount: f.sourceRowCount,
              acceptedRowCount: f.acceptedRowCount,
              rejectedRowCount: f.rejectedRowCount,
              diagnostics: f.diagnostics,
              scan: asset.scan,
            })
            .returning();
          for (let start = 0; start < f.facts.length; start += 500)
            await tx.insert(adFacts).values(
              f.facts.slice(start, start + 500).map((fact) => ({
                id: createEntityId(),
                tenantId: current.tenantId,
                importId: asset.id,
                rowKey: fact.rowKey,
                entityKey: fact.entityKey,
                fact,
              })),
            );
          imports.push(importView(row));
        }
        await this.invalidate(tx, current, data.accountId, "新的报表证据已导入，请重新分析后审阅");
        await this.audit.recordInTransaction(tx, current, {
          action: "advertising.import",
          resourceType: "ad_import_batch",
          resourceId: batch.id,
          result: "success",
          metadata: {
            fileCount: imports.length,
            rowCount: imports.reduce((n, f) => n + f.acceptedRowCount, 0),
          },
        });
        return { imports, replayed: false };
      });
      await this.discardUnreferenced(context, uploaded);
      return AdCommitImportResultSchema.parse(result);
    } catch (error) {
      await this.discardUnreferenced(context, uploaded);
      throw error;
    }
  }
  private async discardUnreferenced(
    context: TenantContext,
    uploaded: { id: string; objectKey: string }[],
  ) {
    for (const asset of uploaded) {
      const saved = await withTenant(this.database.db, context, (tx) =>
        tx
          .select({ id: adImports.id })
          .from(adImports)
          .where(and(eq(adImports.id, asset.id), eq(adImports.objectKey, asset.objectKey)))
          .limit(1),
      );
      if (!saved.length) await this.sources.discard(context, asset.id, asset.objectKey);
    }
  }
  async workspace(context: TenantContext, accountId?: string) {
    return this.withCurrent(context, null, async (tx, current) => {
      if (accountId) await requireAdvertisingAccount(tx, current, accountId, null);
      const accounts = await readAdvertisingAccounts(tx,current);
      const readableIds = accounts.filter(({ row, access }) => access.canRead && (!accountId || row.id === accountId))
        .map(({ row }) => row.id);
      const imports = readableIds.length ? await tx
        .select()
        .from(adImports)
        .where(inArray(adImports.accountId, readableIds))
        .orderBy(desc(adImports.createdAt),desc(adImports.id))
        .limit(201) : [];
      const analyses = readableIds.length ? await tx
        .select()
        .from(adAnalysisRuns)
        .where(inArray(adAnalysisRuns.accountId, readableIds))
        .orderBy(desc(adAnalysisRuns.createdAt),desc(adAnalysisRuns.id))
        .limit(11) : [];
      const recentGoals=readableIds.length?await goals(tx,readableIds,{previewLimit:200}):[],
        recentObservations=readableIds.length?await observations(tx,readableIds,200):[],
        recentActions=readableIds.length?await actions(tx,readableIds,undefined,{previewLimit:200}):[];
      const window=(length:number,limit:number)=>({loaded:Math.min(length,limit),limit,hasMore:length>limit});
      return AdvertisingWorkspaceSchema.parse({
        accountId: accountId ?? null,
        contextAuthority: advertisingContextAuthority(current),
        access: advertisingAccess(current),
        accounts: accounts.map(({ row: a, access }) => ({
          id: a.id, name: a.displayName, marketplaceIds: a.marketplaceIds, status: a.status, access,
        })),
        imports: imports.slice(0,200).map(importView),
        goals:recentGoals.slice(0,200),observations:recentObservations.slice(0,200),actions:recentActions.slice(0,200),
        analyses: analyses.slice(0,10).map(runView),
        historyWindow:{schemaVersion:1,imports:window(imports.length,200),goals:window(recentGoals.length,200),
          observations:window(recentObservations.length,200),actions:window(recentActions.length,200),analyses:window(analyses.length,10)},
      });
    }, true);
  }
  async facts(context: TenantContext, raw: AdFactQuery) {
    const query = AdFactQuerySchema.parse(raw);
    return this.withCurrent(context, Permission.CustomerIntelligenceRead, async (tx, current) => {
      await requireAdvertisingAccount(tx, current, query.accountId, Permission.CustomerIntelligenceRead);
      const escaped = query.search.replace(/[\\%_]/g, "\\$&");
      const where = and(
        eq(adImports.accountId, query.accountId),
        isNull(adImports.archivedAt),
        query.reportType ? eq(adImports.reportType, query.reportType) : undefined,
        query.search
          ? sql`concat_ws(' ', ${adFacts.fact}->>'term',${adFacts.fact}->>'asin',${adFacts.fact}->>'campaignName',${adFacts.fact}->>'campaignId',${adFacts.fact}->>'targetId',${adFacts.fact}->>'placement') ilike ${`%${escaped}%`}`
          : undefined,
      );
      const join = and(
        eq(adImports.tenantId, adFacts.tenantId),
        eq(adImports.id, adFacts.importId),
      );
      const [count] = await tx
        .select({ n: sql<number>`count(*)::integer` })
        .from(adFacts)
        .innerJoin(adImports, join)
        .where(where);
      const rows = await tx
        .select({ fact: adFacts, source: adImports })
        .from(adFacts)
        .innerJoin(adImports, join)
        .where(where)
        .orderBy(desc(adImports.createdAt), adFacts.id)
        .limit(query.pageSize)
        .offset((query.page - 1) * query.pageSize);
      return AdFactPageSchema.parse({
        accountId: query.accountId,
        contextAuthority: advertisingContextAuthority(current),
        rows: rows.map(storedFact),
        count: count.n,
        page: query.page,
        pageSize: query.pageSize,
      });
    }, true);
  }
  async history(context:TenantContext,raw:AdHistoryQuery){return originalOwnerOperation(()=>new AdvertisingReadOwner(this.database).history(context,raw));}
  async record(context:TenantContext,id:string,raw:AdHistoryRecordQuery){return originalOwnerOperation(()=>new AdvertisingReadOwner(this.database).record(context,id,raw));}
  async saveGoal(context: TenantContext, raw: AdSaveGoalInput) {
    const input = AdSaveGoalInputSchema.parse(raw),
      hash = requestHash(input);
    return this.withWrite(context,"goal_save",{kind:"goal_save",accountId:input.scope.accountId,targetId:null,input},async (tx, current) => {
      await requireAdvertisingAccount(tx, current, input.scope.accountId, Permission.CustomerIntelligenceReview);
      await lock(tx, current, input.scope.accountId);
      const [saved] = await tx
        .select()
        .from(adGoalVersions)
        .where(
          and(
            eq(adGoalVersions.accountId, input.scope.accountId),
            eq(adGoalVersions.idempotencyKey, input.idempotencyKey),
          ),
        )
        .limit(1);
      if (saved) {
        replay(saved, hash);
        return (await goals(tx, input.scope.accountId,{id:saved.id}))[0]!;
      }
      const scope = input.scope,
        where = and(
          eq(adProducts.accountId, scope.accountId),
          eq(adProducts.marketplace, scope.marketplace),
          eq(adProducts.currency, scope.currency),
          eq(adProducts.asin, scope.asin),
        );
      const monetaryBasis = adCurrencyBasis(scope.currency);
      if (!monetaryBasis || input.fields.monetaryBasis && input.fields.monetaryBasis.currency !== scope.currency)
        throw new UnprocessableEntityException("目标金额缺少与产品币种一致的固定精度依据");
      const fields = { ...input.fields, monetaryBasis };
      let [product] = await tx.select().from(adProducts).where(where).limit(1);
      if ((product?.revision ?? 0) !== input.expectedRevision)
        throw new ConflictException("产品目标已被修改，请刷新后再保存");
      if (!product)
        [product] = await tx
          .insert(adProducts)
          .values({
            ...base(current, scope.accountId),
            marketplace: scope.marketplace,
            currency: scope.currency,
            asin: scope.asin,
            revision: 0,
          })
          .returning();
      const revision = product.revision + 1,
        id = createEntityId(),
        checksum = adHash({ scope, fields, revision });
      await tx.update(adProducts).set({ revision }).where(eq(adProducts.id, product.id));
      const [created] = await tx
        .insert(adGoalVersions)
        .values({
          ...base(current, scope.accountId, id),
          productId: product.id,
          revision,
          fields,
          checksum,
          inputChecksum: hash,
          idempotencyKey: input.idempotencyKey,
        })
        .returning();
      await this.invalidate(
        tx,
        current,
        scope.accountId,
        "产品目标已创建新版本，请重新分析后审阅",
        product.id,
        scope,
      );
      await this.audit.recordInTransaction(tx, current, {
        action: "advertising.goal.version",
        resourceType: "ad_goal_version",
        resourceId: id,
        result: "success",
        metadata: { revision, mode: input.fields.mode },
      });
      return AdGoalVersionSchema.parse({
        id,
        productId: product.id,
        revision,
        scope,
        fields,
        checksum,
        createdAt: created.createdAt.toISOString(),
      });
    });
  }
  async recordObservation(context: TenantContext, raw: AdObservationInput) {
    const input = AdObservationInputSchema.parse(raw);
    timestamp(input.observedAt);
    input.observedAt = iso(input.observedAt);
    const hash = requestHash(input);
    return this.withWrite(context,"observation_record",{kind:"observation_record",accountId:input.scope.accountId,targetId:null,input},async (tx, current) => {
      await requireAdvertisingAccount(tx, current, input.scope.accountId, Permission.CustomerIntelligenceWrite);
      await lock(tx, current, input.scope.accountId);
      const [saved] = await tx
        .select()
        .from(adObservations)
        .where(
          and(
            eq(adObservations.accountId, input.scope.accountId),
            eq(adObservations.idempotencyKey, input.idempotencyKey),
          ),
        )
        .limit(1);
      if (saved) {
        replay(saved, hash);
        return AdObservationSchema.parse({
          ...saved.data,
          id: saved.id,
          createdAt: saved.createdAt.toISOString(),
        });
      }
      const { idempotencyKey, ...data } = input;
      const monetaryBasis = adCurrencyBasis(input.scope.currency);
      if ((!monetaryBasis && input.kind === "commerce") || input.monetaryBasis && input.monetaryBasis.currency !== input.scope.currency)
        throw new UnprocessableEntityException("经营金额缺少与产品币种一致的固定精度依据");
      if (monetaryBasis) data.monetaryBasis = monetaryBasis;
      const [row] = await tx
        .insert(adObservations)
        .values({
          ...base(current, input.scope.accountId),
          data,
          idempotencyKey,
          inputChecksum: hash,
        })
        .returning();
      await this.invalidate(
        tx,
        current,
        input.scope.accountId,
        "产品经营或自然排名证据已更新，请重新分析后审阅",
      );
      await this.audit.recordInTransaction(tx, current, {
        action: "advertising.observation",
        resourceType: "ad_observation",
        resourceId: row.id,
        result: "success",
        metadata: { kind: input.kind },
      });
      return AdObservationSchema.parse({
        ...data,
        id: row.id,
        createdAt: row.createdAt.toISOString(),
      });
    });
  }
  async analyze(context: TenantContext, raw: AdAnalysisInput) {
    const input = AdAnalysisInputSchema.parse(raw);
    timestamp(input.evidenceCutoffAt);
    input.evidenceCutoffAt = iso(input.evidenceCutoffAt);
    const hash = requestHash(input);
    return this.withWrite(context,"analysis_run",{kind:"analysis_run",accountId:input.accountId,targetId:null,input},async (tx, current) => {
      await requireAdvertisingAccount(tx, current, input.accountId, Permission.CustomerIntelligenceReview);
      await lock(tx, current, input.accountId);
      const [saved] = await tx
        .select()
        .from(adAnalysisRuns)
        .where(
          and(
            eq(adAnalysisRuns.accountId, input.accountId),
            eq(adAnalysisRuns.idempotencyKey, input.idempotencyKey),
          ),
        )
        .limit(1);
      if (saved) {
        replay(saved, hash);
        return runView(saved);
      }
      const result = analyzeAdvertising({
        input,
        facts: await evidence(tx, input),
        goals: await goals(tx, input.accountId),
        observations: await observations(tx, input.accountId),
        actions: await actions(tx, input.accountId),
      });
      const [run] = await tx
        .insert(adAnalysisRuns)
        .values({
          ...base(current, input.accountId),
          input,
          result,
          status: result.diagnostics.some((d) => d.severity !== "info") ? "partial" : "complete",
          inputChecksum: hash,
          idempotencyKey: input.idempotencyKey,
        })
        .returning();
      for (const recommendation of result.recommendations) {
        const existing = await tx
          .select({ id: adActions.id })
          .from(adActions)
          .where(
            and(
              eq(adActions.accountId, input.accountId),
              eq(adActions.recommendationKey, recommendation.key),
              sql`${adActions.status}<>'stale'`,
            ),
          )
          .limit(1);
        if (existing.length) continue;
        const inserted = await tx
          .insert(adActions)
          .values({
            ...base(current, input.accountId),
            runId: run.id,
            recommendationKey: recommendation.key,
            recommendation,
          })
          .returning();
        if (inserted[0])
          await tx.insert(adActionEvents).values({
            ...base(current, input.accountId),
            actionId: inserted[0].id,
            status: "pending",
            reason: "基于已封存报表和目标生成待审阅候选",
            data: { runId: run.id },
            idempotencyKey: `generated:${run.id}`,
            inputChecksum: adHash(recommendation),
          });
      }
      await this.audit.recordInTransaction(tx, current, {
        action: "advertising.analyze",
        resourceType: "ad_analysis_run",
        resourceId: run.id,
        result: "success",
        metadata: {
          factCount: result.selectedFactCount,
          recommendationCount: result.recommendations.length,
        },
      });
      return runView(run);
    });
  }
  async transition(context: TenantContext, id: string, raw: AdActionEventInput) {
    const input = AdActionEventInputSchema.parse(raw),
      hash = requestHash(input);
    if (input.executedAt) timestamp(input.executedAt);
    return this.withWrite(context,"action_transition",(tx:TenantTransaction)=>this.targetOriginal(tx,"action_transition",id,input),async (tx, current) => {
      const [first] = await tx.select().from(adActions).where(eq(adActions.id, id)).limit(1);
      if (!first) throw new NotFoundException("调整记录不存在");
      await requireAdvertisingAccount(tx, current, first.accountId, Permission.CustomerIntelligenceReview, true);
      await lock(tx, current, first.accountId);
      await requireActionParent(tx,first);
      const [saved] = await tx
        .select()
        .from(adActionEvents)
        .where(
          and(
            eq(adActionEvents.actionId, id),
            eq(adActionEvents.idempotencyKey, input.idempotencyKey),
          ),
        )
        .limit(1);
      if (saved) {
        replay(saved, hash);
        return (await actions(tx, undefined, id))[0]!;
      }
      if(input.executedAt&&!isAdExecutionTimeExact(input.executedAt))
        throw new UnprocessableEntityException("执行时间必须能精确保存到毫秒 请核对原时间后重新填写");
      const [row] = await tx.select().from(adActions).where(eq(adActions.id, id)).limit(1);
      if (row.revision !== input.expectedRevision || row.status !== input.expectedStatus)
        throw new ConflictException("调整状态已变化，请刷新后重试");
      if (!validAdTransition(row.status, input.status))
        throw new ConflictException("不能跳过审阅、执行或观察步骤");
      const rec = row.recommendation;
      if (["adopted", "executed"].includes(input.status) && rec.kind !== "watch") {
        const basis = rec.currency ? adCurrencyBasis(rec.currency) : null;
        if (!basis || !rec.monetaryBasis || adHash(basis) !== adHash(rec.monetaryBasis)
          || rec.kind !== "budget_guard" && (rec.conversion?.state !== "resolved" || rec.conversion.model !== "click"))
          throw new ConflictException("原建议缺少固定金额或转化依据 请保留历史并按新来源重新分析");
      }
      if (input.status === "reviewed" && row.executedAt) {
        const version = rec.goalVersionId
          ? (await goals(tx, row.accountId,{id:rec.goalVersionId}))[0]
          : null;
        if (Date.now() - row.executedAt.getTime() < (version?.fields.cooldownDays ?? 7) * 86400000)
          throw new ConflictException("观察期尚未结束，请在观察期后结合新报表复盘");
      }
      if (["adopted", "executed"].includes(input.status)) await this.assertCurrentGoal(tx, row);
      if (input.status === "executed") {
        if (Date.parse(input.executedAt!) < row.createdAt.getTime())
          throw new UnprocessableEntityException("执行时间不能早于建议生成时间");
        if (["lower_bid", "raise_bid"].includes(rec.kind)) {
          if (
            !input.executionCampaignId ||
            !input.executionAdGroupId ||
            !input.executionTargetId ||
            input.executionCampaignId !== rec.campaignId ||
            input.executionAdGroupId !== rec.adGroupId ||
            input.executionTargetId !== rec.targetId
          )
            throw new UnprocessableEntityException("请核对实际执行的活动、广告组和投放 ID");
          if (
            input.actualBeforeMinor === null ||
            input.actualAfterMinor === null ||
            input.actualBeforeMinor <= 0 ||
            input.actualAfterMinor <= 0
          )
            throw new UnprocessableEntityException("请记录核对后的实际竞价前后值");
          const goal = rec.goalVersionId?(await goals(tx,row.accountId,{id:rec.goalVersionId}))[0]:null;
          if(!goal)throw new ConflictException("原目标版本不可访问 请重新分析");
          const delta = BigInt(input.actualAfterMinor) - BigInt(input.actualBeforeMinor);
          if (
            (rec.kind === "lower_bid" && delta >= 0n) ||
            (rec.kind === "raise_bid" && delta <= 0n) ||
            (delta < 0n ? -delta : delta) * 10000n >
              BigInt(input.actualBeforeMinor) * BigInt(goal.fields.maxBidChangeBps)
          )
            throw new UnprocessableEntityException(
              "实际调整方向或幅度超出产品限制，请修改目标后重新分析",
            );
        }
        if (
          ["negate_term", "harvest_exact"].includes(rec.kind) &&
          (!input.executionCampaignId || !input.executionAdGroupId)
        )
          throw new UnprocessableEntityException(
            "请填写实际操作的活动与广告组；搜索词不能自动推断投放范围",
          );
        if (
          rec.kind === "negate_term" &&
          (input.executionCampaignId !== rec.campaignId ||
            input.executionAdGroupId !== rec.adGroupId)
        )
          throw new UnprocessableEntityException("否词记录需核对原建议的活动和广告组范围");
      } else if (
        input.executedAt !== null ||
        input.actualBeforeMinor !== null ||
        input.actualAfterMinor !== null
      )
        throw new UnprocessableEntityException("仅执行记录可写入实际竞价和执行时间");
      const updatedAt = new Date();
      await tx
        .update(adActions)
        .set({
          status: input.status,
          revision: row.revision + 1,
          updatedAt,
          ...(input.status === "executed"
            ? {
                executedAt: new Date(input.executedAt!),
                actualBeforeMinor: input.actualBeforeMinor?.toString() ?? null,
                actualAfterMinor: input.actualAfterMinor?.toString() ?? null,
              }
            : {}),
        })
        .where(eq(adActions.id, id));
      await tx.insert(adActionEvents).values({
        ...base(current, row.accountId),
        actionId: id,
        status: input.status,
        reason: input.reason,
        data: { ...input },
        idempotencyKey: input.idempotencyKey,
        inputChecksum: hash,
      });
      await this.audit.recordInTransaction(tx, current, {
        action: "advertising.action.transition",
        resourceType: "ad_action",
        resourceId: id,
        result: "success",
        metadata: { from: row.status, to: input.status, revision: row.revision + 1 },
      });
      return (await actions(tx, undefined, id))[0]!;
    });
  }
  private async assertCurrentGoal(tx: TenantTransaction, action: ActionRow) {
    if (action.recommendation.productId && action.recommendation.goalVersionId) {
      const versions=await goals(tx,action.accountId,{productId:action.recommendation.productId,latest:true});
      if (versions[0]?.id !== action.recommendation.goalVersionId)
        throw new ConflictException("产品目标版本已变化，请重新分析");
    }
    const run=await requireActionParent(tx,action);
    const sources = run.evidenceImportIds.length
      ? await tx.select().from(adImports).where(and(eq(adImports.accountId,action.accountId),inArray(adImports.id, run.evidenceImportIds)))
      : [];
    if (sources.length !== run.evidenceImportIds.length || sources.some((s) => s.archivedAt))
      throw new ConflictException("原分析来源已归档或不可访问，请重新分析");
  }
  private async invalidate(
    tx: TenantTransaction,
    context: TenantContext,
    accountId: string,
    reason: string,
    productId?: string,
    scope?: AdSaveGoalInput["scope"],
  ) {
    const rows = await tx
      .select()
      .from(adActions)
      .where(
        and(
          eq(adActions.accountId, accountId),
          inArray(adActions.status, [...pendingStates]),
          productId
            ? or(
                sql`${adActions.recommendation}->>'productId'=${productId}`,
                scope
                  ? sql`${adActions.recommendation}->'scope'=${JSON.stringify(scope)}::jsonb`
                  : undefined,
              )
            : undefined,
        ),
      );
    for (const r of rows) {
      await tx
        .update(adActions)
        .set({ status: "stale", revision: r.revision + 1, updatedAt: new Date() })
        .where(eq(adActions.id, r.id));
      await tx.insert(adActionEvents).values({
        ...base(context, accountId),
        actionId: r.id,
        status: "stale",
        reason,
        data: {},
        idempotencyKey: `invalidate:${r.revision + 1}`,
        inputChecksum: adHash([r.id, r.revision, reason]),
      });
    }
  }
  async archive(context: TenantContext, id: string, raw: unknown) {
    const input = AdArchiveInputSchema.parse(raw),
      hash = requestHash(input);
    return this.withWrite(context,"import_archive",(tx:TenantTransaction)=>this.targetOriginal(tx,"import_archive",id,input),async (tx, current) => {
      const [first] = await tx.select().from(adImports).where(eq(adImports.id, id)).limit(1);
      if (!first) throw new NotFoundException("导入记录不存在");
      await requireAdvertisingAccount(tx, current, first.accountId, Permission.CustomerIntelligenceWrite, true);
      await lock(tx, current, first.accountId);
      const [saved] = await tx
        .select()
        .from(adImportEvents)
        .where(
          and(
            eq(adImportEvents.importId, id),
            eq(adImportEvents.idempotencyKey, input.idempotencyKey),
          ),
        )
        .limit(1);
      if (saved) {
        replay(saved, hash);
        return importView((await tx.select().from(adImports).where(eq(adImports.id, id)))[0]!);
      }
      const [row] = await tx.select().from(adImports).where(eq(adImports.id, id)).limit(1);
      if (row.archivedAt) throw new ConflictException("来源已归档");
      const [updated] = await tx
        .update(adImports)
        .set({ archivedAt: new Date() })
        .where(eq(adImports.id, id))
        .returning();
      await tx.insert(adImportEvents).values({
        ...base(current, row.accountId),
        importId: id,
        reason: input.reason,
        idempotencyKey: input.idempotencyKey,
        inputChecksum: hash,
      });
      await this.invalidate(tx, current, row.accountId, "分析来源已归档，请重新分析");
      await this.audit.recordInTransaction(tx, current, {
        action: "advertising.import.archive",
        resourceType: "ad_import",
        resourceId: id,
        result: "success",
        metadata: {},
      });
      return importView(updated);
    });
  }
  async readSource(context: TenantContext, id: string) {
    const first = await this.withCurrent(context, Permission.CustomerIntelligenceRead, async (tx, current) => {
      const [row] = await tx.select().from(adImports).where(eq(adImports.id, id)).limit(1);
      if (!row) throw new NotFoundException("广告来源不可访问");
      await requireAdvertisingAccount(tx, current, row.accountId, Permission.CustomerIntelligenceRead, true);
      return { row, current };
    }, true);
    const bytes = await this.sources.read(first.current, first.row.id, first.row.objectKey, first.row.checksum);
    // No database lock spans private storage I/O. Recheck the same source and
    // current account authority before exposing any downloaded bytes.
    await this.withCurrent(context, Permission.CustomerIntelligenceRead, async (tx, current) => {
      const [row] = await tx.select().from(adImports).where(eq(adImports.id, id)).limit(1);
      if (!row) throw new NotFoundException("广告来源不可访问");
      await requireAdvertisingAccount(tx, current, row.accountId, Permission.CustomerIntelligenceRead, true);
      if (row.accountId !== first.row.accountId || row.objectKey !== first.row.objectKey || row.checksum !== first.row.checksum)
        throw new ConflictException("广告来源依据已变化，请重新读取");
    }, true);
    return { fileName: first.row.fileName, bytes };
  }
  async sealExport(context: TenantContext, raw: AdExportInput) {
    const input = AdExportInputSchema.parse(raw),
      hash = requestHash(input);
    return this.withWrite(context,"export_seal",(tx:TenantTransaction)=>this.targetOriginal(tx,"export_seal",input.runId,input),async (tx, current) => {
      const [run] = await tx
        .select()
        .from(adAnalysisRuns)
        .where(eq(adAnalysisRuns.id, input.runId))
        .limit(1);
      if (!run) throw new NotFoundException("分析记录不存在");
      await requireAdvertisingAccount(tx, current, run.accountId, Permission.CustomerIntelligenceReview, true);
      await lock(tx, current, run.accountId);
      const [saved] = await tx
        .select()
        .from(adExports)
        .where(
          and(
            eq(adExports.accountId, run.accountId),
            eq(adExports.idempotencyKey, input.idempotencyKey),
          ),
        )
        .limit(1);
      if (saved) {
        replay(saved, hash);
        return this.exportView(saved);
      }
      const selected = (await actions(tx, run.accountId,undefined,{ids:input.actionIds})).filter((a) =>
        input.actionIds.includes(a.id),
      );
      if (selected.length !== input.actionIds.length) throw new NotFoundException("调整记录不存在或不可访问");
      if (
        selected.some(
          (a) =>
            !run.result.recommendations.some((r) => r.key === a.recommendation.key) ||
            !["adopted", "executed", "observing", "reviewed"].includes(a.status),
        )
      )
        throw new ConflictException("导出需要本次分析中已采纳或已执行的调整记录");
      for (const a of selected.filter((a) => a.status === "adopted"))
        await this.assertCurrentGoal(
          tx,
          (await tx.select().from(adActions).where(eq(adActions.id, a.id)))[0]!,
        );
      const sources = run.result.evidenceImportIds.length
        ? await tx
            .select()
            .from(adImports)
            .where(inArray(adImports.id, run.result.evidenceImportIds))
        : [];
      if (sources.length !== run.result.evidenceImportIds.length || sources.some((source) => source.accountId !== run.accountId))
        throw new ConflictException("部分来源不可访问，无法封存审阅清单");
      const data = {
        schemaVersion: 1 as const,
        csvFormatVersion: 2 as const,
        run: runView(run),
        actions: selected.sort((a, b) => a.id.localeCompare(b.id)),
        sourcePins: sources.sort((a, b) => a.id.localeCompare(b.id)).map(importView),
        reviewedBy: current.userId,
        marketplaceExecution: "manual" as const,
      };
      const [row] = await tx
        .insert(adExports)
        .values({
          ...base(current, run.accountId),
          runId: run.id,
          data,
          checksum: adHash(data),
          reviewReason: input.reviewReason,
          idempotencyKey: input.idempotencyKey,
          inputChecksum: hash,
        })
        .returning();
      await this.audit.recordInTransaction(tx, current, {
        action: "advertising.export.seal",
        resourceType: "ad_export",
        resourceId: row.id,
        result: "success",
        metadata: { actionCount: selected.length, checksum: row.checksum },
      });
      return this.exportView(row);
    });
  }
  private exportView(row: typeof adExports.$inferSelect) {
    return exportView(row);
  }
  async readExport(context: TenantContext, id: string) {
    return this.withCurrent(context, Permission.CustomerIntelligenceRead, async (tx, current) => {
      const [row] = await tx.select().from(adExports).where(eq(adExports.id, id)).limit(1);
      if (!row) throw new NotFoundException("导出包不可访问");
      await requireAdvertisingAccount(tx, current, row.accountId, Permission.CustomerIntelligenceRead, true);
      return this.exportView(row);
    }, true);
  }
}

