import {sql} from "drizzle-orm";
import {boolean,check,foreignKey,jsonb,pgTable,text,timestamp,uniqueIndex,uuid} from "drizzle-orm/pg-core";
import type {TenantContext} from "@yummyai/contracts";
import type {PublicationSubmitTarget,PublicationStatusTarget,StoreNodeAmazonSubmissionResult,StoreNodeAmazonStatusResult} from "@yummyai/contracts/marketplace/publication-submit";
import {organizations} from "./identity.js";
import {marketplacePublicationRequests,marketplacePublicationEvents} from "./marketplace.js";
import {marketplaceStoreNodeExecutions} from "./store-node-execution.js";

/** Immutable operation intent. Publication remains the owner of platform facts and events. */
export const marketplacePublicationNodeOperations=pgTable("marketplace_publication_node_operations",{
 id:uuid("id").primaryKey(),tenantId:uuid("tenant_id").notNull().references(()=>organizations.id),requestId:uuid("request_id").notNull(),
 kind:text("kind").$type<"submit"|"status">().notNull(),requestKey:uuid("request_key").notNull(),requestChecksum:text("request_checksum").notNull(),
 target:jsonb("target").$type<PublicationSubmitTarget|PublicationStatusTarget>().notNull(),nodeExecutionId:uuid("node_execution_id").notNull(),
 createdBy:uuid("created_by").notNull(),membershipId:uuid("membership_id").notNull(),authorityCeiling:jsonb("authority_ceiling").$type<TenantContext>().notNull(),
 createdAt:timestamp("created_at",{mode:"date",withTimezone:true}).defaultNow().notNull(),
},t=>[
 check("publication_node_operation_kind_check",sql`${t.kind} in ('submit','status')`),
 check("publication_node_operation_digest_check",sql`${t.requestChecksum}~'^[a-f0-9]{64}$'`),
 foreignKey({columns:[t.tenantId,t.requestId],foreignColumns:[marketplacePublicationRequests.tenantId,marketplacePublicationRequests.id],name:"publication_node_operation_request_fk"}),
 foreignKey({columns:[t.tenantId,t.nodeExecutionId],foreignColumns:[marketplaceStoreNodeExecutions.tenantId,marketplaceStoreNodeExecutions.id],name:"publication_node_operation_execution_fk"}),
 uniqueIndex("publication_node_operation_tenant_unique").on(t.tenantId,t.id),uniqueIndex("publication_node_operation_key_unique").on(t.tenantId,t.createdBy,t.requestKey),
 uniqueIndex("publication_node_operation_execution_unique").on(t.tenantId,t.nodeExecutionId),uniqueIndex("publication_node_one_submit").on(t.tenantId,t.requestId).where(sql`${t.kind}='submit'`),
]);

/** One immutable parsed receipt per original operation, atomically linked to any adopted Publication event. */
export const marketplacePublicationNodeResults=pgTable("marketplace_publication_node_results",{
 id:uuid("id").primaryKey(),tenantId:uuid("tenant_id").notNull().references(()=>organizations.id),operationId:uuid("operation_id").notNull(),
 requestId:uuid("request_id").notNull(),eventId:uuid("event_id"),result:jsonb("result").$type<StoreNodeAmazonSubmissionResult|StoreNodeAmazonStatusResult>().notNull(),
 adoptedAsRequestStatus:boolean("adopted_as_request_status").notNull(),createdAt:timestamp("created_at",{mode:"date",withTimezone:true}).defaultNow().notNull(),
},t=>[
 foreignKey({columns:[t.tenantId,t.operationId],foreignColumns:[marketplacePublicationNodeOperations.tenantId,marketplacePublicationNodeOperations.id],name:"publication_node_result_operation_fk"}),
 foreignKey({columns:[t.tenantId,t.requestId],foreignColumns:[marketplacePublicationRequests.tenantId,marketplacePublicationRequests.id],name:"publication_node_result_request_fk"}),
 // Event IDs are globally unique; request ownership is additionally checked by the immutable result guard.
 foreignKey({columns:[t.eventId],foreignColumns:[marketplacePublicationEvents.id],name:"publication_node_result_event_fk"}),
 uniqueIndex("publication_node_result_operation_unique").on(t.tenantId,t.operationId),
]);
