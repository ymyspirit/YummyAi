import { sql } from "drizzle-orm";
import { check, foreignKey, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import type { PodInvocationReceipt } from "@yummyai/contracts/harness";
import type { CreativeResponseAdoptionCommand, CreativeResponseAdoptionReceipt } from "@yummyai/contracts/harness/creative-response-adoption";
import { organizations, users } from "./identity.js";
import { creativeExecutions } from "./creative-executions.js";
import { creativeDesignCandidates } from "./pod-batches.js";

/** Hashes pin private inputs without copying prompts into recovery metadata. */
export interface CreativeResponseAdoptionSourcePin {
  version: 1; executionId: string; candidateId: string; batchId: string; itemId: string;
  originalPhase: "failed" | "uncertain"; inputFingerprint: string; authorityChecksum: string;
  contractChecksum: string; methodChecksum: string; sourceChecksum: string; candidateChecksum: string;
  responseObjectKey: string; encryptedChecksum: string; responseChecksum: string; responseExpiresAt: string;
  submissionToken: string; submittedAt: string; receipt: PodInvocationReceipt;
}

/** Exact adoption-owned object, recorded before the first upload and never replaced. */
export interface CreativeResponseAdoptionArtifactIntent {
  assetId: string; objectKey: string; fileName: string; checksumSha256: string; byteSize: number;
  mediaType: "image/png" | "image/jpeg" | "image/webp" | "image/tiff"; width: number; height: number;
  modelKey: string; modelVersion: string; seed: string | null;
  qualityCheckSnapshot: Record<string, unknown>; outputMetadata: Record<string, unknown>;
}

export const creativeResponseAdoptions = pgTable("creative_response_adoptions", {
  id: uuid("id").primaryKey(), tenantId: uuid("tenant_id").notNull().references(() => organizations.id),
  executionId: uuid("execution_id").notNull(), candidateId: uuid("candidate_id").notNull(),
  requestedBy: uuid("requested_by").notNull().references(() => users.id), requestId: uuid("request_id").notNull(),
  requestChecksum: text("request_checksum").notNull(), expectedBasis: text("expected_basis").notNull(),
  request: jsonb("request").$type<CreativeResponseAdoptionCommand>().notNull(),
  sourcePin: jsonb("source_pin").$type<CreativeResponseAdoptionSourcePin>().notNull(),
  status: text("status").$type<"prepared" | "processing" | "committed" | "cancelled">().notNull().default("prepared"),
  attemptCount: integer("attempt_count").notNull().default(0),
  leaseToken: uuid("lease_token"), leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true, mode: "date" }),
  artifactIntent: jsonb("artifact_intent").$type<CreativeResponseAdoptionArtifactIntent>(),
  artifactDiscardedAt: timestamp("artifact_discarded_at", { withTimezone: true, mode: "date" }),
  errorCode: text("error_code"), receipt: jsonb("receipt").$type<CreativeResponseAdoptionReceipt>(),
  committedAt: timestamp("committed_at", { withTimezone: true, mode: "date" }),
  cancelledAt: timestamp("cancelled_at", { withTimezone: true, mode: "date" }),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
}, t => [
  uniqueIndex("creative_response_adoptions_tenant_id_unique").on(t.tenantId, t.id),
  uniqueIndex("creative_response_adoptions_execution_unique").on(t.tenantId, t.executionId),
  uniqueIndex("creative_response_adoptions_request_unique").on(t.tenantId, t.requestedBy, t.requestId),
  index("creative_response_adoptions_owner_idx").on(t.tenantId, t.requestedBy, t.createdAt),
  foreignKey({ columns: [t.tenantId, t.executionId], foreignColumns: [creativeExecutions.tenantId, creativeExecutions.id], name: "creative_response_adoption_execution_fk" }).onDelete("restrict"),
  foreignKey({ columns: [t.tenantId, t.candidateId], foreignColumns: [creativeDesignCandidates.tenantId, creativeDesignCandidates.id], name: "creative_response_adoption_candidate_fk" }).onDelete("restrict"),
  check("creative_response_adoption_id_check", sql`substring(${t.id}::text from 15 for 1)='7'`),
  check("creative_response_adoption_hash_check", sql`${t.requestChecksum}~'^[a-f0-9]{64}$' AND ${t.expectedBasis}~'^[a-f0-9]{64}$'`),
  check("creative_response_adoption_status_check", sql`${t.status} IN ('prepared','processing','committed','cancelled') AND ${t.attemptCount} BETWEEN 0 AND 3`),
  check("creative_response_adoption_lease_check", sql`(${t.status}='processing')=(${t.leaseToken} IS NOT NULL AND ${t.leaseExpiresAt} IS NOT NULL) AND (${t.leaseToken} IS NULL)=(${t.leaseExpiresAt} IS NULL)`),
  check("creative_response_adoption_terminal_check", sql`(${t.status}='committed')=(${t.receipt} IS NOT NULL AND ${t.committedAt} IS NOT NULL) AND (${t.status}='cancelled')=(${t.cancelledAt} IS NOT NULL)`),
]);
