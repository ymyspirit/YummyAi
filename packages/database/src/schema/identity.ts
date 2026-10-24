import { sql } from "drizzle-orm";
import {
  check,
  boolean,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const timestamps = {
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
};

export const organizations = pgTable(
  "organizations",
  {
    id: uuid("id").primaryKey(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    ...timestamps,
  },
  (table) => [
    check("organizations_id_uuidv7_check", sql`substring(${table.id}::text from 15 for 1) = '7'`),
    uniqueIndex("organizations_slug_unique").on(table.slug),
  ],
);

export const users = pgTable(
  "app_users",
  {
    id: uuid("id").primaryKey(),
    oidcSubject: text("oidc_subject").notNull(),
    email: text("email").notNull(),
    displayName: text("display_name").notNull(),
    ...timestamps,
  },
  (table) => [
    check("app_users_id_uuidv7_check", sql`substring(${table.id}::text from 15 for 1) = '7'`),
    uniqueIndex("app_users_oidc_subject_unique").on(table.oidcSubject),
    uniqueIndex("app_users_email_unique").on(table.email),
  ],
);

export const memberships = pgTable(
  "memberships",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    status: text("status").default("active").notNull(),
    ...timestamps,
  },
  (table) => [
    check("memberships_id_uuidv7_check", sql`substring(${table.id}::text from 15 for 1) = '7'`),
    check("memberships_status_check", sql`${table.status} in ('invited', 'active', 'disabled')`),
    uniqueIndex("memberships_tenant_user_unique").on(table.tenantId, table.userId),
    uniqueIndex("memberships_tenant_id_unique").on(table.tenantId, table.id),
    index("memberships_user_id_idx").on(table.userId),
  ],
);

export const roles = pgTable(
  "roles",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    permissions: jsonb("permissions")
      .$type<readonly string[]>()
      .default(sql`'[]'::jsonb`)
      .notNull(),
    dataScope: text("data_scope").default("self").notNull(),
    ...timestamps,
  },
  (table) => [
    check("roles_id_uuidv7_check", sql`substring(${table.id}::text from 15 for 1) = '7'`),
    check("roles_data_scope_check", sql`${table.dataScope} in ('self', 'team', 'tenant')`),
    uniqueIndex("roles_tenant_name_unique").on(table.tenantId, table.name),
    uniqueIndex("roles_tenant_id_unique").on(table.tenantId, table.id),
  ],
);

export const membershipRoles = pgTable(
  "membership_roles",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    membershipId: uuid("membership_id").notNull(),
    roleId: uuid("role_id").notNull(),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.membershipId, table.roleId], name: "membership_roles_pk" }),
    foreignKey({
      columns: [table.tenantId, table.membershipId],
      foreignColumns: [memberships.tenantId, memberships.id],
      name: "membership_roles_membership_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.tenantId, table.roleId],
      foreignColumns: [roles.tenantId, roles.id],
      name: "membership_roles_role_fk",
    }).onDelete("cascade"),
    index("membership_roles_tenant_id_idx").on(table.tenantId),
    index("membership_roles_role_id_idx").on(table.roleId),
  ],
);

export const organizationTeams = pgTable(
  "organization_teams",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => organizations.id),
    name: text("name").notNull(),
    status: text("status").notNull().default("active"),
    revision: integer("revision").notNull().default(1),
    accessGeneration: integer("access_generation").notNull().default(1),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("organization_teams_tenant_id_unique").on(t.tenantId, t.id),
    uniqueIndex("organization_teams_name_unique").on(t.tenantId, sql`lower(${t.name})`),
    check("organization_teams_id_check", sql`substring(${t.id}::text from 15 for 1)='7'`),
    check("organization_teams_name_check", sql`length(btrim(${t.name})) between 1 and 120`),
    check("organization_teams_status_check", sql`${t.status} in ('active','archived')`),
    check("organization_teams_revision_check", sql`${t.revision}>0`),
    check("organization_teams_access_generation_check", sql`${t.accessGeneration}>0`),
  ],
);

export const organizationTeamMembers = pgTable(
  "organization_team_members",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => organizations.id),
    teamId: uuid("team_id").notNull(),
    membershipId: uuid("membership_id").notNull(),
    active: boolean("active").notNull().default(true),
    revision: integer("revision").notNull().default(1),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("organization_team_members_tenant_id_unique").on(t.tenantId, t.id),
    uniqueIndex("organization_team_members_team_member_unique").on(
      t.tenantId,
      t.teamId,
      t.membershipId,
    ),
    foreignKey({
      columns: [t.tenantId, t.teamId],
      foreignColumns: [organizationTeams.tenantId, organizationTeams.id],
      name: "organization_team_members_team_fk",
    }),
    foreignKey({
      columns: [t.tenantId, t.membershipId],
      foreignColumns: [memberships.tenantId, memberships.id],
      name: "organization_team_members_membership_fk",
    }),
    check("organization_team_members_id_check", sql`substring(${t.id}::text from 15 for 1)='7'`),
    check("organization_team_members_revision_check", sql`${t.revision}>0`),
  ],
);

export const organizationTeamCommands = pgTable(
  "organization_team_commands",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => organizations.id),
    actorId: uuid("actor_id")
      .notNull()
      .references(() => users.id),
    requestId: uuid("request_id").notNull(),
    requestHash: text("request_hash").notNull(),
    result: jsonb("result").$type<{ id: string; revision: number }>().notNull(),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("organization_team_commands_request_unique").on(t.tenantId, t.requestId),
    check("organization_team_commands_id_check", sql`substring(${t.id}::text from 15 for 1)='7'`),
    check("organization_team_commands_hash_check", sql`${t.requestHash} ~ '^[a-f0-9]{64}$'`),
  ],
);
