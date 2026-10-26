import { z } from "zod";

export const KNOWLEDGE_TOPICS = {
  listing: "Listing 文案",
  advertising: "广告运营",
  after_sales: "客服与售后",
  research: "市场研究",
  operations: "运营 SOP",
} as const;
export const KnowledgeTopicSchema = z.enum([
  "listing",
  "advertising",
  "after_sales",
  "research",
  "operations",
]);
export const KnowledgePlatformSchema = z.enum(["all", "amazon", "etsy"]);
const DateOnly = z.iso.date();
export const KnowledgeFieldsSchema = z
  .object({
    title: z.string().trim().min(1).max(180),
    summary: z.string().trim().max(1000),
    body: z.string().trim().min(1).max(24000),
    topic: KnowledgeTopicSchema,
    platform: KnowledgePlatformSchema,
    market: z.string().regex(/^(ALL|[A-Z]{2})$/),
    spuId: z.uuidv7().nullable(),
    sourceType: z.enum(["official", "team", "case"]),
    sourceLabel: z.string().trim().min(1).max(240),
    sourceUrl: z.union([
      z.literal(""),
      z
        .url()
        .max(2000)
        .refine((value) => /^https?:\/\//i.test(value)),
    ]),
    owner: z.string().trim().min(1).max(100),
    verifiedOn: DateOnly,
    reviewDueOn: DateOnly,
    tags: z.array(z.string().trim().min(1).max(40)).max(12),
    documentIds: z.array(z.uuidv7()).max(12).optional(),
    sourceSnapshotIds: z.array(z.uuidv7()).max(12).optional(),
    claims: z
      .array(
        z
          .object({
            key: z.string().trim().min(1).max(120),
            value: z.string().trim().min(1).max(500),
            condition: z.string().trim().max(500),
            unit: z.string().trim().max(40),
            validFrom: DateOnly,
            validUntil: DateOnly,
            severity: z.enum(["warning", "blocking"]),
          })
          .strict()
          .refine((c) => c.validUntil >= c.validFrom, "主张有效期不正确"),
      )
      .max(20)
      .optional(),
  })
  .strict()
  .superRefine((fields, ctx) => {
    if (
      new Set(fields.claims?.map((c) => c.key.toLowerCase()) ?? []).size !==
      (fields.claims?.length ?? 0)
    )
      ctx.addIssue({ code: "custom", path: ["claims"], message: "主张编号不能重复" });
    for (const key of ["documentIds", "sourceSnapshotIds"] as const)
      if (new Set(fields[key] ?? []).size !== (fields[key]?.length ?? 0))
        ctx.addIssue({ code: "custom", path: [key], message: "证据版本不能重复" });
    if (fields.sourceUrl) {
      const url = new URL(fields.sourceUrl);
      if (
        url.username ||
        url.password ||
        [...url.searchParams.keys()].some((k) =>
          /token|secret|password|cookie|api[-_]?key|signature|credential/i.test(k),
        )
      )
        ctx.addIssue({
          code: "custom",
          path: ["sourceUrl"],
          message: "原文地址不能包含访问凭证或签名",
        });
    }
    if (fields.reviewDueOn < fields.verifiedOn)
      ctx.addIssue({ code: "custom", path: ["reviewDueOn"], message: "复查日期不能早于核对日期" });
    if (fields.sourceType === "official" && !fields.sourceUrl)
      ctx.addIssue({ code: "custom", path: ["sourceUrl"], message: "官方知识需填写原文地址" });
  });
export type KnowledgeFields = z.infer<typeof KnowledgeFieldsSchema>;
export const SaveKnowledgeSchema = z
  .object({
    fields: KnowledgeFieldsSchema,
    expectedRevision: z.number().int().nonnegative(),
    reason: z.string().trim().min(1).max(500),
    requestId: z.uuid(),
  })
  .strict();
export const ChangeKnowledgeSchema = z
  .object({
    expectedRevision: z.number().int().positive(),
    version: z.number().int().positive(),
    reason: z.string().trim().min(1).max(500),
    requestId: z.uuid(),
  })
  .strict();
export const KnowledgeActionSchema = z.enum([
  "create",
  "revise",
  "submit",
  "publish",
  "reject",
  "disable",
  "archive",
]);
export type KnowledgeAction = z.infer<typeof KnowledgeActionSchema>;
export const KnowledgeVersionSchema = KnowledgeFieldsSchema.safeExtend({
  id: z.uuidv7(),
  entryId: z.uuidv7(),
  version: z.number().int().positive(),
  checksum: z.string(),
  reason: z.string(),
  createdAt: z.iso.datetime(),
});
export const KnowledgeEntrySchema = z.object({
  id: z.uuidv7(),
  revision: z.number().int().positive(),
  latestVersion: z.number().int().positive(),
  activeVersion: z.number().int().positive().nullable(),
  state: z.enum(["draft", "in_review", "published"]),
  archivedAt: z.iso.datetime().nullable(),
  updatedAt: z.iso.datetime(),
  latest: KnowledgeVersionSchema,
  active: KnowledgeVersionSchema.nullable(),
});
export type KnowledgeEntry = z.infer<typeof KnowledgeEntrySchema>;
export const KnowledgeWorkspaceSchema = z.object({
  entries: z.array(KnowledgeEntrySchema),
  spus: z.array(z.object({ id: z.uuidv7(), code: z.string(), name: z.string() })),
  canManage: z.boolean(),
  canPublish: z.boolean(),
});
export type KnowledgeWorkspace = z.infer<typeof KnowledgeWorkspaceSchema>;
/** Read-only product candidates for an explicit knowledge scope. This is a
 * bounded search, not an assertion that all authorized products were read. */
export const KnowledgeProductOptionsQuerySchema = z.object({
  q: z.string().trim().max(200).default(""),
}).strict();
export const KnowledgeProductOptionsSchema = z.object({
  contextAuthority: z.string().min(1).max(65_536),
  items: z.array(KnowledgeWorkspaceSchema.shape.spus.element).max(40),
  hasMore: z.boolean(),
  limit: z.literal(40),
}).strict().superRefine((value, context) => {
  if (new Set(value.items.map(item => item.id.toLowerCase())).size !== value.items.length)
    context.addIssue({ code: "custom", message: "Product candidates must be unique" });
  if (value.hasMore && value.items.length !== value.limit)
    context.addIssue({ code: "custom", message: "A bounded result with more candidates must fill its limit" });
});
export type KnowledgeProductOptionsQuery = z.infer<typeof KnowledgeProductOptionsQuerySchema>;
export type KnowledgeProductOptions = z.infer<typeof KnowledgeProductOptionsSchema>;
export const KnowledgeHistorySchema = z.object({
  versions: z.array(KnowledgeVersionSchema),
  events: z.array(
    z.object({
      id: z.uuidv7(),
      version: z.number().int().positive(),
      action: KnowledgeActionSchema,
      reason: z.string(),
      createdAt: z.iso.datetime(),
    }),
  ),
});
export type KnowledgeHistory = z.infer<typeof KnowledgeHistorySchema>;
export const KnowledgeSearchSchema = z
  .object({
    query: z.string().trim().min(1).max(300),
    topic: z.union([KnowledgeTopicSchema, z.literal("all")]),
    platform: KnowledgePlatformSchema,
    market: z.string().regex(/^(ALL|[A-Z]{2})$/),
    spuIds: z.array(z.uuidv7()).max(50).default([]),
  })
  .strict();
export type KnowledgeSearch = z.infer<typeof KnowledgeSearchSchema>;
export const KnowledgeReferenceSchema = z.object({
  sourceId: z.string(),
  entryId: z.uuidv7(),
  versionId: z.uuidv7(),
  version: z.number().int().positive(),
  title: z.string(),
  excerpt: z.string().max(4000),
  sourceLabel: z.string(),
  sourceUrl: z.string(),
  verifiedOn: DateOnly,
  reviewDueOn: DateOnly,
  checksum: z.string(),
  href: z.string(),
  score: z.number(),
});
export type KnowledgeReference = z.infer<typeof KnowledgeReferenceSchema>;
export const KnowledgeSearchResultSchema = z.object({
  references: z.array(KnowledgeReferenceSchema).max(6),
  diagnostics: z.array(z.string()),
  retrievedAt: z.iso.datetime(),
  mode: z.literal("keyword"),
  scanned: z.number().int().nonnegative(),
});
export type KnowledgeSearchResult = z.infer<typeof KnowledgeSearchResultSchema>;
