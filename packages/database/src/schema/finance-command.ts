import {sql} from "drizzle-orm";
import {check,foreignKey,index,integer,jsonb,pgTable,primaryKey,text,timestamp,uniqueIndex,uuid} from "drizzle-orm/pg-core";
import type {TenantContext} from "@yummyai/contracts/tenant/tenant-context";
import type {FinanceCommandKind,FinanceCommandDetail} from "@yummyai/contracts/finance/finance-command";
import {organizations,users} from "./identity.js";
import {financeStatements} from "./finance.js";

/** Future source rows only. Indexed verification preserves the original immutable input. */
export const financeStatementSourceLines=pgTable("finance_statement_source_lines",{
  tenantId:uuid("tenant_id").notNull(),statementId:uuid("statement_id").notNull(),lineKey:text("line_key").notNull(),
  input:jsonb("input").$type<Record<string,unknown>>().notNull(),creationTransactionId:text("creation_transaction_id").notNull(),
},t=>[primaryKey({columns:[t.tenantId,t.statementId,t.lineKey]}),
  foreignKey({columns:[t.tenantId,t.statementId],foreignColumns:[financeStatements.tenantId,financeStatements.id],name:"finance_statement_source_line_parent_fk"})]);

/** Only actual owner INSERT triggers may mint these immutable proofs. Legacy rows stay unclaimed. */
export const financeOriginalWriteProofs=pgTable("finance_original_write_proofs",{
  tenantId:uuid("tenant_id").notNull().references(()=>organizations.id),kind:text("kind").$type<FinanceCommandKind>().notNull(),
  resultId:uuid("result_id").notNull(),commandId:uuid("command_id"),requestKey:text("request_key").notNull(),
  actorId:uuid("actor_id").notNull().references(()=>users.id),targetId:uuid("target_id"),ownerInputChecksum:text("owner_input_checksum").notNull(),
  creationTransactionId:text("creation_transaction_id").notNull(),parentId:uuid("parent_id"),version:integer("version"),
},t=>[primaryKey({columns:[t.tenantId,t.kind,t.resultId]}),uniqueIndex("finance_original_proof_key").on(t.tenantId,t.kind,t.requestKey),
  uniqueIndex("finance_original_proof_command").on(t.tenantId,t.commandId).where(sql`${t.commandId} is not null`)]);

export const financeCommands=pgTable("finance_commands",{
  id:uuid("id").primaryKey(),tenantId:uuid("tenant_id").notNull().references(()=>organizations.id),createdBy:uuid("created_by").notNull().references(()=>users.id),
  kind:text("kind").$type<FinanceCommandKind>().notNull(),targetId:uuid("target_id"),requestKey:text("request_key").notNull(),
  requestChecksum:text("request_checksum").notNull(),ownerInputChecksum:text("owner_input_checksum").notNull(),
  authoritySnapshot:jsonb("authority_snapshot").$type<TenantContext>().notNull(),encryptedInput:text("encrypted_input"),
  contractVersion:text("contract_version").notNull().default("finance-command-v1"),
  status:text("status").$type<FinanceCommandDetail["status"]>().notNull().default("prepared"),resultId:uuid("result_id"),
  errorCode:text("error_code").$type<"input_unavailable">(),
  createdAt:timestamp("created_at",{mode:"date",withTimezone:true}).notNull().defaultNow(),expiresAt:timestamp("expires_at",{mode:"date",withTimezone:true}).notNull(),
  completedAt:timestamp("completed_at",{mode:"date",withTimezone:true}),acknowledgedAt:timestamp("acknowledged_at",{mode:"date",withTimezone:true}),
  redactedAt:timestamp("redacted_at",{mode:"date",withTimezone:true}),
},t=>[uniqueIndex("finance_commands_scope").on(t.tenantId,t.id),uniqueIndex("finance_commands_key").on(t.tenantId,t.kind,t.requestKey),
  uniqueIndex("finance_commands_unacknowledged").on(t.tenantId,t.kind,t.createdBy,sql`coalesce(${t.targetId},'00000000-0000-0000-0000-000000000000'::uuid)`).where(sql`${t.acknowledgedAt} is null`),
  index("finance_commands_retention").on(t.tenantId,t.expiresAt).where(sql`${t.encryptedInput} is not null`),
  foreignKey({columns:[t.tenantId,t.kind,t.resultId],foreignColumns:[financeOriginalWriteProofs.tenantId,financeOriginalWriteProofs.kind,financeOriginalWriteProofs.resultId],name:"finance_command_actual_result_fk"}),
  check("finance_commands_result",sql`(${t.status}='succeeded')=(${t.resultId} is not null) and (${t.status}='prepared')=(${t.completedAt} is null)`),
]);
