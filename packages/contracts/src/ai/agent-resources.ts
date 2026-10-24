import { z } from "zod";
import { HarnessExecutionContractSchema } from "@yummyai/contracts/harness";
import { CaptureDraftSchema } from "@yummyai/contracts/capture";
import { ResearchSourceReferenceSchema } from "@yummyai/contracts/research/creative";
import { SpecificationFactsSchema } from "@yummyai/contracts/catalog/specification-facts";
import { CustomizationSchema } from "@yummyai/contracts/catalog/product";
import { PrintBindingSchema } from "@yummyai/contracts/catalog/composition";
import { OrderViewSchema, ListOrdersInputSchema } from "@yummyai/contracts/order/order";
import { FinanceProfitRunViewSchema } from "@yummyai/contracts/finance";
import { AdAnalysisRunSchema } from "@yummyai/contracts/advertising";
import { canonicalJson } from "@yummyai/contracts/common/canonical-json";

/** A new read ABI. None of the saved v1 read/tools/native/plan pins is widened. */
export const AGENT_RESOURCES_VERSION = "erp-agent-resources-v1" as const;
export const AgentResourceKeySchema = z.enum([
  "research.evidence", "catalog.sku", "listing.version", "orders.order", "finance.profit_run", "advertising.analysis",
]);
export type AgentResourceKey = z.infer<typeof AgentResourceKeySchema>;
const Id = z.uuidv7().toLowerCase(), Hash = z.string().regex(/^[a-f0-9]{64}$/);
const Version = { version: z.literal(AGENT_RESOURCES_VERSION) };
const Authority = z.string().min(1).max(65_536);
const Page = { q: z.string().trim().max(200).default(""), page: z.int().min(1).max(100_000).default(1), pageSize: z.int().min(1).max(100).default(25) };

export const agentResourceInputSchemas = {
  "research.evidence": z.object({ researchItemId: Id, snapshotId: Id, studyRevisionId: Id.nullable() }).strict(),
  "catalog.sku": z.object({ skuId: Id, recipeId: Id.nullable() }).strict(),
  "listing.version": z.object({ listingId: Id, versionId: Id }).strict(),
  "orders.order": z.object({ orderId: Id, expectedSequence: z.int().positive() }).strict(),
  "finance.profit_run": z.object({ runId: Id }).strict(),
  "advertising.analysis": z.object({ accountId: Id, analysisId: Id }).strict(),
} as const;

const SnapshotFacts = CaptureDraftSchema.pick({ platform: true, parserVersion: true, extensionVersion: true,
  marketplace: true, sourceUrl: true, externalId: true, title: true, domain: true, price: true, rating: true,
  reviewCount: true, taxonomy: true, listingPublishedAt: true, favoriteCount: true, bullets: true,
  missingFields: true, diagnostics: true, captureStatus: true, capturedAt: true }).strict();
const ListingContent = z.object({
  platform: z.enum(["amazon", "etsy"]), locale: z.string(), title: z.string(), description: z.string(),
  bullets: z.array(z.string()), tags: z.array(z.string()), mainImageId: z.string().nullable(), mediaAssetIds: z.array(z.string()),
  variants: z.array(z.object({ skuId: z.string(), skuCode: z.string(), optionValues: z.record(z.string(), z.string()) }).strict()),
  attributes: z.record(z.string(), z.union([z.string(), z.number().finite(), z.boolean()])),
  compliance: z.record(z.string(), z.union([z.string(), z.number().finite(), z.boolean()])),
  personalization: z.object({ enabled: z.boolean(), instructions: z.string().optional(), required: z.boolean().optional(), maxAllowedCharacters: z.int().min(1).max(1024).optional() }).strict().nullable(),
  mediaDescriptions: z.record(Id, z.string().max(500)),
  aPlusModules: z.array(z.object({ type: z.string(), assetIds: z.array(z.string()), headline: z.string().optional() }).strict()),
}).strict();
const Issue = z.object({ severity: z.enum(["blocker", "warning"]), code: z.string(), path: z.string(), message: z.string(), ruleVersion: z.string() }).strict();
const Recipe = z.object({ id: Id, skuId: Id, version: z.int().positive(), status: z.enum(["pending_adaptation", "in_adaptation", "ready_for_customization", "approved"]),
  createdAt: z.iso.datetime(), needsUpdate: z.boolean(),
  artwork: z.object({ id: Id, code: z.string(), name: z.string(), mode: z.enum(["fixed", "personalized_text", "customer_image", "mixed"]),
    versionId: Id, version: z.int().positive(), assetId: Id.nullable(), assetVersion: z.int().positive().nullable(), creativeVersionId: Id.nullable(), customization: CustomizationSchema }).strict(),
  printBindings: z.array(PrintBindingSchema).max(30).nullable(),
  specification: z.object({ id: Id, spuId: Id, spuCode: z.string(), code: z.string(), name: z.string(), versionId: Id, version: z.int().positive(),
    attributes: z.record(z.string(), z.string()), facts: SpecificationFactsSchema,
    processProfileVersionId: Id.nullable(), productType: z.string().nullable(), canvasPrintSpecVersionId: Id.nullable(), stockItemId: Id.nullable() }).strict(),
  editorProjectId: Id.nullable(), editorVersionId: Id.nullable(), renderId: Id.nullable(), designVersionId: Id.nullable(),
}).strict();
export const agentResourceDataSchemas = {
  "research.evidence": z.object({ source: ResearchSourceReferenceSchema.omit({ thumbnailUrl: true }), snapshot: SnapshotFacts }).strict().superRefine((value, ctx) => {
    if (value.source.studyRevisionId === null && (value.source.studyVersion !== 0 || value.source.content !== null) ||
      value.source.studyRevisionId !== null && (value.source.studyVersion < 1 || value.source.content === null))
      ctx.addIssue({ code: "custom", message: "Study content must belong to an explicitly selected original revision" });
  }),
  "catalog.sku": z.object({ skuId: Id, skuCode: z.string(), spuId: Id, spuCode: z.string(), spuName: z.string(),
    attributes: z.record(z.string(), z.string()), lifecycle: z.object({ active: z.boolean(), archived: z.array(z.enum(["product_plan", "spu", "sku"])) }).strict(),
    recipe: Recipe.nullable(), packageCount: z.int().nonnegative(), packageRead: z.boolean(),
    packages: z.array(z.object({ id: Id, version: z.int().positive(), recipeId: Id, listingId: Id, listingVersionId: Id, checksum: Hash,
      platform: z.enum(["amazon", "etsy"]), marketplaceId: z.string(), locale: z.string() }).strict()).max(1000),
  }).strict(),
  "listing.version": z.object({ listing: z.object({ id: Id, spuId: Id, platform: z.enum(["amazon", "etsy"]), marketplaceId: z.string().nullable(), locale: z.string(),
    status: z.enum(["draft", "in_review", "approved", "archived"]), primaryVersionId: Id.nullable() }).strict(),
    version: z.object({ id: Id, listingId: Id, versionNumber: z.int().positive(), ruleVersion: z.string(), status: z.enum(["draft", "approved", "superseded"]),
      source: z.enum(["human", "ai"]), createdAt: z.iso.datetime(), content: ListingContent,
      validation: z.object({ completeness: z.number().finite(), blockers: z.array(Issue), warnings: z.array(Issue) }).strict() }).strict(),
  }).strict(),
  "orders.order": OrderViewSchema,
  "finance.profit_run": FinanceProfitRunViewSchema,
  "advertising.analysis": AdAnalysisRunSchema,
} as const;
export type AgentResourceInput<K extends AgentResourceKey> = z.infer<(typeof agentResourceInputSchemas)[K]>;
export type AgentResourceData<K extends AgentResourceKey> = z.infer<(typeof agentResourceDataSchemas)[K]>;

const Query = { ...Version };
export const AgentResourceCandidatesQuerySchema = z.discriminatedUnion("tool", [
  z.object({ ...Query, tool: z.literal("research.evidence"), q: Page.q }).strict(),
  z.object({ ...Query, tool: z.literal("catalog.sku"), ...Page }).strict(),
  z.object({ ...Query, tool: z.literal("listing.version"), ...Page }).strict(),
  z.object({ ...Query, tool: z.literal("orders.order"), filters: ListOrdersInputSchema }).strict(),
  z.object({ ...Query, tool: z.literal("finance.profit_run") }).strict(),
  z.object({ ...Query, tool: z.literal("advertising.analysis"), accountId: Id.nullable(), cursor: z.string().min(1).max(16_384).nullable(), pageSize: Page.pageSize }).strict(),
]);
export type AgentResourceCandidatesQuery = z.infer<typeof AgentResourceCandidatesQuerySchema>;
export const AgentResourceCandidateSchema = z.object({ id: Id, label: z.string(), detail: z.string(),
  versionId: Id.nullable(), revision: z.int().nonnegative().nullable(), kind: z.enum(["object", "account"]),
}).strict();
export const AgentResourceCandidatesSchema = z.object({ ...Version, contextAuthority: Authority,
  query: AgentResourceCandidatesQuerySchema, inputChecksum: Hash,
  items: z.array(AgentResourceCandidateSchema).max(100),
  coverage: z.object({ kind: z.literal("bounded_candidates"), complete: z.literal(false), total: z.int().nonnegative().nullable(),
    returned: z.int().min(0).max(100), hasMore: z.boolean().nullable(), nextCursor: z.string().nullable(),
    limitation: z.string().min(1).max(1000) }).strict(),
}).strict().superRefine((value, ctx) => {
  if (value.coverage.returned !== value.items.length || new Set(value.items.map(item => item.id)).size !== value.items.length)
    ctx.addIssue({ code: "custom", message: "Candidates must preserve actual bounded owner items" });
  const accounts = value.query.tool === "advertising.analysis" && value.query.accountId === null;
  if (value.items.some(item => item.kind !== (accounts ? "account" : "object")))
    ctx.addIssue({ code: "custom", message: "Candidates must identify their actual selection kind" });
});
export type AgentResourceCandidates = z.infer<typeof AgentResourceCandidatesSchema>;

export const AgentResourceDefinitionRequestSchema = z.object({ ...Version, tool: AgentResourceKeySchema }).strict();
export const AgentResourceDefinitionSchema = z.object({ ...Version, contextAuthority: Authority, tool: AgentResourceKeySchema,
  label: z.string().min(1).max(120), owner: z.string().min(1).max(100), definitionChecksum: Hash,
  inputSchema: z.record(z.string(), z.unknown()), outputSchema: z.record(z.string(), z.unknown()),
  available: z.boolean(), blockReason: z.string().max(160).nullable(), effect: z.literal("read"),
  execution: z.literal("original_owner_object_projection"), limitations: z.array(z.string().max(1000)).min(1).max(10),
}).strict();
export type AgentResourceDefinition = z.infer<typeof AgentResourceDefinitionSchema>;
export function agentResourceDefinitionPayload(value: AgentResourceDefinition) {
  const { version, tool, label, owner, inputSchema, outputSchema, effect, execution, limitations } = value;
  return { version, tool, label, owner, inputSchema, outputSchema, effect, execution, limitations };
}
export const AgentResourceWorkspaceSchema = z.object({ ...Version, contextAuthority: Authority, executionContract: HarnessExecutionContractSchema,
  tools: z.array(z.object({ key: AgentResourceKeySchema, label: z.string(), owner: z.string(), available: z.boolean(), blockReason: z.string().nullable(),
    effect: z.literal("read"), limitations: z.array(z.string()) }).strict()).length(6),
}).strict().superRefine((value, ctx) => {
  if (new Set(value.tools.map(tool => tool.key)).size !== 6) ctx.addIssue({ code: "custom", message: "Every resource must occur once" });
});
export type AgentResourceWorkspace = z.infer<typeof AgentResourceWorkspaceSchema>;
const Call = { ...Version, executionContract: HarnessExecutionContractSchema, definitionChecksum: Hash };
export const AgentResourceCallSchema = z.discriminatedUnion("tool", [
  z.object({ ...Call, tool: z.literal("research.evidence"), input: agentResourceInputSchemas["research.evidence"] }).strict(),
  z.object({ ...Call, tool: z.literal("catalog.sku"), input: agentResourceInputSchemas["catalog.sku"] }).strict(),
  z.object({ ...Call, tool: z.literal("listing.version"), input: agentResourceInputSchemas["listing.version"] }).strict(),
  z.object({ ...Call, tool: z.literal("orders.order"), input: agentResourceInputSchemas["orders.order"] }).strict(),
  z.object({ ...Call, tool: z.literal("finance.profit_run"), input: agentResourceInputSchemas["finance.profit_run"] }).strict(),
  z.object({ ...Call, tool: z.literal("advertising.analysis"), input: agentResourceInputSchemas["advertising.analysis"] }).strict(),
]);
export type AgentResourceCall = z.infer<typeof AgentResourceCallSchema>;
export const AgentResourceSourceSchema = z.object({ owner: z.string().min(1).max(100), kind: z.string().min(1).max(100), id: Id,
  versionId: Id.nullable(), revision: z.int().nonnegative().nullable() }).strict();
const Result = { ...Version, contextAuthority: Authority, callId: Id, checkedAt: z.iso.datetime(), definitionChecksum: Hash,
  inputChecksum: Hash, dataChecksum: Hash, sources: z.array(AgentResourceSourceSchema).min(1).max(2000),
  coverage: z.object({ kind: z.literal("single_object_projection"), complete: z.literal(false), limitation: z.string().min(1).max(1000) }).strict(),
};
export const AgentResourceResultSchema = z.discriminatedUnion("tool", [
  z.object({ ...Result, tool: z.literal("research.evidence"), input: agentResourceInputSchemas["research.evidence"], data: agentResourceDataSchemas["research.evidence"] }).strict(),
  z.object({ ...Result, tool: z.literal("catalog.sku"), input: agentResourceInputSchemas["catalog.sku"], data: agentResourceDataSchemas["catalog.sku"] }).strict(),
  z.object({ ...Result, tool: z.literal("listing.version"), input: agentResourceInputSchemas["listing.version"], data: agentResourceDataSchemas["listing.version"] }).strict(),
  z.object({ ...Result, tool: z.literal("orders.order"), input: agentResourceInputSchemas["orders.order"], data: agentResourceDataSchemas["orders.order"] }).strict(),
  z.object({ ...Result, tool: z.literal("finance.profit_run"), input: agentResourceInputSchemas["finance.profit_run"], data: agentResourceDataSchemas["finance.profit_run"] }).strict(),
  z.object({ ...Result, tool: z.literal("advertising.analysis"), input: agentResourceInputSchemas["advertising.analysis"], data: agentResourceDataSchemas["advertising.analysis"] }).strict(),
]);
export type AgentResourceResult = z.infer<typeof AgentResourceResultSchema>;
export function agentResourceDataPayload(value: AgentResourceResult) {
  const { version, tool, input, data, sources, coverage } = value;
  return { version, tool, input, data, sources, coverage };
}
export const canonicalAgentResourceInput = (value: AgentResourceCall) => canonicalJson({ version: value.version, tool: value.tool, input: value.input });

/** Additive, explicitly opted-in MCP definitions; legacy capability parsing stays frozen. */
export const AgentResourceMcpDefinitionRequestSchema = z.object({ key: z.string().min(1).max(160).refine(value => {
  const parts = value.split("/"); return parts.length === 2 && parts[0] === "resource" && AgentResourceKeySchema.safeParse(parts[1]).success;
}) }).strict();
export const AgentResourceMcpCandidatesRequestSchema = z.object({ ...Version, kind: z.literal("candidates"), query: AgentResourceCandidatesQuerySchema }).strict();
