import {createHash} from "node:crypto";
import {ConflictException,Inject,Injectable,NotFoundException} from "@nestjs/common";
import {ForbiddenError,Permission} from "@yummyai/authz";
import type {TenantContext} from "@yummyai/contracts";
import {canonicalFinanceCommandOriginal,FinanceCommandResultSchema,type FinanceCommandKind,type FinanceCommandResult,
  type FinanceCommandScope,type PrepareFinanceCommand} from "@yummyai/contracts/finance/finance-command";
import {financeSourceScopeKey} from "@yummyai/contracts/finance/source-identity";
import {financeOriginalWriteProofs,financeStatements,financeFxRates,financeProfitMetrics,financePayableBills,financePayablePayments,
  financePaymentAllocations,financeCostAllocationVersions,financeProfitRuns,type TenantTransaction} from "@yummyai/database";
import {and,desc,eq,sql} from "drizzle-orm";
import {FinanceService,currentFinanceAuthority} from "./finance.service.js";
import {FinancePayablesService} from "./finance-payables.service.js";
import {FinancePayablesAdjustmentsService} from "./finance-payables-adjustments.service.js";
import {FinanceCostAllocationService} from "./finance-cost-allocation.service.js";
import {financeCommandKeyLock,financeCommandPermission} from "./finance-command-lock.js";
export {financeCommandKeyLock,financeCommandPermission} from "./finance-command-lock.js";

const tables:Record<FinanceCommandKind,string>={statement_record:"finance_statements",fx_rate_record:"finance_fx_rates",metric_upsert:"finance_profit_metric_versions",
  profit_calculate:"finance_profit_runs",bill_record:"finance_payable_bills",payment_record:"finance_payable_payments",payment_allocate:"finance_payment_allocation_batches",
  allocation_release:"finance_allocation_releases",bill_adjustment_record:"finance_bill_adjustments",payment_adjustment_record:"finance_payment_adjustments",
  cost_version_approve:"finance_cost_allocation_versions",allocated_profit_calculate:"finance_allocated_profit_runs"};
function conflict():never{throw new ConflictException({code:"finance_original_existing_fact",message:"原请求或业务凭据已经存在 请核对原始记录 不能追认为新提交"});}

/** Thin transaction delegation. The existing four owners retain every business algorithm and gate. */
@Injectable()
export class FinanceCommandOwnerAdapter {
  constructor(@Inject(FinanceService) private readonly finance:FinanceService,
    @Inject(FinancePayablesService) private readonly payables:FinancePayablesService,
    @Inject(FinancePayablesAdjustmentsService) private readonly adjustments:FinancePayablesAdjustmentsService,
    @Inject(FinanceCostAllocationService) private readonly cost:FinanceCostAllocationService){}

  async bindingInTransaction(tx:TenantTransaction,_current:TenantContext,original:PrepareFinanceCommand){
    const [row]=await tx.execute<{checksum:string}>(sql`select finance_command_body_hash(${original.kind},${original.targetId}::uuid,${JSON.stringify(original.input)}::jsonb) as checksum`);
    if(!row)throw new ConflictException("财务原请求摘要不可用");
    return {requestKey:original.input.idempotencyKey,requestChecksum:createHash("sha256").update(canonicalFinanceCommandOriginal(original)).digest("hex"),ownerInputChecksum:row.checksum};
  }

  async validateInTransaction(tx:TenantTransaction,context:TenantContext,original:PrepareFinanceCommand){
    const current=await currentFinanceAuthority(tx,context,financeCommandPermission(original.kind));
    await financeCommandKeyLock(tx,current,original.kind,original.input.idempotencyKey);
    const existing=await tx.execute(sql`select id from ${sql.raw(tables[original.kind])} where idempotency_key=${original.input.idempotencyKey} limit 1`);
    if(existing.length)conflict();
    if(original.kind==="statement_record"){
      const input=original.input;
      if(!input.sourceIdentity)throw new ConflictException({code:"finance_source_identity_required",message:"新财务凭据必须保留真实来源身份"});
      const scope=financeSourceScopeKey({...input,sourceIdentity:input.sourceIdentity});
      const [old]=await tx.select({id:financeStatements.id}).from(financeStatements).where(and(eq(financeStatements.provider,input.provider),
        eq(financeStatements.scopeKey,scope),eq(financeStatements.externalStatementId,input.externalStatementId))).limit(1);
      if(old)conflict();
    }else if(original.kind==="fx_rate_record"){
      const input=original.input;
      const [old]=await tx.select({id:financeFxRates.id}).from(financeFxRates).where(and(eq(financeFxRates.source,input.source),
        eq(financeFxRates.baseCurrency,input.baseCurrency),eq(financeFxRates.quoteCurrency,input.quoteCurrency),
        eq(financeFxRates.effectiveAt,new Date(input.effectiveAt)),eq(financeFxRates.retrievedAt,new Date(input.retrievedAt)))).limit(1);
      if(old)conflict();
    }
    await this.targetInTransaction(tx,original);
    if(original.kind==="statement_record"||original.kind==="fx_rate_record"||original.kind==="metric_upsert"||original.kind==="profit_calculate")
      await this.finance.validateCommandInTransaction(tx,current,original);
    else if(original.kind==="bill_record"||original.kind==="payment_record"||original.kind==="payment_allocate"||original.kind==="allocation_release")
      await this.payables.validateCommandInTransaction(tx,current,original);
    else if(original.kind==="bill_adjustment_record"||original.kind==="payment_adjustment_record")
      await this.adjustments.validateCommandInTransaction(tx,current,original);
    else await this.cost.validateCommandInTransaction(tx,current,original);
  }

  async readInTransaction(tx:TenantTransaction,context:TenantContext,scope:FinanceCommandScope,resultId?:string|null):Promise<FinanceCommandResult|null>{
    try{await currentFinanceAuthority(tx,context,Permission.FinanceRead);}
    catch(error){if(!(error instanceof ForbiddenError))throw error;await currentFinanceAuthority(tx,context,financeCommandPermission(scope.kind));}
    if(!resultId){await this.targetInTransaction(tx,scope);return null;}
    const [proof]=await tx.select({id:financeOriginalWriteProofs.resultId,parentId:financeOriginalWriteProofs.parentId,version:financeOriginalWriteProofs.version,
      actorId:financeOriginalWriteProofs.actorId,targetId:financeOriginalWriteProofs.targetId}).from(financeOriginalWriteProofs)
      .where(and(eq(financeOriginalWriteProofs.kind,scope.kind),eq(financeOriginalWriteProofs.resultId,resultId))).limit(1);
    if(!proof||proof.actorId!==context.userId||proof.targetId!==scope.targetId)throw new NotFoundException("本人财务原提交结果不存在");
    return FinanceCommandResultSchema.parse({kind:scope.kind,id:proof.id,parentId:proof.parentId,version:proof.version});
  }

  async executeInTransaction(tx:TenantTransaction,context:TenantContext,original:PrepareFinanceCommand):Promise<FinanceCommandResult>{
    await this.validateInTransaction(tx,context,original);
    let id:string;
    switch(original.kind){
      case "statement_record":id=(await this.finance.recordStatementInTransaction(tx,context,original.input)).id;break;
      case "fx_rate_record":id=(await this.finance.recordFxRateInTransaction(tx,context,original.input)).id;break;
      case "metric_upsert":id=(await this.finance.upsertProfitMetricInTransaction(tx,context,original.input)).version.id;break;
      case "profit_calculate":id=(await this.finance.calculateProfitInTransaction(tx,context,original.input)).id;break;
      case "bill_record":id=(await this.payables.recordBillInTransaction(tx,context,original.input)).id;break;
      case "payment_record":id=(await this.payables.recordPaymentInTransaction(tx,context,original.input)).id;break;
      case "payment_allocate":id=(await this.payables.allocateInTransaction(tx,context,original.input)).id;break;
      case "allocation_release":id=(await this.payables.releaseInTransaction(tx,context,original.targetId,original.input)).id;break;
      case "bill_adjustment_record":id=(await this.adjustments.recordBillAdjustmentInTransaction(tx,context,original.targetId,original.input)).id;break;
      case "payment_adjustment_record":id=(await this.adjustments.recordPaymentAdjustmentInTransaction(tx,context,original.targetId,original.input)).id;break;
      case "cost_version_approve":id=(await this.cost.approveInTransaction(tx,context,original.input)).id;break;
      case "allocated_profit_calculate":id=(await this.cost.calculateInTransaction(tx,context,original.input)).id;break;
    }
    const [proof]=await tx.select().from(financeOriginalWriteProofs).where(and(eq(financeOriginalWriteProofs.kind,original.kind),eq(financeOriginalWriteProofs.resultId,id))).limit(1);
    const [transaction]=await tx.execute<{id:string}>(sql`select pg_current_xact_id()::text as id`);
    if(!proof?.commandId||proof.creationTransactionId!==transaction?.id)conflict();
    return FinanceCommandResultSchema.parse({kind:original.kind,id,parentId:proof.parentId,version:proof.version});
  }

  private async targetInTransaction(tx:TenantTransaction,scope:FinanceCommandScope){
    if(scope.targetId===null)return;
    let exists=false;
    if(scope.kind==="metric_upsert"||scope.kind==="profit_calculate")exists=(await tx.select({id:financeProfitMetrics.id}).from(financeProfitMetrics).where(eq(financeProfitMetrics.id,scope.targetId)).limit(1)).length>0;
    else if(scope.kind==="payment_allocate"||scope.kind==="payment_adjustment_record")exists=(await tx.select({id:financePayablePayments.id}).from(financePayablePayments).where(eq(financePayablePayments.id,scope.targetId)).limit(1)).length>0;
    else if(scope.kind==="bill_adjustment_record")exists=(await tx.select({id:financePayableBills.id}).from(financePayableBills).where(eq(financePayableBills.id,scope.targetId)).limit(1)).length>0;
    else if(scope.kind==="allocation_release")exists=(await tx.select({id:financePaymentAllocations.id}).from(financePaymentAllocations).where(eq(financePaymentAllocations.id,scope.targetId)).limit(1)).length>0;
    else if(scope.kind==="cost_version_approve")exists=(await tx.select({id:financeCostAllocationVersions.id}).from(financeCostAllocationVersions).where(eq(financeCostAllocationVersions.allocationId,scope.targetId)).orderBy(desc(financeCostAllocationVersions.versionNumber)).limit(1)).length>0;
    else if(scope.kind==="allocated_profit_calculate")exists=(await tx.select({id:financeProfitRuns.id}).from(financeProfitRuns).where(eq(financeProfitRuns.id,scope.targetId)).limit(1)).length>0;
    if(!exists)throw new NotFoundException("原财务目标不存在");
  }
}
