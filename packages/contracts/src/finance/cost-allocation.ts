import {z} from "zod";
import {EntityIdSchema} from "@yummyai/contracts/common/ids";
import {FinanceFactTypeSchema,FinanceProfitBucketSchema,FinanceProfitRunViewSchema} from "@yummyai/contracts/finance";
import {FinanceCurrencySchema} from "@yummyai/contracts/finance/monetary";

const Id=EntityIdSchema.transform(value=>value.toLowerCase()),Hash=z.string().regex(/^[a-f0-9]{64}$/);
const Money=z.number().int().nonnegative().safe(),SignedMoney=z.number().int().safe(),At=z.iso.datetime();
const Key=z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/);
const Month=z.string().regex(/^(?!0000)[0-9]{4}-(?:0[1-9]|1[0-2])$/).refine(value=>value!=="9999-12","A period requires its representable next UTC month");
export const FINANCE_COST_ALLOCATION_ALGORITHM="finance-allocation-largest-remainder-v1" as const;
export const FinanceCostAllocationDimensionSchema=z.enum(["order","order_line","sku","listing","period"]);
export const FinanceCostAllocationMethodSchema=z.enum(["equal","manual_weights"]);
export const FinanceCostAllocationWeightSchema=z.string().regex(/^(?:0|[1-9][0-9]{0,20})(?:\.[0-9]{0,8}[1-9])?$/).refine(value=>value!=="0","Weight must be positive");
export const FinanceCostAllocationBasisProblemSchema=z.enum(["source_changed","target_changed","rule_superseded","base_unavailable"]);
export const FinanceCostAllocationBlockingReasonSchema=z.enum(["base_incomplete","base_not_aggregate","not_cost","already_attributed","correction_chain_changed","source_unavailable"]);
const WeightedKey=z.object({key:Key,weight:FinanceCostAllocationWeightSchema}).strict();

/** Split only the already-converted original minor amount; never convert a slice. */
export function splitFinanceCostMinor(amountMinor:number,targets:Array<{key:string;weight:string}>){
 const amount=Money.parse(amountMinor),input=z.array(WeightedKey).min(1).max(1000).parse(targets);
 if(new Set(input.map(item=>item.key)).size!==input.length)throw new Error("Duplicate allocation target");
 const ordered=[...input].sort((left,right)=>left.key<right.key?-1:left.key>right.key?1:0);
 const units=(value:string)=>{const[whole,fraction=""]=value.split(".");return BigInt(whole!)*1_000_000_000n+BigInt(fraction.padEnd(9,"0"));};
 const total=ordered.reduce((sum,item)=>sum+units(item.weight),0n),original=BigInt(amount);
 const rows=ordered.map(item=>{const weightUnits=units(item.weight),numerator=original*weightUnits;
  return{...item,weightUnits:weightUnits.toString(),floorMinor:Number(numerator/total),amountMinor:Number(numerator/total),
   remainderNumerator:(numerator%total).toString(),remainderDenominator:total.toString(),receivesRemainder:false};});
 const remaining=original-rows.reduce((sum,row)=>sum+BigInt(row.floorMinor),0n);
 const ranked=[...rows].sort((left,right)=>{const a=BigInt(left.remainderNumerator),b=BigInt(right.remainderNumerator);return a>b?-1:a<b?1:left.key<right.key?-1:left.key>right.key?1:0;});
 for(let index=0;index<Number(remaining);index++){ranked[index]!.amountMinor++;ranked[index]!.receivesRemainder=true;}
 if(rows.reduce((sum,row)=>sum+BigInt(row.amountMinor),0n)!==original)throw new Error("Allocation does not conserve the original amount");
 return rows;
}

const PageInput={limit:z.union([z.number().int().min(1).max(100),z.string().regex(/^(?:[1-9]|[1-9][0-9]|100)$/).transform(Number)]).default(25),
 cursor:z.string().min(1).max(1024).regex(/^[A-Za-z0-9_-]+$/).optional()};
export const FinanceCostAllocationListInputSchema=z.object({...PageInput,baseRunId:Id.optional(),allocationId:Id.optional()}).strict();
export const FinanceCostAllocationSourceListInputSchema=z.object({...PageInput,baseRunId:Id,dimension:FinanceCostAllocationDimensionSchema}).strict();
export const FinanceCostAllocationTargetListInputSchema=z.object({...PageInput,dimension:FinanceCostAllocationDimensionSchema,key:Key.transform(value=>value.toLowerCase()).optional()}).strict().superRefine((value,ctx)=>{
 if(value.dimension==="period"&&!value.key)ctx.addIssue({code:"custom",path:["key"],message:"Choose an explicit UTC calendar month"});
 if(value.key&&!(value.dimension==="period"?Month:Id).safeParse(value.key).success)ctx.addIssue({code:"custom",path:["key"],message:"Target key must match its real dimension"});
});
const FamilyInput=z.object({rootFactId:Id,targets:z.array(WeightedKey.extend({key:Key.transform(value=>value.toLowerCase())})).min(1).max(1000)}).strict();
export const FinanceCostAllocationPreviewInputSchema=z.object({baseRunId:Id,baseInputChecksum:Hash,allocationId:Id.nullable().default(null),
 expectedVersion:z.number().int().positive().nullable().default(null),dimension:FinanceCostAllocationDimensionSchema,method:FinanceCostAllocationMethodSchema,
 sources:z.array(FamilyInput).min(1).max(100),reasonCode:z.string().min(1).max(100).regex(/^[A-Z0-9][A-Z0-9._-]*$/),
 basisDescription:z.string().trim().min(1).max(1000)}).strict().superRefine((value,ctx)=>{
 if((value.allocationId===null)!==(value.expectedVersion===null))ctx.addIssue({code:"custom",path:["expectedVersion"],message:"An append requires its exact existing version"});
 if(new Set(value.sources.map(source=>source.rootFactId)).size!==value.sources.length)ctx.addIssue({code:"custom",path:["sources"],message:"Each source family occurs once"});
 if(value.sources.reduce((sum,source)=>sum+source.targets.length,0)>1000)ctx.addIssue({code:"custom",path:["sources"],message:"At most1000 explicit targets per decision"});
 for(const[index,source]of value.sources.entries()){
  if(new Set(source.targets.map(target=>target.key)).size!==source.targets.length)ctx.addIssue({code:"custom",path:["sources",index,"targets"],message:"Target keys must be unique"});
  if(source.targets.some(target=>!(value.dimension==="period"?Month:Id).safeParse(target.key).success))ctx.addIssue({code:"custom",path:["sources",index,"targets"],message:"Target key disagrees with the dimension"});
  if(value.method==="equal"&&source.targets.some(target=>target.weight!=="1"))ctx.addIssue({code:"custom",path:["sources",index,"targets"],message:"Equal allocation records weight1"});
 }
});
export const FinanceCostAllocationVersionInputSchema=FinanceCostAllocationPreviewInputSchema.safeExtend({previewChecksum:Hash,idempotencyKey:z.string().min(8).max(200)});
export const CalculateFinanceAllocatedProfitInputSchema=z.object({baseRunId:Id,baseInputChecksum:Hash,dimension:FinanceCostAllocationDimensionSchema,
 versionIds:z.array(Id).max(500),idempotencyKey:z.string().min(8).max(200)}).strict().superRefine((value,ctx)=>{
 if(new Set(value.versionIds).size!==value.versionIds.length)ctx.addIssue({code:"custom",path:["versionIds"],message:"Selected versions must be unique"});
});
export const FinanceCostAllocationTargetSchema=z.object({dimension:FinanceCostAllocationDimensionSchema,key:Key,label:z.string().min(1).max(300),
 orderId:Id.nullable(),orderLineId:Id.nullable(),skuId:Id.nullable(),listingId:Id.nullable(),accountId:Id.nullable(),spuId:Id.nullable(),catalogLinkId:Id.nullable(),period:Month.nullable(),
 periodStart:At.nullable(),periodEnd:At.nullable(),basisChecksum:Hash}).strict().superRefine((value,ctx)=>{
 const actual=value.dimension==="order"?value.orderId:value.dimension==="order_line"?value.orderLineId:value.dimension==="sku"?value.skuId:value.dimension==="listing"?value.listingId:value.period;
 if(actual!==value.key||value.dimension==="order_line"&&value.orderId===null||value.dimension==="period"&&(!value.periodStart||!value.periodEnd))
  ctx.addIssue({code:"custom",message:"The target requires its actual lineage or UTC period"});
 if(value.dimension==="period"&&Month.safeParse(value.key).success&&value.periodStart&&value.periodEnd){const start=`${value.key}-01T00:00:00.000Z`,end=new Date(start);end.setUTCMonth(end.getUTCMonth()+1);
  if(value.periodStart!==start||value.periodEnd!==end.toISOString())ctx.addIssue({code:"custom",message:"The analysis period must retain its exact UTC calendar boundaries"});}
 if(value.dimension!=="period"&&(value.period!==null||value.periodStart!==null||value.periodEnd!==null))ctx.addIssue({code:"custom",message:"Object targets do not invent a period allocation"});
});
export const FinanceCostAllocationShareSchema=z.object({target:FinanceCostAllocationTargetSchema,weight:FinanceCostAllocationWeightSchema,weightUnits:z.string().regex(/^[1-9][0-9]*$/),
 floorMinor:Money,amountMinor:Money,remainderNumerator:z.string().regex(/^(?:0|[1-9][0-9]*)$/),remainderDenominator:z.string().regex(/^[1-9][0-9]*$/),receivesRemainder:z.boolean()}).strict();
export const FinanceCostAllocationSourceSchema=z.object({rootFactId:Id,contributionId:Id,factId:Id,statementId:Id,statementChecksum:Hash,sourceEntryId:z.string().nullable(),
 factType:FinanceFactTypeSchema,effectSign:z.union([z.literal(1),z.literal(-1)]),sourceCurrency:FinanceCurrencySchema,sourceAmountMinor:Money,
 reportingCurrency:FinanceCurrencySchema,reportingAmountMinor:Money,fxRateId:Id.nullable(),sourceChainChecksum:Hash,
 shares:z.array(FinanceCostAllocationShareSchema).min(1).max(1000)}).strict().superRefine((value,ctx)=>{
 if(new Set(value.shares.map(share=>share.target.key)).size!==value.shares.length){ctx.addIssue({code:"custom",message:"Source shares require distinct targets"});return;}
 let expected:ReturnType<typeof splitFinanceCostMinor>;
 try{expected=splitFinanceCostMinor(value.reportingAmountMinor,value.shares.map(share=>({key:share.target.key,weight:share.weight})));}
 catch{ctx.addIssue({code:"custom",message:"Source shares require valid exact weights"});return;}
 const actual=[...value.shares].sort((a,b)=>a.target.key<b.target.key?-1:a.target.key>b.target.key?1:0);
 for(const[index,row]of actual.entries())for(const key of ["weightUnits","floorMinor","amountMinor","remainderNumerator","remainderDenominator","receivesRemainder"]as const)
  if(row[key]!==expected[index]![key])ctx.addIssue({code:"custom",path:["shares",index,key],message:"The exact original minor amount and deterministic tail must be conserved"});
});
export const FinanceCostAllocationPreviewViewSchema=z.object({baseRunId:Id,baseInputChecksum:Hash,allocationId:Id.nullable(),expectedVersion:z.number().int().positive().nullable(),
 dimension:FinanceCostAllocationDimensionSchema,method:FinanceCostAllocationMethodSchema,algorithm:z.literal(FINANCE_COST_ALLOCATION_ALGORITHM),
 reportingCurrency:FinanceCurrencySchema,reasonCode:z.string(),basisDescription:z.string(),sources:z.array(FinanceCostAllocationSourceSchema).min(1).max(20_000),previewChecksum:Hash}).strict().superRefine((value,ctx)=>{
 if(new Set(value.sources.map(source=>source.contributionId)).size!==value.sources.length||value.sources.some(source=>source.reportingCurrency!==value.reportingCurrency||source.shares.some(share=>share.target.dimension!==value.dimension)))
  ctx.addIssue({code:"custom",message:"Preview sources must be unique and retain the selected currency and dimension"});
 if((value.allocationId===null)!==(value.expectedVersion===null)||value.method==="equal"&&value.sources.some(source=>source.shares.some(share=>share.weight!=="1")))
  ctx.addIssue({code:"custom",message:"Preview version expectation and equal weights must retain the approved input"});
 if(value.sources.reduce((sum,source)=>sum+source.shares.length,0)>5000)ctx.addIssue({code:"custom",message:"At most5000 expanded correction-family shares per decision"});
});
export const FinanceCostAllocationVersionViewSchema=z.object({id:Id,allocationId:Id,versionNumber:z.number().int().positive(),previousVersionId:Id.nullable(),status:z.literal("approved"),
 preview:FinanceCostAllocationPreviewViewSchema,checksum:Hash,reviewedBy:Id,createdAt:At,basisProblems:z.array(FinanceCostAllocationBasisProblemSchema)}).strict().superRefine((value,ctx)=>{
 if(value.versionNumber===1?(value.previousVersionId!==null||value.preview.allocationId!==null||value.preview.expectedVersion!==null)
  :(value.previousVersionId===null||value.preview.allocationId!==value.allocationId||value.preview.expectedVersion!==value.versionNumber-1))
  ctx.addIssue({code:"custom",message:"The approved version must retain its original version expectation"});
});
export const FinanceCostAllocationVersionSummarySchema=z.object({id:Id,allocationId:Id,versionNumber:z.number().int().positive(),baseRunId:Id,dimension:FinanceCostAllocationDimensionSchema,
 reportingCurrency:FinanceCurrencySchema,sourceCount:z.number().int().positive(),checksum:Hash,createdAt:At}).strict();
export const FinanceCostSourceOptionSchema=z.object({rootFactId:Id,rootContributionId:Id,statementId:Id,statementChecksum:Hash,factType:FinanceFactTypeSchema,label:z.string(),
 sourceCurrency:FinanceCurrencySchema,sourceAmountMinor:Money,reportingCurrency:FinanceCurrencySchema,reportingAmountMinor:Money.nullable(),
 contributionIds:z.array(Id).min(1),sourceChainChecksum:Hash,blockingReasons:z.array(FinanceCostAllocationBlockingReasonSchema)}).strict();
export const FinanceAllocatedProfitVersionPinSchema=z.object({id:Id,allocationId:Id,versionNumber:z.number().int().positive(),checksum:Hash}).strict();
export const FinanceAllocatedProfitDiagnosticsSchema=z.object({unallocatedContributionIds:z.array(Id),checkedTargetCount:z.number().int().nonnegative(),
 missingByTarget:z.array(z.object({key:Key,missingFactTypes:z.array(FinanceFactTypeSchema)}).strict())}).strict();
export const FinanceAllocatedProfitBreakdownSchema=z.object({target:FinanceCostAllocationTargetSchema,revenueMinor:SignedMoney,costMinor:SignedMoney,profitMinor:SignedMoney,
 factCount:z.number().int().positive()}).strict();
export const FinanceAllocatedProfitRunViewSchema=z.object({id:Id,baseRunId:Id,baseInputChecksum:Hash,dimension:FinanceCostAllocationDimensionSchema,
 versionPins:z.array(FinanceAllocatedProfitVersionPinSchema).max(500),algorithm:z.literal(FINANCE_COST_ALLOCATION_ALGORITHM),reportingCurrency:FinanceCurrencySchema,
 status:z.enum(["complete","incomplete"]),revenueMinor:SignedMoney.nullable(),costMinor:SignedMoney.nullable(),profitMinor:SignedMoney.nullable(),marginBps:z.number().int().nullable(),
 diagnostics:FinanceAllocatedProfitDiagnosticsSchema,breakdowns:z.array(FinanceAllocatedProfitBreakdownSchema),inputChecksum:Hash,createdAt:At,
 basisProblems:z.array(FinanceCostAllocationBasisProblemSchema)}).strict().superRefine((value,ctx)=>{
 const complete=value.diagnostics.unallocatedContributionIds.length===0&&value.diagnostics.checkedTargetCount>0&&value.diagnostics.missingByTarget.length===0;
 if((value.status==="complete")!==complete||!complete&&(value.revenueMinor!==null||value.costMinor!==null||value.profitMinor!==null||value.marginBps!==null||value.breakdowns.length!==0))
  ctx.addIssue({code:"custom",message:"Incomplete target coverage cannot claim verified totals or breakdowns"});
 if(complete&&(value.revenueMinor===null||value.costMinor===null||value.profitMinor===null))ctx.addIssue({code:"custom",message:"Complete attributed profit requires its original conserved totals"});
 if(complete&&value.revenueMinor!==null&&value.costMinor!==null&&value.profitMinor!==null){
  if(BigInt(value.revenueMinor)-BigInt(value.costMinor)!==BigInt(value.profitMinor)||value.breakdowns.length!==value.diagnostics.checkedTargetCount
   ||new Set(value.breakdowns.map(row=>row.target.key)).size!==value.breakdowns.length||value.breakdowns.some(row=>row.target.dimension!==value.dimension||BigInt(row.revenueMinor)-BigInt(row.costMinor)!==BigInt(row.profitMinor)))
   ctx.addIssue({code:"custom",message:"Each actual target profit must retain its selected dimension and exact totals"});
  for(const key of["revenueMinor","costMinor","profitMinor"]as const)if(value.breakdowns.reduce((sum,row)=>sum+BigInt(row[key]),0n)!==BigInt(value[key]!))
   ctx.addIssue({code:"custom",path:[key],message:"Attributed totals must conserve all original contribution amounts"});
 }
});
export const FinanceAllocatedProfitSliceSchema=z.object({id:Id,runId:Id,baseContributionId:Id,sourceFactId:Id,rootFactId:Id,allocationVersionId:Id.nullable(),
 target:FinanceCostAllocationTargetSchema.nullable(),amountMinor:Money,originalReportingAmountMinor:Money,bucket:FinanceProfitBucketSchema,effectSign:z.union([z.literal(1),z.literal(-1)]),factType:FinanceFactTypeSchema,
 weight:FinanceCostAllocationWeightSchema.nullable(),floorMinor:Money.nullable(),remainderNumerator:z.string().regex(/^(?:0|[1-9][0-9]*)$/).nullable(),
 remainderDenominator:z.string().regex(/^[1-9][0-9]*$/).nullable(),receivesRemainder:z.boolean(),createdAt:At}).strict();
const page=<T extends z.ZodType>(item:T)=>z.object({items:z.array(item).max(100),hasMore:z.boolean(),nextCursor:z.string().min(1).max(1024).regex(/^[A-Za-z0-9_-]+$/).nullable(),upperBoundKey:Key.nullable(),
 limit:z.number().int().min(1).max(100),consistency:z.literal("live"),order:z.literal("id_desc")}).strict().superRefine((value,ctx)=>{
 if(value.items.length>value.limit||value.hasMore!==(value.nextCursor!==null)||value.hasMore&&value.items.length!==value.limit)ctx.addIssue({code:"custom",message:"Page and continuation are inconsistent"});
});
export const FinanceCostAllocationVersionPageSchema=page(FinanceCostAllocationVersionSummarySchema);
export const FinanceCostAllocationSourcePageSchema=page(FinanceCostSourceOptionSchema);
export const FinanceCostAllocationTargetPageSchema=page(FinanceCostAllocationTargetSchema);
export const FinanceAllocatedProfitRunPageSchema=page(FinanceAllocatedProfitRunViewSchema);
export const FinanceAllocatedProfitSlicePageSchema=page(FinanceAllocatedProfitSliceSchema);
export const FinanceCostAllocationBaseViewSchema=FinanceProfitRunViewSchema.omit({contributions:true});
export type FinanceCostAllocationDimension=z.infer<typeof FinanceCostAllocationDimensionSchema>;
export type FinanceCostAllocationPreviewInput=z.infer<typeof FinanceCostAllocationPreviewInputSchema>;
export type FinanceCostAllocationVersionInput=z.infer<typeof FinanceCostAllocationVersionInputSchema>;
export type CalculateFinanceAllocatedProfitInput=z.infer<typeof CalculateFinanceAllocatedProfitInputSchema>;
export type FinanceCostAllocationTarget=z.infer<typeof FinanceCostAllocationTargetSchema>;
export type FinanceCostAllocationShare=z.infer<typeof FinanceCostAllocationShareSchema>;
export type FinanceCostAllocationSource=z.infer<typeof FinanceCostAllocationSourceSchema>;
export type FinanceCostAllocationPreview=z.infer<typeof FinanceCostAllocationPreviewViewSchema>;
export type FinanceCostAllocationVersion=z.infer<typeof FinanceCostAllocationVersionViewSchema>;
export type FinanceCostAllocationVersionSummary=z.infer<typeof FinanceCostAllocationVersionSummarySchema>;
export type FinanceCostSourceOption=z.infer<typeof FinanceCostSourceOptionSchema>;
export type FinanceAllocatedProfitVersionPin=z.infer<typeof FinanceAllocatedProfitVersionPinSchema>;
export type FinanceAllocatedProfitDiagnostics=z.infer<typeof FinanceAllocatedProfitDiagnosticsSchema>;
export type FinanceAllocatedProfitBreakdown=z.infer<typeof FinanceAllocatedProfitBreakdownSchema>;
export type FinanceAllocatedProfitRun=z.infer<typeof FinanceAllocatedProfitRunViewSchema>;
export type FinanceAllocatedProfitSlice=z.infer<typeof FinanceAllocatedProfitSliceSchema>;

export function normalizeFinanceCostAllocationPreviewInput(raw:FinanceCostAllocationPreviewInput){
 const value=FinanceCostAllocationPreviewInputSchema.parse(raw);
 return{...value,sources:value.sources.map(source=>({...source,targets:[...source.targets].sort((a,b)=>a.key<b.key?-1:a.key>b.key?1:0)}))
  .sort((a,b)=>a.rootFactId<b.rootFactId?-1:a.rootFactId>b.rootFactId?1:0)};
}
export function financeCostVersionRequestIdentity(raw:FinanceCostAllocationVersionInput){
 const{previewChecksum,idempotencyKey,...preview}=FinanceCostAllocationVersionInputSchema.parse(raw);
 return{version:1 as const,operation:"version" as const,input:{...normalizeFinanceCostAllocationPreviewInput(preview),previewChecksum,idempotencyKey}};
}
export function financeCostRunRequestIdentity(raw:CalculateFinanceAllocatedProfitInput){
 const value=CalculateFinanceAllocatedProfitInputSchema.parse(raw);
 return{version:1 as const,operation:"run" as const,input:{...value,versionIds:[...value.versionIds].sort()}};
}
export function financeCostTargetBasisIdentity(target:FinanceCostAllocationTarget){
 return{dimension:target.dimension,key:target.key,orderId:target.orderId,orderLineId:target.orderLineId,skuId:target.skuId,listingId:target.listingId,
  accountId:target.accountId,spuId:target.spuId,catalogLinkId:target.catalogLinkId,period:target.period,periodStart:target.periodStart,periodEnd:target.periodEnd};
}
export function financeCostPreviewChecksumIdentity(preview:Omit<FinanceCostAllocationPreview,"previewChecksum">|FinanceCostAllocationPreview){
 const{previewChecksum:ignored,...value}=preview as FinanceCostAllocationPreview;void ignored;
 return{...value,sources:value.sources.map(source=>({...source,shares:[...source.shares].sort((a,b)=>a.target.key<b.target.key?-1:a.target.key>b.target.key?1:0)}))
  .sort((a,b)=>a.contributionId<b.contributionId?-1:a.contributionId>b.contributionId?1:0)};
}
export function financeCostVersionChecksumIdentity(value:Pick<FinanceCostAllocationVersion,"allocationId"|"versionNumber"|"previousVersionId"|"preview">){
 return{allocationId:value.allocationId,versionNumber:value.versionNumber,previousVersionId:value.previousVersionId,preview:value.preview};
}
export function financeAllocatedProfitInputIdentity(value:Pick<FinanceAllocatedProfitRun,"baseRunId"|"baseInputChecksum"|"dimension"|"versionPins">){
 return{baseRunId:value.baseRunId,baseInputChecksum:value.baseInputChecksum,dimension:value.dimension,versionPins:[...value.versionPins].sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0),algorithm:FINANCE_COST_ALLOCATION_ALGORITHM};
}
export function financeCostSourceChainIdentity(rootFactId:string,facts:Array<{id:string;statementId:string;statementChecksum:string;correctsFactId:string|null;correctionKind:string}>){
 return{rootFactId,facts:[...facts].map(fact=>({id:fact.id,statementId:fact.statementId,statementChecksum:fact.statementChecksum,correctsFactId:fact.correctsFactId,correctionKind:fact.correctionKind}))
  .sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0)};
}
