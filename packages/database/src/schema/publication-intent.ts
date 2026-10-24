import {sql} from "drizzle-orm";
import {check,foreignKey,jsonb,pgTable,text,timestamp,uniqueIndex,uuid} from "drizzle-orm/pg-core";
import type {TenantContext} from "@yummyai/contracts";
import type {PublicationPreviewTarget} from "@yummyai/contracts/marketplace/publication-preview";
import type {PublicationSubmitTarget} from "@yummyai/contracts/marketplace/publication-submit";
import {organizations} from "./identity.js";
import {marketplacePublicationRequests} from "./marketplace.js";
import {marketplaceStoreNodeExecutions} from "./store-node-execution.js";

/** Immutable birth authority and execution route. Business facts remain in Publication. */
export const marketplacePublicationIntents=pgTable("marketplace_publication_intents",{
  id:uuid("id").primaryKey(),tenantId:uuid("tenant_id").notNull().references(()=>organizations.id),requestId:uuid("request_id").notNull(),
  createdBy:uuid("created_by").notNull(),membershipId:uuid("membership_id").notNull(),authorityCeiling:jsonb("authority_ceiling").$type<TenantContext>().notNull(),
  authorizationGeneration:uuid("authorization_generation").notNull(),route:text("route").$type<"node_preview"|"node_submit"|"central">().notNull(),
  requestKey:uuid("request_key"),requestChecksum:text("request_checksum"),target:jsonb("target").$type<PublicationPreviewTarget|PublicationSubmitTarget>(),nodeExecutionId:uuid("node_execution_id"),
  createdAt:timestamp("created_at",{mode:"date",withTimezone:true}).defaultNow().notNull(),
},t=>[
  check("publication_intent_digest_check",sql`${t.requestChecksum} is null or ${t.requestChecksum}~'^[a-f0-9]{64}$'`),
  check("publication_intent_route_check",sql`(${t.route}='central' and ${t.requestKey} is null and ${t.requestChecksum} is null and ${t.target} is null and ${t.nodeExecutionId} is null) or (${t.route} in ('node_preview','node_submit') and ${t.requestKey} is not null and ${t.requestChecksum} is not null and ${t.target} is not null and ${t.nodeExecutionId} is not null)`),
  foreignKey({columns:[t.tenantId,t.requestId],foreignColumns:[marketplacePublicationRequests.tenantId,marketplacePublicationRequests.id],name:"publication_intent_request_fk"}),
  foreignKey({columns:[t.tenantId,t.nodeExecutionId],foreignColumns:[marketplaceStoreNodeExecutions.tenantId,marketplaceStoreNodeExecutions.id],name:"publication_intent_execution_fk"}),
  uniqueIndex("publication_intent_request_unique").on(t.tenantId,t.requestId),
  uniqueIndex("publication_intent_actor_key_unique").on(t.tenantId,t.createdBy,t.requestKey),
  uniqueIndex("publication_intent_execution_unique").on(t.tenantId,t.nodeExecutionId),
]);
