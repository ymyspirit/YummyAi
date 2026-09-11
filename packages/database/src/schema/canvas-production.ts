import { foreignKey, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { organizations, users } from "./identity.js";
import { creativeDesignBatches, creativeDesignVersions } from "./pod-batches.js";
import { productionEditorProjects, productionEditorVersions } from "./production-editor.js";

/** Immutable lineage for a reviewed master copied into an independent production draft. */
export const canvasProductionHandoffs = pgTable("canvas_production_handoffs", {
  id: uuid("id").primaryKey(), tenantId: uuid("tenant_id").notNull().references(() => organizations.id),
  batchId: uuid("batch_id").notNull(), creativeVersionId: uuid("creative_version_id").notNull(),
  templateProjectId: uuid("template_project_id").notNull(), templateVersionId: uuid("template_version_id").notNull(),
  projectId: uuid("project_id").notNull(), templateName: text("template_name").notNull(),
  createdBy: uuid("created_by").notNull().references(() => users.id),
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("canvas_production_handoffs_version_template_unique").on(table.tenantId, table.creativeVersionId, table.templateVersionId),
  foreignKey({ columns: [table.tenantId, table.batchId], foreignColumns: [creativeDesignBatches.tenantId, creativeDesignBatches.id], name: "canvas_production_handoffs_batch_fk" }),
  foreignKey({ columns: [table.tenantId, table.creativeVersionId], foreignColumns: [creativeDesignVersions.tenantId, creativeDesignVersions.id], name: "canvas_production_handoffs_creative_fk" }),
  foreignKey({ columns: [table.tenantId, table.templateProjectId, table.templateVersionId], foreignColumns: [productionEditorVersions.tenantId, productionEditorVersions.projectId, productionEditorVersions.id], name: "canvas_production_handoffs_template_fk" }),
  foreignKey({ columns: [table.tenantId, table.projectId], foreignColumns: [productionEditorProjects.tenantId, productionEditorProjects.id], name: "canvas_production_handoffs_project_fk" }),
]);
