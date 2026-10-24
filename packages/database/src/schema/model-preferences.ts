import { sql } from "drizzle-orm";
import { check, integer, jsonb, pgTable, primaryKey, timestamp, uuid } from "drizzle-orm/pg-core";
import type { ModelDefaults } from "@yummyai/contracts/ai/model-configuration";
import { organizations, users } from "./identity.js";

export const modelPreferences = pgTable("model_preferences", {
  tenantId: uuid("tenant_id").notNull().references(() => organizations.id),
  userId: uuid("user_id").notNull().references(() => users.id),
  defaults: jsonb("defaults").$type<ModelDefaults>().notNull(),
  revision: integer("revision").notNull().default(1),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
}, table => [primaryKey({ columns: [table.tenantId, table.userId] }), check("model_preferences_revision_check", sql`${table.revision} > 0`)]);
