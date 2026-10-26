import { sql } from "drizzle-orm";
import { check, foreignKey, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import type { PodInvocationReceipt } from "@yummyai/contracts/harness";
import type { CreativeAdoptionOwnerPin, CreativeOwnerResponseAdoptionReceipt } from "@yummyai/contracts/harness/creative-owner-response-adoption";
import type { CreativeResponseAdoptionCommand } from "@yummyai/contracts/harness/creative-response-adoption";
import { organizations, users } from "./identity.js";
import { creativeExecutions } from "./creative-executions.js";

export interface CreativeOwnerResponseSourcePin {
  version:1;executionId:string;kind:CreativeAdoptionOwnerPin["kind"];ownerId:string;parentId:string|null;
  originalPhase:"failed"|"uncertain";effect:"internal_write"|"external_request";inputFingerprint:string;
  executionChecksum:string;authorityChecksum:string;contractChecksum:string;methodChecksum:string;ownerBasis:CreativeAdoptionOwnerPin;
  responseObjectKey:string;encryptedChecksum:string;responseChecksum:string;responseExpiresAt:string;
  submissionToken:string|null;submittedAt:string|null;receipt:PodInvocationReceipt|null;
}
export interface CreativeOwnerResponseArtifactIntent {
  assetId:string;role:string;fileName:string;objectKey:string;checksumSha256:string;byteSize:number;
  mediaType:string;width:number|null;height:number|null;aiGenerated:boolean;rightsMetadata:Record<string,unknown>;
}
/** A separate local adoption fact. It never resets an original execution or its ledger. */
export const creativeOwnerResponseAdoptions=pgTable("creative_owner_response_adoptions",{
  id:uuid("id").primaryKey(),tenantId:uuid("tenant_id").notNull().references(()=>organizations.id),
  executionId:uuid("execution_id").notNull(),requestedBy:uuid("requested_by").notNull().references(()=>users.id),
  kind:text("kind").$type<CreativeAdoptionOwnerPin["kind"]>().notNull(),ownerId:uuid("owner_id").notNull(),parentId:uuid("parent_id"),
  requestId:uuid("request_id").notNull(),requestChecksum:text("request_checksum").notNull(),expectedBasis:text("expected_basis").notNull(),
  request:jsonb("request").$type<CreativeResponseAdoptionCommand>().notNull(),sourcePin:jsonb("source_pin").$type<CreativeOwnerResponseSourcePin>().notNull(),
  status:text("status").$type<"prepared"|"processing"|"committed"|"cancelled">().default("prepared").notNull(),
  attemptCount:integer("attempt_count").default(0).notNull(),leaseToken:uuid("lease_token"),
  leaseExpiresAt:timestamp("lease_expires_at",{withTimezone:true,mode:"date"}),
  planPin:jsonb("plan_pin").$type<CreativeAdoptionOwnerPin>(),artifactIntents:jsonb("artifact_intents").$type<CreativeOwnerResponseArtifactIntent[]>(),
  artifactDiscardedAt:timestamp("artifact_discarded_at",{withTimezone:true,mode:"date"}),errorCode:text("error_code"),
  ownerReceipt:jsonb("owner_receipt").$type<Record<string,unknown>>(),receipt:jsonb("receipt").$type<CreativeOwnerResponseAdoptionReceipt>(),
  committedAt:timestamp("committed_at",{withTimezone:true,mode:"date"}),cancelledAt:timestamp("cancelled_at",{withTimezone:true,mode:"date"}),
  createdAt:timestamp("created_at",{withTimezone:true,mode:"date"}).defaultNow().notNull(),
  updatedAt:timestamp("updated_at",{withTimezone:true,mode:"date"}).defaultNow().notNull(),
},t=>[
  uniqueIndex("creative_owner_adoptions_tenant_id_unique").on(t.tenantId,t.id),
  uniqueIndex("creative_owner_adoptions_execution_unique").on(t.tenantId,t.executionId),
  uniqueIndex("creative_owner_adoptions_request_unique").on(t.tenantId,t.requestedBy,t.requestId),
  index("creative_owner_adoptions_owner_idx").on(t.tenantId,t.kind,t.ownerId),
  foreignKey({columns:[t.tenantId,t.executionId],foreignColumns:[creativeExecutions.tenantId,creativeExecutions.id],name:"creative_owner_adoptions_execution_fk"}).onDelete("restrict"),
  check("creative_owner_adoptions_kind_check",sql`${t.kind} in ('creative_adaptation','template_compile','mockup_render','studio_generation')`),
  check("creative_owner_adoptions_hash_check",sql`${t.requestChecksum}~'^[a-f0-9]{64}$' and ${t.expectedBasis}~'^[a-f0-9]{64}$'`),
  check("creative_owner_adoptions_status_check",sql`${t.status} in ('prepared','processing','committed','cancelled') and ${t.attemptCount} between 0 and 3`),
  check("creative_owner_adoptions_lease_check",sql`(${t.status}='processing')=(${t.leaseToken} is not null and ${t.leaseExpiresAt} is not null) and (${t.leaseToken} is null)=(${t.leaseExpiresAt} is null)`),
  check("creative_owner_adoptions_terminal_check",sql`(${t.status}='committed')=(${t.receipt} is not null) and (${t.status}='committed')=(${t.ownerReceipt} is not null) and (${t.status}='committed')=(${t.committedAt} is not null) and (${t.status}='cancelled')=(${t.cancelledAt} is not null)`),
]);
