import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { createHash } from "node:crypto";
import { authorize, ForbiddenError, Permission, permissionScope } from "@yummyai/authz";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import {
  CreateTeamSchema,
  UpdateTeamSchema,
  SetTeamMemberSchema,
  TeamQuerySchema,
  TeamWorkspaceSchema,
} from "@yummyai/contracts/identity/teams";
import {
  organizationTeams,
  organizationTeamMembers,
  organizationTeamCommands,
  memberships,
  users,
  loadCurrentMembershipContext,
  recordAuditInTransaction,
  withTenant,
  type DatabaseConnection,
  type TenantTransaction,
} from "@yummyai/database";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { DATABASE_CONNECTION } from "../platform.tokens.js";

function requireManager(context: TenantContext) {
  authorize(context, Permission.MembershipManage);
  if (permissionScope(context, Permission.MembershipManage) !== "tenant")
    throw new ForbiddenError(Permission.MembershipManage, "outside_data_scope");
}
const like = (q: string) => "%" + q.replace(/[\\%_]/g, "\\$&") + "%";

@Injectable()
export class TeamDirectoryService {
  constructor(@Inject(DATABASE_CONNECTION) private readonly database: DatabaseConnection) {}

  async workspace(context: TenantContext, body: unknown) {
    requireManager(context);
    const query = TeamQuerySchema.parse(body);
    return withTenant(
      this.database.db,
      context,
      async (tx) => {
        requireManager(await loadCurrentMembershipContext(tx, context));
        const filter = query.q ? sql`${organizationTeams.name} ilike ${like(query.q)}` : undefined;
        const [count] = await tx
          .select({ total: sql<number>`count(*)::int` })
          .from(organizationTeams)
          .where(filter);
        const teams = await tx
          .select()
          .from(organizationTeams)
          .where(filter)
          .orderBy(asc(organizationTeams.name), asc(organizationTeams.id))
          .limit(query.pageSize)
          .offset((query.page - 1) * query.pageSize);
        const relations = teams.length
          ? await tx
              .select({
                teamId: organizationTeamMembers.teamId,
                membershipId: memberships.id,
                displayName: users.displayName,
                active: organizationTeamMembers.active,
                revision: organizationTeamMembers.revision,
              })
              .from(organizationTeamMembers)
              .innerJoin(memberships, eq(memberships.id, organizationTeamMembers.membershipId))
              .innerJoin(users, eq(users.id, memberships.userId))
              .where(
                inArray(
                  organizationTeamMembers.teamId,
                  teams.map((t) => t.id),
                ),
              )
              .orderBy(asc(users.displayName), asc(memberships.id))
          : [];
        const candidates = await tx
          .select({ id: memberships.id, displayName: users.displayName })
          .from(memberships)
          .innerJoin(users, eq(users.id, memberships.userId))
          .where(
            and(
              eq(memberships.status, "active"),
              query.memberQ ? sql`${users.displayName} ilike ${like(query.memberQ)}` : undefined,
            ),
          )
          .orderBy(asc(users.displayName), asc(memberships.id))
          .limit(201);
        return TeamWorkspaceSchema.parse({
          teams: teams.map((t) => ({
            id: t.id,
            name: t.name,
            status: t.status,
            revision: t.revision,
            members: relations
              .filter((r) => r.teamId === t.id)
              .map(({ teamId, ...member }) => {
                void teamId;
                return member;
              }),
          })),
          members: candidates.slice(0, 200),
          membersTruncated: candidates.length > 200,
          total: count?.total ?? 0,
          page: query.page,
          pageSize: query.pageSize,
        });
      },
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );
  }

  async options(context: TenantContext) {
    const allowed = new Set<string>([
      Permission.ProductRead,
      Permission.ProductWrite,
      Permission.MembershipManage,
    ]);
    if (!context.permissions.some((p) => allowed.has(p)))
      throw new ForbiddenError(Permission.ProductRead);
    return withTenant(this.database.db, context, async (tx) => {
      const current = await loadCurrentMembershipContext(tx, context);
      if (!current.permissions.some((p) => allowed.has(p)))
        throw new ForbiddenError(Permission.ProductRead);
      const canChooseAll =
        current.permissions.includes(Permission.ProductWrite) &&
        permissionScope(current, Permission.ProductWrite) === "tenant";
      const ids = current.teamIds ?? [];
      if (!canChooseAll && !ids.length) return [];
      return tx
        .select({ id: organizationTeams.id, name: organizationTeams.name })
        .from(organizationTeams)
        .where(
          and(
            eq(organizationTeams.status, "active"),
            canChooseAll ? undefined : inArray(organizationTeams.id, ids),
          ),
        )
        .orderBy(asc(organizationTeams.name), asc(organizationTeams.id));
    });
  }

  async create(context: TenantContext, body: unknown) {
    requireManager(context);
    const input = CreateTeamSchema.parse(body);
    return this.command(context, "team.create", input, async (tx, current) => {
      const id = createEntityId();
      await tx
        .insert(organizationTeams)
        .values({ id, tenantId: current.tenantId, name: input.name, createdBy: current.userId });
      return { id, revision: 1 };
    });
  }
  async update(context: TenantContext, id: string, body: unknown) {
    requireManager(context);
    const input = UpdateTeamSchema.parse(body);
    return this.command(context, "team.update", { id, ...input }, async (tx) => {
      const [team] = await tx
        .select()
        .from(organizationTeams)
        .where(eq(organizationTeams.id, id))
        .for("update");
      if (!team) throw new NotFoundException("团队不存在");
      if (team.revision !== input.expectedRevision)
        throw new ConflictException("团队已变化 请刷新后重试");
      if (team.name === input.name && team.status === input.status)
        return { id, revision: team.revision };
      const revision = team.revision + 1;
      await tx
        .update(organizationTeams)
        .set({
          name: input.name,
          status: input.status,
          revision,
          accessGeneration: team.accessGeneration + (team.status !== input.status ? 1 : 0),
          updatedAt: new Date(),
        })
        .where(eq(organizationTeams.id, id));
      return { id, revision };
    });
  }
  async setMember(context: TenantContext, teamId: string, body: unknown) {
    requireManager(context);
    const input = SetTeamMemberSchema.parse(body);
    return this.command(context, "team.member", { teamId, ...input }, async (tx, current) => {
      const [team] = await tx
        .select()
        .from(organizationTeams)
        .where(eq(organizationTeams.id, teamId))
        .for("update");
      const [member] = await tx
        .select()
        .from(memberships)
        .where(eq(memberships.id, input.membershipId))
        .for("share");
      if (!team || !member) throw new NotFoundException("团队或成员不存在");
      if (input.active && (team.status !== "active" || member.status !== "active"))
        throw new ConflictException("只能将有效成员加入启用的团队");
      const [prior] = await tx
        .select()
        .from(organizationTeamMembers)
        .where(
          and(
            eq(organizationTeamMembers.teamId, teamId),
            eq(organizationTeamMembers.membershipId, input.membershipId),
          ),
        )
        .for("update");
      if ((prior?.revision ?? null) !== input.expectedRevision)
        throw new ConflictException("成员归属已变化 请刷新后重试");
      if (prior && prior.active === input.active) return { id: prior.id, revision: prior.revision };
      if (input.active && !prior?.active) {
        const [count] = await tx
          .select({ total: sql<number>`count(*)::int` })
          .from(organizationTeamMembers)
          .where(
            and(
              eq(organizationTeamMembers.membershipId, member.id),
              eq(organizationTeamMembers.active, true),
            ),
          );
        if ((count?.total ?? 0) >= 200)
          throw new ConflictException("该成员已达到团队数量上限 请先整理现有归属");
      }
      const id = prior?.id ?? createEntityId(),
        revision = (prior?.revision ?? 0) + 1;
      if (prior)
        await tx
          .update(organizationTeamMembers)
          .set({ active: input.active, revision, updatedAt: new Date() })
          .where(eq(organizationTeamMembers.id, id));
      else
        await tx.insert(organizationTeamMembers).values({
          id,
          tenantId: current.tenantId,
          teamId,
          membershipId: member.id,
          active: input.active,
          revision,
          createdBy: current.userId,
        });
      return { id, revision };
    });
  }
  private async command<I extends { requestId: string; reason: string }>(
    context: TenantContext,
    action: string,
    input: I,
    operation: (
      tx: TenantTransaction,
      current: TenantContext,
    ) => Promise<{ id: string; revision: number }>,
  ) {
    try {
      return await withTenant(this.database.db, context, async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${context.tenantId + ":team-directory"},0))`,
        );
        const current = await loadCurrentMembershipContext(tx, context, { lock: true });
        requireManager(current);
        const digest = createHash("sha256").update(JSON.stringify({ action, input })).digest("hex");
        const [prior] = await tx
          .select()
          .from(organizationTeamCommands)
          .where(eq(organizationTeamCommands.requestId, input.requestId));
        if (prior) {
          if (prior.actorId !== current.userId || prior.requestHash !== digest)
            throw new ConflictException("请求编号已用于其他操作");
          return { ...prior.result, replayed: true };
        }
        const result = await operation(tx, current);
        await tx.insert(organizationTeamCommands).values({
          id: createEntityId(),
          tenantId: current.tenantId,
          actorId: current.userId,
          requestId: input.requestId,
          requestHash: digest,
          result,
        });
        await recordAuditInTransaction(tx, current, {
          action,
          resourceType: "organization_team",
          resourceId: result.id,
          result: "success",
          metadata: { requestId: input.requestId, revision: result.revision, reason: input.reason },
        });
        return { ...result, replayed: false };
      });
    } catch (error) {
      const code =
        (error as { code?: string; cause?: { code?: string } })?.code ??
        (error as { cause?: { code?: string } })?.cause?.code;
      if (code === "23505") throw new ConflictException("团队名称已存在");
      if (code === "40P01") throw new ConflictException("归属正在变化 请刷新后重试");
      throw error;
    }
  }
}
