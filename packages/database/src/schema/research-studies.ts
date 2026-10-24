import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  integer,
  jsonb,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { ResearchStudyContent } from "@yummyai/contracts/research/creative";
import { organizations, users } from "./identity.js";
import { captureSnapshots, researchItems } from "./capture.js";

export const researchStudyRevisions = pgTable(
  "research_study_revisions",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => organizations.id),
    researchItemId: uuid("research_item_id").notNull(),
    snapshotId: uuid("snapshot_id").notNull(),
    version: integer("version").notNull(),
    content: jsonb("content").$type<ResearchStudyContent>().notNull(),
    requestId: uuid("request_id").notNull(),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
  },
  (table) => [
    check(
      "research_study_revision_valid",
      sql`${table.version} > 0 and substring(${table.id}::text from 15 for 1) = '7'`,
    ),
    uniqueIndex("research_study_item_version_unique").on(
      table.tenantId,
      table.researchItemId,
      table.version,
    ),
    uniqueIndex("research_study_request_unique").on(table.tenantId, table.requestId),
    foreignKey({
      name: "research_study_item_fk",
      columns: [table.tenantId, table.researchItemId],
      foreignColumns: [researchItems.tenantId, researchItems.id],
    }),
    foreignKey({
      name: "research_study_snapshot_fk",
      columns: [table.tenantId, table.snapshotId],
      foreignColumns: [captureSnapshots.tenantId, captureSnapshots.id],
    }),
  ],
);
