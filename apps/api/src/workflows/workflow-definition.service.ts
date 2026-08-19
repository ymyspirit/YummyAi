import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  CloneWorkflowDefinitionInputSchema,
  CreateWorkflowDefinitionInputSchema,
  UpdateWorkflowDraftInputSchema,
  WorkflowDefinitionDetailSchema,
  WorkflowDefinitionListSchema,
  WorkflowDefinitionVersionViewSchema,
  WorkflowGraphSchema,
  createEntityId,
  type CloneWorkflowDefinitionInput,
  type CreateWorkflowDefinitionInput,
  type TenantContext,
  type UpdateWorkflowDraftInput,
  type WorkflowGraph,
} from "@yummyai/contracts";
import {
  workflowDefinitions,
  workflowDefinitionVersions,
  workflowRuns,
  type DatabaseConnection,
  withTenant,
} from "@yummyai/database";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { createHash } from "node:crypto";

import { DATABASE_CONNECTION } from "../platform.tokens.js";
import {
  AMAZON_CUSTOM_OFFICIAL_GRAPH,
  AMAZON_CUSTOM_WORKFLOW_NAME,
  AMAZON_CUSTOM_WORKFLOW_STABLE_KEY,
} from "./amazon-custom-workflow.blueprint.js";
import { WorkflowCapabilityRegistry } from "./workflow-capability.registry.js";
import { validateWorkflowGraph } from "./workflow-graph.validator.js";

@Injectable()
export class WorkflowDefinitionService {
  constructor(
    @Inject(DATABASE_CONNECTION) private readonly database: DatabaseConnection,
    @Inject(WorkflowCapabilityRegistry) private readonly capabilities: WorkflowCapabilityRegistry,
  ) {}

  async ensureOfficial(context: TenantContext) {
    return withTenant(this.database.db, context, async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`workflow-official:${context.tenantId}:${AMAZON_CUSTOM_WORKFLOW_STABLE_KEY}`}, 0))`,
      );
      const [existing] = await tx
        .select()
        .from(workflowDefinitions)
        .where(eq(workflowDefinitions.stableKey, AMAZON_CUSTOM_WORKFLOW_STABLE_KEY))
        .limit(1);
      if (existing) {
        const targetChecksum = graphChecksum(AMAZON_CUSTOM_OFFICIAL_GRAPH);
        const [published] = existing.currentPublishedVersionId
          ? await tx
              .select()
              .from(workflowDefinitionVersions)
              .where(eq(workflowDefinitionVersions.id, existing.currentPublishedVersionId))
              .limit(1)
          : [undefined];
        if (published?.checksum === targetChecksum) return existing;
        const validation = validateWorkflowGraph(
          AMAZON_CUSTOM_OFFICIAL_GRAPH,
          this.capabilities.validationRegistry(),
        );
        if (!validation.valid)
          throw new Error("The official Amazon Custom workflow graph is invalid");
        const [latest] = await tx
          .select({ version: workflowDefinitionVersions.version })
          .from(workflowDefinitionVersions)
          .where(eq(workflowDefinitionVersions.definitionId, existing.id))
          .orderBy(desc(workflowDefinitionVersions.version))
          .limit(1);
        const versionId = createEntityId();
        await tx.insert(workflowDefinitionVersions).values({
          id: versionId,
          tenantId: context.tenantId,
          definitionId: existing.id,
          version: (latest?.version ?? 0) + 1,
          status: "published",
          graph: AMAZON_CUSTOM_OFFICIAL_GRAPH,
          validation,
          checksum: targetChecksum,
          createdBy: context.userId,
          publishedBy: context.userId,
          publishedAt: new Date(),
        });
        const [updated] = await tx
          .update(workflowDefinitions)
          .set({
            name: AMAZON_CUSTOM_WORKFLOW_NAME,
            description:
              "从竞品研究、自有事实和设计校样推进到完整 Amazon Custom 上架资料包的官方流程。",
            currentPublishedVersionId: versionId,
            revision: existing.revision + 1,
            updatedAt: new Date(),
          })
          .where(eq(workflowDefinitions.id, existing.id))
          .returning();
        return updated ?? existing;
      }
      const definitionId = createEntityId();
      const versionId = createEntityId();
      const validation = validateWorkflowGraph(
        AMAZON_CUSTOM_OFFICIAL_GRAPH,
        this.capabilities.validationRegistry(),
      );
      if (!validation.valid)
        throw new Error("The official Amazon Custom workflow graph is invalid");
      await tx
        .insert(workflowDefinitions)
        .values({
          id: definitionId,
          tenantId: context.tenantId,
          stableKey: AMAZON_CUSTOM_WORKFLOW_STABLE_KEY,
          name: AMAZON_CUSTOM_WORKFLOW_NAME,
          description:
            "从竞品研究、自有事实和设计校样推进到完整 Amazon Custom 上架资料包的官方流程。",
          category: "Amazon Custom",
          scope: "official",
          status: "published",
          revision: 1,
          createdBy: context.userId,
        })
        .onConflictDoNothing();
      const [created] = await tx
        .select()
        .from(workflowDefinitions)
        .where(eq(workflowDefinitions.stableKey, AMAZON_CUSTOM_WORKFLOW_STABLE_KEY))
        .limit(1);
      if (!created) throw new Error("Unable to create official workflow definition");
      if (created.id === definitionId) {
        await tx.insert(workflowDefinitionVersions).values({
          id: versionId,
          tenantId: context.tenantId,
          definitionId,
          version: 1,
          status: "published",
          graph: AMAZON_CUSTOM_OFFICIAL_GRAPH,
          validation,
          checksum: graphChecksum(AMAZON_CUSTOM_OFFICIAL_GRAPH),
          createdBy: context.userId,
          publishedBy: context.userId,
          publishedAt: new Date(),
        });
        await tx
          .update(workflowDefinitions)
          .set({ currentPublishedVersionId: versionId })
          .where(eq(workflowDefinitions.id, definitionId));
      }
      return created;
    });
  }

  async list(context: TenantContext) {
    await this.ensureOfficial(context);
    return withTenant(this.database.db, context, async (tx) => {
      const definitions = await tx
        .select()
        .from(workflowDefinitions)
        .orderBy(desc(workflowDefinitions.updatedAt));
      const versionIds = definitions.flatMap((row) =>
        [row.currentDraftVersionId, row.currentPublishedVersionId].filter((id): id is string =>
          Boolean(id),
        ),
      );
      const versions = versionIds.length
        ? await tx
            .select()
            .from(workflowDefinitionVersions)
            .where(inArray(workflowDefinitionVersions.id, versionIds))
        : [];
      const activeRuns = await tx
        .select({ definitionId: workflowRuns.definitionId })
        .from(workflowRuns)
        .where(inArray(workflowRuns.status, ["not_started", "active", "blocked", "failed"]));
      const activeRunCounts = countBy(activeRuns.map((run) => run.definitionId));
      const versionById = new Map(versions.map((version) => [version.id, version]));
      return WorkflowDefinitionListSchema.parse({
        items: definitions.map((definition) =>
          definitionSummary(
            definition,
            definition.currentDraftVersionId
              ? versionById.get(definition.currentDraftVersionId)
              : undefined,
            definition.currentPublishedVersionId
              ? versionById.get(definition.currentPublishedVersionId)
              : undefined,
            activeRunCounts.get(definition.id) ?? 0,
          ),
        ),
      });
    });
  }

  async get(context: TenantContext, id: string) {
    await this.ensureOfficial(context);
    return withTenant(this.database.db, context, async (tx) => {
      const [definition] = await tx
        .select()
        .from(workflowDefinitions)
        .where(eq(workflowDefinitions.id, id))
        .limit(1);
      if (!definition) throw new NotFoundException("Workflow definition not found");
      const versions = await tx
        .select()
        .from(workflowDefinitionVersions)
        .where(eq(workflowDefinitionVersions.definitionId, id));
      const draft = versions.find((version) => version.id === definition.currentDraftVersionId);
      const published = versions.find(
        (version) => version.id === definition.currentPublishedVersionId,
      );
      const activeRuns = await tx
        .select({ id: workflowRuns.id })
        .from(workflowRuns)
        .where(
          and(
            eq(workflowRuns.definitionId, id),
            inArray(workflowRuns.status, ["not_started", "active", "blocked", "failed"]),
          ),
        );
      return WorkflowDefinitionDetailSchema.parse({
        ...definitionSummary(definition, draft, published, activeRuns.length),
        ...(draft ? { draft: versionView(draft) } : {}),
        ...(published ? { published: versionView(published) } : {}),
      });
    });
  }

  async create(context: TenantContext, rawInput: CreateWorkflowDefinitionInput) {
    const input = CreateWorkflowDefinitionInputSchema.parse(rawInput);
    const graph = WorkflowGraphSchema.parse(input.graph);
    const validation = validateWorkflowGraph(graph, this.capabilities.validationRegistry());
    const definitionId = createEntityId();
    const versionId = createEntityId();
    await withTenant(this.database.db, context, async (tx) => {
      await tx.insert(workflowDefinitions).values({
        id: definitionId,
        tenantId: context.tenantId,
        stableKey: `custom.${definitionId}`,
        name: input.name,
        description: input.description,
        category: input.category,
        scope: input.scope,
        status: "draft",
        revision: 1,
        createdBy: context.userId,
      });
      await tx.insert(workflowDefinitionVersions).values({
        id: versionId,
        tenantId: context.tenantId,
        definitionId,
        version: 1,
        status: "draft",
        graph,
        validation,
        checksum: graphChecksum(graph),
        createdBy: context.userId,
      });
      await tx
        .update(workflowDefinitions)
        .set({ currentDraftVersionId: versionId })
        .where(eq(workflowDefinitions.id, definitionId));
    });
    return this.get(context, definitionId);
  }

  async updateDraft(context: TenantContext, id: string, rawInput: UpdateWorkflowDraftInput) {
    const input = UpdateWorkflowDraftInputSchema.parse(rawInput);
    await withTenant(this.database.db, context, async (tx) => {
      const [definition] = await tx
        .select()
        .from(workflowDefinitions)
        .where(eq(workflowDefinitions.id, id))
        .limit(1);
      if (!definition) throw new NotFoundException("Workflow definition not found");
      if (definition.scope === "official") {
        throw new ForbiddenException("Official workflows must be cloned before editing");
      }
      if (definition.revision !== input.expectedRevision) {
        throw new ConflictException("Workflow draft changed; refresh before saving again");
      }
      const [current] = definition.currentDraftVersionId
        ? await tx
            .select()
            .from(workflowDefinitionVersions)
            .where(eq(workflowDefinitionVersions.id, definition.currentDraftVersionId))
            .limit(1)
        : [undefined];
      const [latest] = await tx
        .select()
        .from(workflowDefinitionVersions)
        .where(eq(workflowDefinitionVersions.definitionId, id))
        .orderBy(desc(workflowDefinitionVersions.version))
        .limit(1);
      const graph = input.graph ?? current?.graph;
      if (!graph) throw new BadRequestException("Workflow graph is required");
      const parsedGraph = WorkflowGraphSchema.parse(graph);
      const validation = validateWorkflowGraph(parsedGraph, this.capabilities.validationRegistry());
      const versionId = createEntityId();
      await tx.insert(workflowDefinitionVersions).values({
        id: versionId,
        tenantId: context.tenantId,
        definitionId: id,
        version: (latest?.version ?? 0) + 1,
        status: "draft",
        graph: parsedGraph,
        validation,
        checksum: graphChecksum(parsedGraph),
        createdBy: context.userId,
      });
      const updated = await tx
        .update(workflowDefinitions)
        .set({
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.category !== undefined ? { category: input.category } : {}),
          status: definition.currentPublishedVersionId ? definition.status : "draft",
          currentDraftVersionId: versionId,
          revision: definition.revision + 1,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(workflowDefinitions.id, id),
            eq(workflowDefinitions.revision, input.expectedRevision),
          ),
        )
        .returning({ id: workflowDefinitions.id });
      if (!updated.length) throw new ConflictException("Workflow draft changed while saving");
    });
    return this.get(context, id);
  }

  async clone(context: TenantContext, id: string, rawInput: CloneWorkflowDefinitionInput) {
    const input = CloneWorkflowDefinitionInputSchema.parse(rawInput);
    const source = await this.get(context, id);
    const sourceVersion = source.published ?? source.draft;
    if (!sourceVersion) throw new BadRequestException("Source workflow has no version to clone");
    return this.create(context, {
      name: input.name ?? `${source.name}（团队副本）`,
      description: source.description,
      category: source.category,
      scope: input.scope,
      graph: sourceVersion.graph,
    });
  }

  async publish(context: TenantContext, id: string, expectedRevision: number) {
    await withTenant(this.database.db, context, async (tx) => {
      const [definition] = await tx
        .select()
        .from(workflowDefinitions)
        .where(eq(workflowDefinitions.id, id))
        .limit(1);
      if (!definition) throw new NotFoundException("Workflow definition not found");
      if (definition.scope === "official")
        throw new ForbiddenException("Official workflows are managed by YummyAI");
      if (definition.revision !== expectedRevision)
        throw new ConflictException("Workflow draft changed; refresh before publishing");
      if (!definition.currentDraftVersionId)
        throw new BadRequestException("Workflow has no draft version");
      const [draft] = await tx
        .select()
        .from(workflowDefinitionVersions)
        .where(eq(workflowDefinitionVersions.id, definition.currentDraftVersionId))
        .limit(1);
      if (!draft) throw new BadRequestException("Workflow draft version is missing");
      const validation = validateWorkflowGraph(draft.graph, this.capabilities.validationRegistry());
      if (!validation.valid) {
        throw new BadRequestException({
          message: "Workflow validation failed",
          issues: validation.issues,
        });
      }
      const [latest] = await tx
        .select()
        .from(workflowDefinitionVersions)
        .where(eq(workflowDefinitionVersions.definitionId, id))
        .orderBy(desc(workflowDefinitionVersions.version))
        .limit(1);
      const publishedVersionId = createEntityId();
      await tx.insert(workflowDefinitionVersions).values({
        id: publishedVersionId,
        tenantId: context.tenantId,
        definitionId: id,
        version: (latest?.version ?? 0) + 1,
        status: "published",
        graph: draft.graph,
        validation,
        checksum: draft.checksum,
        createdBy: context.userId,
        publishedBy: context.userId,
        publishedAt: new Date(),
      });
      const updated = await tx
        .update(workflowDefinitions)
        .set({
          status: "published",
          scope: definition.scope === "personal" ? "team" : definition.scope,
          currentPublishedVersionId: publishedVersionId,
          revision: definition.revision + 1,
          updatedAt: new Date(),
        })
        .where(
          and(eq(workflowDefinitions.id, id), eq(workflowDefinitions.revision, expectedRevision)),
        )
        .returning({ id: workflowDefinitions.id });
      if (!updated.length) throw new ConflictException("Workflow draft changed while publishing");
    });
    return this.get(context, id);
  }
}

function graphChecksum(graph: WorkflowGraph) {
  return createHash("sha256").update(JSON.stringify(graph)).digest("hex");
}

function versionView(version: typeof workflowDefinitionVersions.$inferSelect) {
  return WorkflowDefinitionVersionViewSchema.parse({
    id: version.id,
    definitionId: version.definitionId,
    version: version.version,
    status: version.status,
    graph: version.graph,
    validation: version.validation,
    checksum: version.checksum,
    createdAt: version.createdAt.toISOString(),
    ...(version.publishedAt ? { publishedAt: version.publishedAt.toISOString() } : {}),
  });
}

function definitionSummary(
  definition: typeof workflowDefinitions.$inferSelect,
  draft: typeof workflowDefinitionVersions.$inferSelect | undefined,
  published: typeof workflowDefinitionVersions.$inferSelect | undefined,
  activeRunCount: number,
) {
  const displayVersion = draft ?? published;
  return {
    id: definition.id,
    stableKey: definition.stableKey,
    name: definition.name,
    description: definition.description,
    category: definition.category,
    scope: definition.scope,
    status: definition.status,
    ...(draft ? { draftVersion: draft.version } : {}),
    ...(published ? { publishedVersion: published.version } : {}),
    revision: definition.revision,
    nodeCount: displayVersion?.graph.nodes.length ?? 0,
    activeRunCount,
    createdAt: definition.createdAt.toISOString(),
    updatedAt: definition.updatedAt.toISOString(),
  };
}

function countBy(values: string[]) {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return counts;
}
