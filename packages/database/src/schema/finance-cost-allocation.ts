import {sql} from "drizzle-orm";
import {bigint,check,foreignKey,index,integer,jsonb,pgTable,text,timestamp,unique,uniqueIndex,uuid,boolean} from "drizzle-orm/pg-core";
import type {CalculateFinanceAllocatedProfitInput,FinanceAllocatedProfitBreakdown,FinanceAllocatedProfitDiagnostics,FinanceAllocatedProfitRun,
 FinanceAllocatedProfitVersionPin,FinanceCostAllocationDimension,FinanceCostAllocationPreview,FinanceCostAllocationTarget,FinanceCostAllocationVersionInput} from "@yummyai/contracts/finance/cost-allocation";
import type {FinanceFactType,FinanceProfitBucket} from "@yummyai/contracts/finance";
import {organizations,users} from "./identity.js";
import {financeFacts,financeProfitContributions,financeProfitRuns} from "./finance.js";

/** Approved attribution decisions; the original fact and contribution remain unchanged. */
export const financeCostAllocationVersions=pgTable("finance_cost_allocation_versions",{
 id:uuid("id").primaryKey(),tenantId:uuid("tenant_id").notNull().references(()=>organizations.id),allocationId:uuid("allocation_id").notNull(),
 versionNumber:integer("version_number").notNull(),previousVersionId:uuid("previous_version_id"),baseRunId:uuid("base_run_id").notNull(),baseInputChecksum:text("base_input_checksum").notNull(),
 dimension:text("dimension").$type<FinanceCostAllocationDimension>().notNull(),method:text("method").$type<FinanceCostAllocationPreview["method"]>().notNull(),algorithm:text("algorithm").notNull(),
 reasonCode:text("reason_code").notNull(),basisDescription:text("basis_description").notNull(),preview:jsonb("preview").$type<FinanceCostAllocationPreview>().notNull(),checksum:text("checksum").notNull(),
 requestIdentity:jsonb("request_identity").$type<{version:1;operation:"version";input:FinanceCostAllocationVersionInput}>().notNull(),requestChecksum:text("request_checksum").notNull(),idempotencyKey:text("idempotency_key").notNull(),
 reviewedBy:uuid("reviewed_by").notNull().references(()=>users.id),createdAt:timestamp("created_at",{withTimezone:true,mode:"date"}).defaultNow().notNull(),
},t=>[
 unique("finance_cost_version_tenant_unique").on(t.tenantId,t.id),uniqueIndex("finance_cost_version_number").on(t.tenantId,t.allocationId,t.versionNumber),
 uniqueIndex("finance_cost_version_request").on(t.tenantId,t.idempotencyKey),index("finance_cost_version_base").on(t.tenantId,t.baseRunId,t.id),
 foreignKey({columns:[t.tenantId,t.baseRunId],foreignColumns:[financeProfitRuns.tenantId,financeProfitRuns.id],name:"finance_cost_version_base_fk"}),
 foreignKey({columns:[t.tenantId,t.previousVersionId],foreignColumns:[t.tenantId,t.id],name:"finance_cost_version_previous_fk"}),
 check("finance_cost_version_number_check",sql`${t.versionNumber}>0 and ((${t.versionNumber}=1 and ${t.previousVersionId} is null) or (${t.versionNumber}>1 and ${t.previousVersionId} is not null))`),
 check("finance_cost_version_dimension",sql`${t.dimension} in ('order','order_line','sku','listing','period')`),
 check("finance_cost_version_method",sql`${t.method} in ('equal','manual_weights') and ${t.algorithm}='finance-allocation-largest-remainder-v1'`),
]);

/** Derived profit version pins an original verified aggregate run and explicit rules. */
export const financeAllocatedProfitRuns=pgTable("finance_allocated_profit_runs",{
 id:uuid("id").primaryKey(),tenantId:uuid("tenant_id").notNull().references(()=>organizations.id),baseRunId:uuid("base_run_id").notNull(),baseInputChecksum:text("base_input_checksum").notNull(),
 dimension:text("dimension").$type<FinanceCostAllocationDimension>().notNull(),versionPins:jsonb("version_pins").$type<FinanceAllocatedProfitVersionPin[]>().notNull(),algorithm:text("algorithm").notNull(),
 reportingCurrency:text("reporting_currency").notNull(),status:text("status").$type<FinanceAllocatedProfitRun["status"]>().notNull(),revenueMinor:bigint("revenue_minor",{mode:"number"}),
 costMinor:bigint("cost_minor",{mode:"number"}),profitMinor:bigint("profit_minor",{mode:"number"}),marginBps:integer("margin_bps"),
 diagnostics:jsonb("diagnostics").$type<FinanceAllocatedProfitDiagnostics>().notNull(),breakdowns:jsonb("breakdowns").$type<FinanceAllocatedProfitBreakdown[]>().notNull(),
 inputChecksum:text("input_checksum").notNull(),requestIdentity:jsonb("request_identity").$type<{version:1;operation:"run";input:CalculateFinanceAllocatedProfitInput}>().notNull(),requestChecksum:text("request_checksum").notNull(),
 idempotencyKey:text("idempotency_key").notNull(),calculatedBy:uuid("calculated_by").notNull().references(()=>users.id),createdAt:timestamp("created_at",{withTimezone:true,mode:"date"}).defaultNow().notNull(),
},t=>[
 unique("finance_allocated_run_tenant_unique").on(t.tenantId,t.id),uniqueIndex("finance_allocated_run_request").on(t.tenantId,t.idempotencyKey),
 index("finance_allocated_run_base").on(t.tenantId,t.baseRunId,t.id),foreignKey({columns:[t.tenantId,t.baseRunId],foreignColumns:[financeProfitRuns.tenantId,financeProfitRuns.id],name:"finance_allocated_run_base_fk"}),
 check("finance_allocated_run_dimension",sql`${t.dimension} in ('order','order_line','sku','listing','period')`),
 check("finance_allocated_run_status",sql`(${t.status}='incomplete' and ${t.revenueMinor} is null and ${t.costMinor} is null and ${t.profitMinor} is null and ${t.marginBps} is null) or (${t.status}='complete' and ${t.revenueMinor} is not null and ${t.costMinor} is not null and ${t.profitMinor} is not null)`),
]);

/** Evidence slices, including unassigned and zero shares; never additional costs. */
export const financeAllocatedProfitSlices=pgTable("finance_allocated_profit_slices",{
 id:uuid("id").primaryKey(),tenantId:uuid("tenant_id").notNull().references(()=>organizations.id),runId:uuid("run_id").notNull(),baseContributionId:uuid("base_contribution_id").notNull(),
 sourceFactId:uuid("source_fact_id").notNull(),rootFactId:uuid("root_fact_id").notNull(),allocationVersionId:uuid("allocation_version_id"),target:jsonb("target").$type<FinanceCostAllocationTarget|null>(),
 amountMinor:bigint("amount_minor",{mode:"number"}).notNull(),originalReportingAmountMinor:bigint("original_reporting_amount_minor",{mode:"number"}).notNull(),
 bucket:text("bucket").$type<FinanceProfitBucket>().notNull(),effectSign:integer("effect_sign").$type<1|-1>().notNull(),factType:text("fact_type").$type<FinanceFactType>().notNull(),weight:text("weight"),
 floorMinor:bigint("floor_minor",{mode:"number"}),remainderNumerator:text("remainder_numerator"),remainderDenominator:text("remainder_denominator"),receivesRemainder:boolean("receives_remainder").notNull(),
 createdAt:timestamp("created_at",{withTimezone:true,mode:"date"}).defaultNow().notNull(),
},t=>[
 unique("finance_allocated_slice_tenant_unique").on(t.tenantId,t.id),
 uniqueIndex("finance_allocated_slice_target").on(t.tenantId,t.runId,t.baseContributionId,sql`coalesce(${t.target}->>'key','')`),
 index("finance_allocated_slice_run").on(t.tenantId,t.runId,t.id),
 foreignKey({columns:[t.tenantId,t.runId],foreignColumns:[financeAllocatedProfitRuns.tenantId,financeAllocatedProfitRuns.id],name:"finance_allocated_slice_run_fk"}),
 foreignKey({columns:[t.tenantId,t.baseContributionId],foreignColumns:[financeProfitContributions.tenantId,financeProfitContributions.id],name:"finance_allocated_slice_contribution_fk"}),
 foreignKey({columns:[t.tenantId,t.sourceFactId],foreignColumns:[financeFacts.tenantId,financeFacts.id],name:"finance_allocated_slice_fact_fk"}),
 foreignKey({columns:[t.tenantId,t.rootFactId],foreignColumns:[financeFacts.tenantId,financeFacts.id],name:"finance_allocated_slice_root_fk"}),
 foreignKey({columns:[t.tenantId,t.allocationVersionId],foreignColumns:[financeCostAllocationVersions.tenantId,financeCostAllocationVersions.id],name:"finance_allocated_slice_version_fk"}),
 check("finance_allocated_slice_amount",sql`${t.amountMinor} between 0 and 9007199254740991 and ${t.originalReportingAmountMinor} between 0 and 9007199254740991`),
 check("finance_allocated_slice_bucket",sql`${t.bucket} in ('revenue','cost','unclassified') and ${t.effectSign} in (-1,1)`),
]);
