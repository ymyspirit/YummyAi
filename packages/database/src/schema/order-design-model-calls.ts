import {sql} from "drizzle-orm";
import {pgTable,uuid,integer,text,numeric,timestamp,foreignKey,uniqueIndex,check,jsonb} from "drizzle-orm/pg-core";
import type {ModelTokenUsage} from "@yummyai/contracts/ai/model-usage";
import {organizations,users} from "./identity.js";
import {aiBudgetLedger} from "./ai.js";
import {orderDesignAgentRuns,orderDesignAgentSteps} from "./order-design-agent.js";

/** Original paid-call and minimal fee metadata. Never contains order/image/prompt data. */
export const orderDesignModelCalls=pgTable("order_design_model_calls",{
 id:uuid("id").primaryKey(),tenantId:uuid("tenant_id").notNull().references(()=>organizations.id),
 runId:uuid("run_id").notNull(),stepId:uuid("step_id").notNull(),requestId:uuid("request_id").notNull(),
 attempt:integer("attempt").notNull(),claimToken:uuid("claim_token").notNull(),budgetLedgerId:uuid("budget_ledger_id").notNull(),
 requestedBy:uuid("requested_by").notNull().references(()=>users.id),
 submittedAt:timestamp("submitted_at",{mode:"date",withTimezone:true}).notNull().defaultNow(),
 receivedAt:timestamp("received_at",{mode:"date",withTimezone:true}),
 costReportState:text("cost_report_state").$type<"pending"|"unknown"|"reported"|"invalid">().notNull().default("pending"),
 reportedCostUsd:numeric("reported_cost_usd",{precision:20,scale:8}),
 tokenUsage:jsonb("token_usage").$type<ModelTokenUsage>(),
},t=>[
 uniqueIndex("order_design_model_calls_tenant_id_unique").on(t.tenantId,t.id),
 uniqueIndex("order_design_model_calls_attempt_unique").on(t.tenantId,t.stepId,t.attempt),
 uniqueIndex("order_design_model_calls_claim_unique").on(t.tenantId,t.stepId,t.claimToken),
 uniqueIndex("order_design_model_calls_budget_unique").on(t.tenantId,t.budgetLedgerId),
 foreignKey({columns:[t.tenantId,t.runId],foreignColumns:[orderDesignAgentRuns.tenantId,orderDesignAgentRuns.id],name:"order_design_model_calls_run_fk"}),
 foreignKey({columns:[t.tenantId,t.stepId],foreignColumns:[orderDesignAgentSteps.tenantId,orderDesignAgentSteps.id],name:"order_design_model_calls_step_fk"}),
 foreignKey({columns:[t.tenantId,t.budgetLedgerId],foreignColumns:[aiBudgetLedger.tenantId,aiBudgetLedger.id],name:"order_design_model_calls_budget_fk"}),
 check("order_design_model_calls_attempt_check",sql`${t.attempt}>0`),
 check("order_design_model_calls_token_usage_check",sql`${t.tokenUsage} is null or (${t.receivedAt} is not null and jsonb_typeof(${t.tokenUsage})='object' and coalesce(${t.tokenUsage}->>'version','')='model-token-usage-v1')`),
 check("order_design_model_calls_id_check",sql`substring(${t.id}::text from 15 for 1)='7'`),
 check("order_design_model_calls_receipt_check",sql`(${t.receivedAt} is null and ${t.costReportState}='pending' and ${t.reportedCostUsd} is null) or (${t.receivedAt} is not null and ((${t.costReportState}='reported' and ${t.reportedCostUsd} is not null and ${t.reportedCostUsd}>=0 and ${t.reportedCostUsd}<=1000000) or (${t.costReportState} in ('unknown','invalid') and ${t.reportedCostUsd} is null)))`),
]);
