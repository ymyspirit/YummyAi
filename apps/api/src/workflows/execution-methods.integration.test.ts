import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { Permission } from "@yummyai/authz";
import { SecretVault, harnessChecksum } from "@yummyai/ai-core";
import { CatalogPackageService, catalogFingerprint } from "@yummyai/catalog-core";
import { assertPodMethod, PodArtworkOwner, supportedPodMethods } from "@yummyai/pod-core";
import { WorkflowNodeRuntime } from "@yummyai/workflow-core";
import { createEntityId, type CaptureDraft, type TenantContext, type WorkflowGraph } from "@yummyai/contracts";
import { WorkflowExecutionSnapshotSchema } from "@yummyai/contracts/workflow/execution";
import { assetFiles, agentMethods, agentMethodVersions, agentMethodEvents, methodDefinitionChecksum, designVersions, designVersionFiles, catalogOperationReceipts, connectDatabase, designTasks, knowledgeVersions, memberships, membershipRoles, migrateDatabase, podArtworkExecutions as executions, podArtworkInvocations as invocations, podArtworkTaskInputs, podArtworkTasks as tasks, recordAuditInTransaction, roles, workflowNodeAttempts, workflowNodeRuns, withTenant } from "@yummyai/database";
import { createTraceId, type JobEnvelope } from "@yummyai/jobs";
import { createStorageFromEnvironment, type Storage } from "@yummyai/storage";
import { and, desc, eq, sql } from "drizzle-orm";
import { AuditService } from "../audit/audit.service.js";
import { CaptureService } from "../capture/capture.service.js";
import { ResearchClassificationService } from "../research/research-classification.service.js";
import { DrizzleCatalogRepository, ProductService } from "../catalog/product.service.js";
import { MethodGovernanceService } from "../knowledge/method-governance.service.js";
import { KnowledgeService } from "../knowledge/knowledge.service.js";
import { PodWorkbenchService } from "../design/pod-workbench.service.js";
import { WorkflowCapabilityRegistry } from "./workflow-capability.registry.js";
import { WorkflowDefinitionService } from "./workflow-definition.service.js";
import { ExternalWorkflowExecutor, HumanExecutor, InternalCapabilityExecutor, WorkflowExecutorRouter } from "./workflow-node.executor.js";
import { WorkflowRunService } from "./workflow-run.service.js";
import { WorkflowOperatorService } from "./workflow-operator.service.js";
import { HttpPodArtworkGateway } from "../../../worker/src/processors/pod-artwork.http-gateway.js";
import { PodArtworkProcessor } from "../../../worker/src/processors/pod-artwork.processor.js";
import { DrizzlePodArtworkExecutionRepository } from "../../../worker/src/processors/pod-artwork.repository.js";

if (process.env.E2E_ISOLATED_DAILY !== "1" || !/^\/order_daily_e2e_[a-f0-9]{32}$/.test(new URL(process.env.DATABASE_URL!).pathname)) throw new Error("Use the disposable --suite=execution-methods-integration runner");

const profile = "yummyai.custom_product.generate_provisional_facts";
const workflowKey = `workflow.${profile}`, parentKey = "workflow.pod.pattern_crop", podKey = "pod.artwork.pattern_crop";
const cropParameters = { mode: "general", multiCrop: false, maximumCropsPerInput: 1, outputFormat: "png", background: "preserved", perspectiveCorrection: true, cropPaddingPercent: 2 };
describe("published workflow and POD methods on their original owners", () => {
  const database = connectDatabase(), storage = createStorageFromEnvironment(), audit = new AuditService(database);
  const products = new ProductService(new DrizzleCatalogRepository(database)), methods = new MethodGovernanceService(database, audit), knowledge = new KnowledgeService(database, audit);
  const catalog = new CatalogPackageService(database, storage), vault = new SecretVault(new Uint8Array(32).fill(41));
  const pod = new PodArtworkOwner(database, { enqueue: async () => {} }, { isToolEnabled: key => key === "pattern_crop" }, { recordInTransaction: recordAuditInTransaction });
  const runtime = new WorkflowNodeRuntime(database, catalog, pod);
  const definitions = new WorkflowDefinitionService(database, new WorkflowCapabilityRegistry(new PodWorkbenchService({ enabledTools: () => new Set(["pattern_crop"] as const) })));
  const router = new WorkflowExecutorRouter(new HumanExecutor(), new InternalCapabilityExecutor({ enqueue: async () => {} }), new ExternalWorkflowExecutor());
  const runs = new WorkflowRunService(database, definitions, router, runtime), operator = new WorkflowOperatorService(database, runs, catalog, pod);
  const capture = new CaptureService(database, { enqueue: async () => {} }, audit, new ResearchClassificationService(database, audit), storage);
  let image: Buffer;
  beforeAll(async () => { await migrateDatabase(database); await storage.ensureBucket(); image = await sharp({ create: { width: 40, height: 30, channels: 3, background: "blue" } }).png().toBuffer(); });
  afterAll(async () => { await database.client.end(); });

  async function fixture() {
    const context: TenantContext = { tenantId: createEntityId(), userId: createEntityId(), permissions: Object.values(Permission), dataScope: "tenant" }, roleId = createEntityId();
    await database.client.unsafe("insert into organizations(id,name,slug)values($1,'Synthetic method execution',$2)", [context.tenantId, `method-execution-${context.tenantId}`]);
    await database.client.unsafe("insert into app_users(id,oidc_subject,email,display_name)values($1,$2,$3,'Synthetic operator')", [context.userId, `method-execution-${context.userId}`, `${context.userId}@example.test`]);
    await withTenant(database.db, context, async tx => {
      const member = createEntityId();
      await tx.insert(memberships).values({ id: member, tenantId: context.tenantId, userId: context.userId, status: "active" });
      await tx.insert(roles).values({ id: roleId, tenantId: context.tenantId, name: "Synthetic operator", permissions: Object.values(Permission), dataScope: "tenant" });
      await tx.insert(membershipRoles).values({ tenantId: context.tenantId, membershipId: member, roleId });
    });
    const draft: CaptureDraft = { platform: "amazon", marketplace: "www.amazon.com", sourceUrl: `https://www.amazon.com/dp/${createEntityId()}`, externalId: createEntityId(), title: "Synthetic custom mug", parserVersion: "method-fixture-v1", extensionVersion: "0.0.0", domain: "research", price: null, rating: null, reviewCount: null, listingPublishedAt: null, favoriteCount: null, shipping: null, shop: null, reviewSummary: null, reviews: [], reviewCollection: { collectedCount: 0, reportedTotal: null, pageCount: 0, status: "visible", updatedAt: new Date().toISOString() }, taxonomy: [], bullets: [], media: [], variants: [], productInformation: [], contentBlocks: [], missingFields: [], diagnostics: [], captureStatus: "complete", capturedAt: new Date().toISOString() };
    const source = await capture.createSnapshot(context, draft);
    const plan = await products.createPlan(context, { name: "Synthetic governed product", sourceReportIds: [source.snapshotId], customization: { version: 1, fields: [] } });
    await products.transition(context, plan.id, "pending_approval"); await products.transition(context, plan.id, "approved");
    const spu = await products.createSpu(context, plan.id, { code: `METHOD-${plan.id}`, name: "Synthetic governed SPU" });
    const sku = await products.createSku(context, { spuId: spu.id, code: `METHOD-${spu.id}`, attributes: {} });
    const inputId = createEntityId(), stored = await storage.putPrivate(context, { body: image, domain: "authorized", fileName: `${inputId}.png`, mediaType: "image/png" });
    await withTenant(database.db, context, tx => tx.insert(assetFiles).values({ id: inputId, tenantId: context.tenantId, ownerUserId: context.userId, objectKey: stored.objectKey, assetDomain: "authorized", fileName: `${inputId}.png`, mediaType: "image/png", byteSize: image.length, checksumSha256: stored.checksumSha256, rightsStatus: "approved", rightsMetadata: { source: { kind: "owned", reference: "Synthetic method fixture" } } }));
    const input = () => ({ idempotencyKey: createEntityId(), skuId: sku.id, toolKey: "pattern_crop" as const, title: "Synthetic governed crop", inputAssetIds: [inputId], parameterSnapshot: { ...cropParameters } });
    const grant = (permissions: readonly string[] = Object.values(Permission)) => withTenant(database.db, context, tx => tx.update(roles).set({ permissions: [...permissions] }).where(eq(roles.id, roleId)));
    return { context, planId: plan.id, sourceId: source.snapshotId, input, grant };
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>;
  async function methodRow(f: Fixture, key: string) { return (await methods.workspace(f.context)).methods.find(m => m.methodKey === key)!; }
  async function action(f: Fixture, key: string, action: "submit" | "publish" | "disable") {
    const row = await methodRow(f,key);
    return methods.transition(f.context,row.id,action,{ expectedRevision:row.revision,version:action==="disable"?row.activeVersion!:row.latestVersion,reason:"Synthetic reviewed transition",requestId:randomUUID(),...(action==="publish"?{reviewedChecksum:row.latest.checksum}:{}) });
  }
  async function publish(f: Fixture, key: string, notes = "Synthetic reviewed working notes", sources: string[] = []) {
    const row = await methodRow(f,key);
    await methods.save(f.context,{methodKey:key,expectedRevision:row?.revision??0,notes,knowledgeVersionIds:sources,reason:"Synthetic method revision",requestId:randomUUID()});
    await action(f,key,"submit"); await action(f,key,"publish"); return methodRow(f,key);
  }
  async function historicalV1Publication(f: Fixture) {
    const registered = supportedPodMethods().find(method => method.methodKey === podKey && method.executionContract.skill.version === "pod-method-2026-10-18-v1")!;
    const definition = { ...registered, notes: "Synthetic historical publication with the original v1 UI output contract", knowledgeReferences: [] };
    const methodId = createEntityId(), versionId = createEntityId();
    await withTenant(database.db, f.context, async tx => {
      await tx.insert(agentMethods).values({ id: methodId, tenantId: f.context.tenantId, methodKey: podKey, revision: 3, latestVersion: 1, activeVersion: 1, state: "published", adoptedAt: new Date(), createdBy: f.context.userId });
      await tx.insert(agentMethodVersions).values({ id: versionId, tenantId: f.context.tenantId, methodId, version: 1, definition, checksum: methodDefinitionChecksum(definition), reason: "Synthetic historical code-v1 fixture", requestId: randomUUID(), requestChecksum: harnessChecksum(definition), createdBy: f.context.userId });
      await tx.insert(agentMethodEvents).values({ id: createEntityId(), tenantId: f.context.tenantId, methodId, version: 1, revision: 3, action: "publish", reason: "Synthetic original publication", requestId: randomUUID(), requestChecksum: harnessChecksum(definition), createdBy: f.context.userId });
    });
    return { methodId, versionId, registered };
  }
  async function start(f: Fixture, capability = profile) {
    const graph: WorkflowGraph = { viewport:{x:0,y:0,zoom:1}, nodes:[
      {id:"start",kind:"start",title:"Start",description:"",ownerRole:"operator",inputPorts:[],outputPorts:[],config:{parameters:{}},position:{x:0,y:0}},
      {id:"execute",kind:"internal_action",title:"Execute original owner",description:"",ownerRole:"operator",inputPorts:[],outputPorts:[],config:{capabilityKey:capability,parameters:capability===profile?{researchSnapshotId:f.sourceId}:{skuId:f.input().skuId,title:"Synthetic workflow crop",inputAssetIds:f.input().inputAssetIds,parameterSnapshot:{...cropParameters}}},position:{x:0,y:100}},
      {id:"review",kind:"approval_gate",title:"Human review",description:"",ownerRole:"reviewer",inputPorts:[],outputPorts:[],config:{parameters:{},approvalMode:"any"},reworkTargetNodeId:"execute",position:{x:0,y:200}},
      {id:"end",kind:"end",title:"End",description:"",ownerRole:"operator",inputPorts:[],outputPorts:[],config:{parameters:{}},position:{x:0,y:300}},
    ], edges:[{id:"a",source:"start",target:"execute",kind:"success"},{id:"b",source:"execute",target:"review",kind:"success"},{id:"c",source:"review",target:"end",kind:"success"},{id:"d",source:"review",target:"execute",kind:"rework"}] };
    const definition = await definitions.create(f.context,{name:"Synthetic governed workflow",description:"Synthetic only",category:"Acceptance",scope:"team",graph});
    await definitions.publish(f.context,definition.id,definition.revision);
    return runs.start(f.context,{definitionId:definition.id,productPlanId:f.planId});
  }
  async function attempt(f: Fixture, runId: string) {
    const [row] = await withTenant(database.db,f.context,tx=>tx.select({attempt:workflowNodeAttempts,nodeRunId:workflowNodeRuns.id}).from(workflowNodeAttempts).innerJoin(workflowNodeRuns,eq(workflowNodeRuns.id,workflowNodeAttempts.nodeRunId)).where(and(eq(workflowNodeRuns.runId,runId),eq(workflowNodeRuns.nodeId,"execute"))).orderBy(desc(workflowNodeAttempts.attemptNumber)).limit(1));
    return {...row!.attempt,runId,nodeRunId:row!.nodeRunId,attemptId:row!.attempt.id};
  }
  async function podRow(f: Fixture,id:string) { return withTenant(database.db,f.context,async tx=>({task:(await tx.select().from(tasks).where(eq(tasks.id,id)))[0]!,execution:(await tx.select().from(executions).where(eq(executions.taskId,id)))[0],invocations:await tx.select().from(invocations).where(eq(invocations.taskId,id))})); }
  const repository = (store = storage) => new DrizzlePodArtworkExecutionRepository(database,store,vault);
  const job = (f: Fixture,id:string):JobEnvelope=>({jobId:createEntityId(),idempotencyKey:createEntityId(),correlationId:id,traceId:createTraceId(),tenantId:f.context.tenantId,requestedBy:f.context.userId,requestedAt:new Date().toISOString(),attempt:0,maxAttempts:1,payload:{taskId:id}});
  function transport(before?:()=>Promise<unknown>) {
    const bodies:string[]=[];
    const request=vi.fn(async (_input:RequestInfo|URL,init?:RequestInit)=>{bodies.push(String(init?.body??""));await before?.();return new Response(JSON.stringify({outputs:[{dataBase64:image.toString("base64"),mediaType:"image/png",role:"effect",fileName:"crop.png",metadata:{width:40,height:30,unit:"px",colorMode:"rgb",transparent:false,aiInference:"none"}}],modelKey:"pod.synthetic-crop",modelVersion:"fixture-v1",costUsd:0.023,partial:false,qualityCheckSnapshot:{passed:true,mode:"general",inputCoverageComplete:true,cropBoundsValid:true,blankOutputsDetected:false,duplicateOutputsDetected:false,outputChecks:[{fileName:"crop.png",inputOrdinal:0,cropIndex:0,sourceBounds:{x:0,y:0,width:1,height:1},outputWidth:40,outputHeight:30,transparent:false,perspectiveCorrectionValidated:true,cropComplete:true,resultLabel:"synthetic"}]}}),{headers:{"x-request-id":"synthetic-governed-request"}});});
    return {bodies,request,gateway:new HttpPodArtworkGateway("https://synthetic.invalid/pod","synthetic-key",request,1024*1024,"synthetic-method-deployment")};
  }
  async function receipts(f:Fixture) { return withTenant(database.db,f.context,tx=>tx.select().from(catalogOperationReceipts).where(eq(catalogOperationReceipts.productPlanId,f.planId))); }
  async function provenance(f: Fixture) {
    const source=await knowledge.save(f.context,null,{fields:{title:"Synthetic method source",summary:"Reviewed guidance",body:"Keep operating guidance separate from facts and production parameters.",topic:"operations",platform:"all",market:"ALL",spuId:null,sourceType:"team",sourceLabel:"Synthetic team",sourceUrl:"",owner:"Synthetic operator",verifiedOn:"2026-01-01",reviewDueOn:"2099-12-31",tags:[]},expectedRevision:0,reason:"Synthetic source",requestId:randomUUID()});
    for(const action of ["submit","publish"] as const){const row=(await knowledge.workspace(f.context)).entries.find(e=>e.id===source.id)!;await knowledge.change(f.context,source.id,action,{expectedRevision:row.revision,version:row.latestVersion,reason:"Synthetic source review",requestId:randomUUID()});}
    const [version]=await withTenant(database.db,f.context,tx=>tx.select().from(knowledgeVersions).where(eq(knowledgeVersions.entryId,source.id)));
    return { versionId:version!.id, archive:async()=>{const current=(await knowledge.workspace(f.context)).entries.find(e=>e.id===source.id)!;return knowledge.change(f.context,source.id,"archive",{expectedRevision:current.revision,version:current.latestVersion,reason:"Synthetic withdrawn source",requestId:randomUUID()});} };
  }

  it("executes the real archived code-v1 publication through an explicit code-v2 upgrade without rewriting either contract", async () => {
    const f = await fixture(), legacy = await historicalV1Publication(f);
    expect((await methodRow(f,podKey)).activeAvailability).toMatchObject({ supported: true, eligible: true });
    const old = await pod.create(f.context, f.input()), stillOld = await pod.create(f.context, f.input());
    expect(old.methodSnapshot?.executionContract).toEqual(legacy.registered.executionContract);
    expect(stillOld.methodSnapshot?.methodSelection).toMatchObject({ version: 1, versionId: legacy.versionId });
    await publish(f,podKey,"Explicitly reviewed stable completion contract upgrade");
    const fresh = await pod.create(f.context, f.input());
    expect(fresh.methodSnapshot?.executionContract.skill.version).toBe("pod-method-2026-10-18-v2");
    expect(fresh.methodSnapshot?.methodSelection).toMatchObject({ mode: "published", version: 2 });
    for (const created of [old, fresh]) {
      const http = transport();
      expect(await new PodArtworkProcessor(repository(),http.gateway).process(job(f,created.id))).toMatchObject({ disposition: "awaiting_review" });
      const view = await pod.get(f.context, created.id);
      expect(view.methodSnapshot).toEqual(created.methodSnapshot);
      expect(view.completion?.evidence).toMatchObject({ methodValidation: created.id === old.id ? "legacy_owner_view" : "native_completion", methodContractChecksum: created.methodSnapshot!.executionContract.checksum, requiresBusinessReview: true, automaticProductionApproval: false });
      expect(http.request).toHaveBeenCalledOnce();
    }
    const history = await methods.history(f.context, legacy.methodId);
    expect(history.versions.find(version => version.version === 1)?.definition.executionContract).toEqual(legacy.registered.executionContract);
  });
  it("persists one immutable completion with its actual private files, original response and pending business version", async () => {
    const f = await fixture(), created = await pod.create(f.context, f.input()), http = transport();
    await new PodArtworkProcessor(repository(), http.gateway).process(job(f,created.id));
    const view = await pod.get(f.context, created.id), row = await podRow(f, created.id), record = view.completion!;
    expect(record.checksum).toBe(harnessChecksum(record.evidence));
    expect(record.evidence).toMatchObject({ taskId: created.id, designTaskId: created.designTaskId, resultVersionId: view.resultVersionId, inputFingerprint: row.execution!.inputFingerprint, responseChecksum: row.execution!.responseChecksum, qualityCheckChecksum: harnessChecksum(view.qualityCheckSnapshot), resultState: "awaiting_review", methodValidation: "native_completion" });
    const files = await withTenant(database.db,f.context,tx=>tx.select({ asset: assetFiles, version: designVersions, file: designVersionFiles }).from(designVersionFiles).innerJoin(assetFiles,eq(assetFiles.id,designVersionFiles.assetFileId)).innerJoin(designVersions,eq(designVersions.id,designVersionFiles.versionId)).where(eq(designVersions.id,view.resultVersionId!)));
    expect(files).toHaveLength(1);
    expect(files[0]!.version.status).toBe("pending_review");
    expect(record.evidence.outputs).toEqual([{ ordinal:0,assetId:files[0]!.asset.id,assetVersion:files[0]!.asset.version,checksumSha256:files[0]!.asset.checksumSha256,byteSize:files[0]!.asset.byteSize,mediaType:files[0]!.asset.mediaType,role:files[0]!.file.role }]);
    const file = files[0]!.asset;
    expect(Buffer.from(await storage.readPrivate(f.context,{ id:file.id,tenantId:file.tenantId,assetDomain:"authorized",objectKey:file.objectKey },{ requiredDomain: "authorized" }))).toEqual(image);
    for (const patch of [{ completionChecksum: "0".repeat(64) }, { completionEvidence: null, completionChecksum: null }, { completionEvidence: { ...record.evidence, automaticProductionApproval: true } }])
      await expect(withTenant(database.db,f.context,tx=>tx.update(executions).set(patch as Partial<typeof executions.$inferInsert>).where(eq(executions.taskId,created.id)))).rejects.toThrow();
    expect((await pod.get(f.context,created.id)).completion).toEqual(record);
    const other = await fixture();
    await expect(pod.get(other.context,created.id)).rejects.toThrow(/not found/);
  });
  it("rolls back a mismatched first completion and recovers the same paid response without another request", async () => {
    const f=await fixture(),created=await pod.create(f.context,f.input()),http=transport();
    let injected=false,sqlRejected=false;
    // Introduce a serialization defect after native validation, so SQL must reject the file reference.
    const faultyDb=new Proxy(database.db,{get(target,key){
      if(key!=="transaction"){const value=Reflect.get(target,key);return typeof value==="function"?value.bind(target):value;}
      return (callback:Parameters<typeof target.transaction>[0],options:Parameters<typeof target.transaction>[1])=>target.transaction(tx=>callback(new Proxy(tx,{get(transaction,property){
        if(property!=="update"){const value=Reflect.get(transaction,property);return typeof value==="function"?value.bind(transaction):value;}
        return (table:typeof executions)=>{
          const write=transaction.update(table);
          if(table!==executions)return write;
          return new Proxy(write,{get(builder,operation){
            if(operation!=="set"){const value=Reflect.get(builder,operation);return typeof value==="function"?value.bind(builder):value;}
            return (values:Partial<typeof executions.$inferInsert>)=>{
              if(values.phase==="completed"&&values.completionEvidence&&!injected){
                injected=true;
                const evidence={...values.completionEvidence,outputs:values.completionEvidence.outputs.map((output,ordinal)=>ordinal===0?{...output,assetId:created.inputAssets[0]!.assetId}:output)};
                return builder.set({...values,completionEvidence:evidence,completionChecksum:harnessChecksum(evidence)});
              }
              return builder.set(values);
            };
          }});
        };
      }})),options).catch(error=>{
        const cause=error instanceof Error&&error.cause instanceof Error?error.cause:error;
        if(cause instanceof Error&&cause.message==="POD completion output must reference its original owned file")sqlRejected=true;
        throw error;
      });
    }});
    const faulty=new DrizzlePodArtworkExecutionRepository({...database,db:faultyDb},storage,vault);
    expect(await new PodArtworkProcessor(faulty,http.gateway).process(job(f,created.id))).toMatchObject({disposition:"deferred"});
    expect(injected).toBe(true);expect(sqlRejected).toBe(true);
    const interrupted=await podRow(f,created.id);
    expect(interrupted.task.resultVersionId).toBeNull();expect(interrupted.execution?.completionEvidence).toBeNull();
    expect(interrupted.execution?.responseObjectKey).toBeTruthy();expect(interrupted.invocations[0]?.reportedCostUsd).toBe("0.02300000");
    await withTenant(database.db,f.context,tx=>tx.update(executions).set({nextAttemptAt:sql`clock_timestamp()-interval '1 second'`}).where(eq(executions.taskId,created.id)));
    const forbidden={execute:vi.fn()};
    expect(await new PodArtworkProcessor(repository(),forbidden).process(job(f,created.id))).toMatchObject({disposition:"awaiting_review"});
    const final=await pod.get(f.context,created.id);
    expect(final.completion?.evidence.responseChecksum).toBe(interrupted.execution!.responseChecksum);
    expect(final.completion?.evidence.outputs[0]?.assetId).not.toBe(created.inputAssets[0]!.assetId);
    expect((await podRow(f,created.id)).invocations).toHaveLength(1);
    expect(http.request).toHaveBeenCalledOnce();expect(forbidden.execute).not.toHaveBeenCalled();
  });
  it("keeps an original workflow publication through v2, selects v2 for a fresh input and stops at human review",async()=>{
    const f=await fixture(); await publish(f,workflowKey);
    const run=await start(f),old=await attempt(f,run.id),pin=WorkflowExecutionSnapshotSchema.parse(old.inputSnapshot).methodSelection;
    expect(pin).toMatchObject({mode:"published",version:1,methodKey:workflowKey});
    await publish(f,workflowKey,"A separate v2 note");
    expect(await runtime.execute(f.context,old)).toMatchObject({state:"completed"});
    const view=await operator.inspect(f.context,run.id,"execute");expect(view.attempts[0]?.methodSelection).toEqual(pin);
    expect((await runs.get(f.context,run.id)).currentNodeId).toBe("review");expect(await receipts(f)).toHaveLength(1);
    const next=await start(f);expect(WorkflowExecutionSnapshotSchema.parse((await attempt(f,next.id)).inputSnapshot).methodSelection).toMatchObject({mode:"published",version:2});
  });
  it("stops a queued workflow after withdrawal without creating a business receipt",async()=>{
    const f=await fixture();await publish(f,workflowKey);const run=await start(f);await action(f,workflowKey,"disable");
    await runtime.execute(f.context,await attempt(f,run.id));
    expect(await attempt(f,run.id)).toMatchObject({status:"failed",errorCode:"WORKFLOW_METHOD_UNAVAILABLE"});expect(await receipts(f)).toHaveLength(0);
  });
  it("keeps explicit builtin inputs fixed but rejects a genuinely missing legacy pin after first adoption",async()=>{
    const f=await fixture(),explicit=await start(f),legacy=await start(f),old=await attempt(f,legacy.id);
    const historical=WorkflowExecutionSnapshotSchema.parse(old.inputSnapshot);delete historical.methodSelection;
    // Construct a distinct historical fixture; never edit an immutable original input.
    await withTenant(database.db,f.context,async tx=>{
      await tx.update(workflowNodeAttempts).set({status:"cancelled",finishedAt:sql`clock_timestamp()`}).where(eq(workflowNodeAttempts.id,old.id));
      await tx.insert(workflowNodeAttempts).values({id:createEntityId(),tenantId:f.context.tenantId,nodeRunId:old.nodeRunId,attemptNumber:old.attemptNumber+1,status:"queued",requestedBy:f.context.userId,inputSnapshot:historical,inputChecksum:catalogFingerprint(historical)});
      await tx.update(workflowNodeRuns).set({attemptCount:old.attemptNumber+1}).where(eq(workflowNodeRuns.id,old.nodeRunId));
    });
    await publish(f,workflowKey);
    expect(await runtime.execute(f.context,await attempt(f,explicit.id))).toMatchObject({state:"completed"});
    await runtime.execute(f.context,await attempt(f,legacy.id));
    expect(await attempt(f,legacy.id)).toMatchObject({status:"failed",errorCode:"WORKFLOW_METHOD_UNAVAILABLE"});expect(await receipts(f)).toHaveLength(1);
    expect((await attempt(f,legacy.id)).inputSnapshot).not.toHaveProperty("methodSelection");
  });
  it("uses the original POD method, parameters and paid request after another version is published",async()=>{
    const f=await fixture();await publish(f,podKey,"Never copy this reviewed note into processor parameters");
    const input=f.input(),created=await pod.create(f.context,input),pin=created.methodSnapshot;
    await publish(f,podKey,"New notes cannot change the old pinned crop");
    const http=transport();expect(await new PodArtworkProcessor(repository(),http.gateway).process(job(f,created.id))).toMatchObject({disposition:"awaiting_review"});
    const final=await pod.get(f.context,created.id);expect(final.methodSnapshot).toEqual(pin);expect(final.parameterSnapshot).toEqual(input.parameterSnapshot);expect(final.status).toBe("awaiting_review");
    expect(http.request).toHaveBeenCalledOnce();expect(http.bodies[0]).not.toContain("Never copy this reviewed note");expect(final.invocations?.[0]?.method?.key).toBe(podKey);
    expect((await pod.create(f.context,f.input())).methodSnapshot?.methodSelection).toMatchObject({mode:"published",version:2});
  });
  it("makes no POD purchase after queued withdrawal and does not revive an old selection after re-enable",async()=>{
    const f=await fixture();await publish(f,podKey);const created=await pod.create(f.context,f.input());await action(f,podKey,"disable");await publish(f,podKey,"Explicitly re-enabled new publication");
    const http=transport();await expect(new PodArtworkProcessor(repository(),http.gateway).process(job(f,created.id))).rejects.toThrow(/method/);
    expect(http.request).not.toHaveBeenCalled();const final=await podRow(f,created.id);expect(final.task).toMatchObject({status:"blocked",resultVersionId:null});expect(final.invocations.every(i=>!i.submittedAt)).toBe(true);
  });
  it("retains the original response and known bill on in-flight POD withdrawal while rejecting adoption",async()=>{
    const f=await fixture();await publish(f,podKey);const created=await pod.create(f.context,f.input()),http=transport(()=>action(f,podKey,"disable"));
    await expect(new PodArtworkProcessor(repository(),http.gateway).process(job(f,created.id))).rejects.toThrow(/method/);
    const final=await podRow(f,created.id);expect(final.task).toMatchObject({status:"blocked",resultVersionId:null});expect(final.execution?.responseObjectKey).toBeTruthy();expect(final.invocations[0]).toMatchObject({reportedCostUsd:"0.02300000",phase:"failed"});expect(http.request).toHaveBeenCalledOnce();
  });
  it("restores a staged paid response with its v1 pin after v2 without issuing another request",async()=>{
    const f=await fixture();await publish(f,podKey);const created=await pod.create(f.context,f.input()),http=transport();let failed=false;
    const proxy:Storage=new Proxy(storage,{get(target,key){if(key==="putPrivate")return async(actor:TenantContext,input:Parameters<Storage["putPrivate"]>[1])=>{const stored=await target.putPrivate(actor,input);if(input.domain==="quarantine"&&!failed){failed=true;throw new Error("Synthetic lost checkpoint upload acknowledgement");}return stored;};const value=Reflect.get(target,key);return typeof value==="function"?value.bind(target):value;}});
    expect(await new PodArtworkProcessor(repository(proxy),http.gateway).process(job(f,created.id))).toMatchObject({disposition:"deferred"});
    await publish(f,podKey,"New publication while the original local response is pending");
    await withTenant(database.db,f.context,tx=>tx.update(executions).set({nextAttemptAt:sql`clock_timestamp()-interval '1 second'`}).where(eq(executions.taskId,created.id)));
    const forbidden={execute:vi.fn()};expect(await new PodArtworkProcessor(repository(),forbidden).process(job(f,created.id))).toMatchObject({disposition:"awaiting_review"});
    expect(forbidden.execute).not.toHaveBeenCalled();expect(http.request).toHaveBeenCalledOnce();expect((await pod.get(f.context,created.id)).methodSnapshot).toEqual(created.methodSnapshot);
  });
  it("does not backfill a legacy POD task or allow replacement of an immutable method snapshot",async()=>{
    const f=await fixture(),input=f.input(),id=createEntityId(),designId=createEntityId();
    await withTenant(database.db,f.context,async tx=>{
      const [asset]=await tx.select().from(assetFiles).where(eq(assetFiles.id,input.inputAssetIds[0]!));
      await tx.insert(designTasks).values({id:designId,tenantId:f.context.tenantId,skuId:input.skuId,title:"Synthetic legacy task",brief:"Historical missing method evidence",createdBy:f.context.userId});
      await tx.insert(tasks).values({id,tenantId:f.context.tenantId,designTaskId:designId,toolKey:input.toolKey,parameterSnapshot:input.parameterSnapshot,idempotencyKey:input.idempotencyKey,requestedBy:f.context.userId});
      await tx.insert(podArtworkTaskInputs).values({id:createEntityId(),tenantId:f.context.tenantId,taskId:id,assetFileId:asset!.id,ordinal:0,assetVersion:asset!.version,checksumSha256:asset!.checksumSha256,assetDomain:asset!.assetDomain,rightsStatus:asset!.rightsStatus,rightsSourceKind:"owned"});
    });
    expect((await pod.get(f.context,id)).methodSnapshot).toBeNull();await publish(f,podKey);
    const http=transport();await expect(new PodArtworkProcessor(repository(),http.gateway).process(job(f,id))).rejects.toThrow(/method/);expect(http.request).not.toHaveBeenCalled();expect((await podRow(f,id)).execution).toBeUndefined();
    const created=await pod.create(f.context,f.input());await expect(withTenant(database.db,f.context,tx=>tx.update(executions).set({methodSnapshot:null}).where(eq(executions.taskId,created.id)))).rejects.toThrow();
    expect((await pod.get(f.context,created.id)).methodSnapshot).toEqual(created.methodSnapshot);
  });
  it("checks the originating workflow method before the delegated POD request even while its own method is active",async()=>{
    const f=await fixture();await publish(f,parentKey);await publish(f,podKey);const run=await start(f,"pod.pattern_crop"),pending=await attempt(f,run.id);
    expect(await runtime.execute(f.context,pending)).toMatchObject({state:"waiting"});const child=String((await attempt(f,run.id)).outputSnapshot?.delegatedTaskId);await action(f,parentKey,"disable");
    const http=transport();await expect(new PodArtworkProcessor(repository(),http.gateway).process(job(f,child))).rejects.toThrow(/workflow method/);expect(http.request).not.toHaveBeenCalled();expect((await podRow(f,child)).task.resultVersionId).toBeNull();
    expect((await methodRow(f,podKey)).disabledAt).toBeNull();
  });
  it("pins both workflow and child POD at activation and reuses that one child through later publications",async()=>{
    const f=await fixture();await publish(f,parentKey);await publish(f,podKey);const run=await start(f,"pod.pattern_crop"),pending=await attempt(f,run.id),snapshot=WorkflowExecutionSnapshotSchema.parse(pending.inputSnapshot);
    if(snapshot.input.kind!=="pod")throw new Error("Synthetic POD delegation fixture is missing");
    expect(snapshot.methodSelection).toMatchObject({mode:"published",version:1});expect(snapshot.input.value.methodSnapshot?.methodSelection).toMatchObject({mode:"published",version:1});
    await publish(f,parentKey,"New parent publication");await publish(f,podKey,"New processor publication");
    expect(await runtime.execute(f.context,pending)).toMatchObject({state:"waiting"});
    const child=String((await attempt(f,run.id)).outputSnapshot?.delegatedTaskId),http=transport();
    expect((await pod.get(f.context,child)).methodSnapshot).toEqual(snapshot.input.value.methodSnapshot);
    expect(await new PodArtworkProcessor(repository(),http.gateway).process(job(f,child))).toMatchObject({disposition:"awaiting_review"});
    await withTenant(database.db,f.context,tx=>tx.update(workflowNodeAttempts).set({nextAttemptAt:sql`clock_timestamp()-interval '1 second'`}).where(eq(workflowNodeAttempts.id,pending.id)));
    expect(await runtime.execute(f.context,pending)).toMatchObject({state:"completed"});expect((await runs.get(f.context,run.id)).currentNodeId).toBe("review");
    expect(WorkflowExecutionSnapshotSchema.parse((await attempt(f,run.id)).inputSnapshot).methodSelection).toEqual(snapshot.methodSelection);
    expect(http.request).toHaveBeenCalledOnce();expect((await pod.get(f.context,child)).status).toBe("awaiting_review");
    const children=await withTenant(database.db,f.context,tx=>tx.select({id:tasks.id}).from(tasks));expect(children).toEqual([{id:child}]);
  });
  it("requires current knowledge read permission for published POD history and in-flight adoption even without bibliography",async()=>{
    const f=await fixture();await publish(f,podKey);const created=await pod.create(f.context,f.input());
    const reduced={...f.context,permissions:f.context.permissions.filter(p=>p!==Permission.WorkflowRead)};await expect(pod.get(reduced,created.id)).rejects.toThrow();
    const http=transport(()=>f.grant(reduced.permissions));
    try {await expect(new PodArtworkProcessor(repository(),http.gateway).process(job(f,created.id))).rejects.toThrow(/method/);const final=await podRow(f,created.id);expect(final.task.resultVersionId).toBeNull();expect(final.execution?.responseObjectKey).toBeTruthy();expect(final.invocations[0]?.reportedCostUsd).toBe("0.02300000");expect(http.request).toHaveBeenCalledOnce();}finally{await f.grant();}
  });
  it("reuses current knowledge governance and rejects withdrawn method provenance before either owner runs",async()=>{
    const f=await fixture(),source=await provenance(f);
    await publish(f,workflowKey,"Reviewed source-bound workflow",[source.versionId]);await publish(f,podKey,"Reviewed source-bound POD",[source.versionId]);
    const run=await start(f),created=await pod.create(f.context,f.input());
    await source.archive();
    await runtime.execute(f.context,await attempt(f,run.id));expect((await attempt(f,run.id)).errorCode).toBe("WORKFLOW_METHOD_UNAVAILABLE");expect(await receipts(f)).toHaveLength(0);
    const http=transport();await expect(new PodArtworkProcessor(repository(),http.gateway).process(job(f,created.id))).rejects.toThrow(/method/);expect(http.request).not.toHaveBeenCalled();
  });
  it("serializes source withdrawal with the native owner's final method-authority transaction",async()=>{
    const f=await fixture(),source=await provenance(f);await publish(f,podKey,"Source-bound native processing",[source.versionId]);const created=await pod.create(f.context,f.input());
    let entered!:()=>void,release!:()=>void,withdrawn=false;
    const reached=new Promise<void>(resolve=>{entered=resolve;}),held=new Promise<void>(resolve=>{release=resolve;});
    const adoption=withTenant(database.db,f.context,async tx=>{await assertPodMethod(tx,f.context,"pattern_crop",created.methodSnapshot,{lock:true});entered();await held;});
    let withdrawal:Promise<unknown>=Promise.resolve();
    try {
      await Promise.race([reached,adoption.then(()=>{throw new Error("Authority transaction ended before the test barrier");})]);
      withdrawal=source.archive().then(result=>{withdrawn=true;return result;});
      await vi.waitFor(async()=>{const [state]=await database.client.unsafe("select exists(select 1 from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query like '%knowledge_entries%') as blocked");expect(state!.blocked).toBe(true);},{timeout:5000,interval:25});
      expect(withdrawn).toBe(false);
    } finally {release();await Promise.all([adoption,withdrawal]);}
    expect(withdrawn).toBe(true);
    const http=transport();await expect(new PodArtworkProcessor(repository(),http.gateway).process(job(f,created.id))).rejects.toThrow(/method/);expect(http.request).not.toHaveBeenCalled();
  });
});
