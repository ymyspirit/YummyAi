import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createEntityId } from "@yummyai/contracts";
import { AssistViewSchema, type AssistView } from "@yummyai/contracts/ai/assist";
import { KnowledgeReferenceSchema } from "@yummyai/contracts/knowledge";
import { KnowledgeAnswer } from "./knowledge-shared";
import { knowledgeReferenceHref } from "./knowledge-reference";
import { KnowledgeToolResult } from "../ai-tasks/agent-tool-read-result";

const reference = () => KnowledgeReferenceSchema.parse({ sourceId: "synthetic-reference", entryId: createEntityId(), versionId: createEntityId(), version: 3,
  title: "Synthetic pinned knowledge", excerpt: "SYNTHETIC_ORIGINAL_EXCERPT", sourceLabel: "Synthetic official source", sourceUrl: "https://example.com/source",
  verifiedOn: "2026-10-01", reviewDueOn: "2026-11-01", checksum: "a".repeat(64), href: "javascript:forged-reference", score: 4 });
function answer(): AssistView {
  return AssistViewSchema.parse({ id: createEntityId(), kind: "knowledge_answer", scope: "knowledge:synthetic", status: "completed",
    createdAt: "2026-10-27T00:00:00.000Z", completedAt: "2026-10-27T00:00:01.000Z", modelLabel: "Synthetic model", model: "synthetic-model",
    promptVersion: "synthetic-v1", inputFingerprint: "b".repeat(64), stale: false, maxTaskCostUsd: null, request: null,
    inputTokens: null, outputTokens: null, costUsd: 0.12, error: null, diagnostics: ["SYNTHETIC_ORIGINAL_DIAGNOSTIC"],
    sources: [{ id: "synthetic-reference", label: "Synthetic source", href: "javascript:forged-reference" }], knowledge: [reference()], checks: [],
    result: { summary: "SYNTHETIC_ORIGINAL_BODY", findings: [{ title: "Synthetic finding", detail: "Synthetic detail", kind: "fact", severity: "info", location: null,
      evidence: [{ sourceId: "synthetic-reference", detail: "Synthetic original evidence" }] }], directions: [], matches: [], missingInformation: [] }, images: [] });
}

describe("knowledge citations remain fixed to their checked identity", () => {
  it("builds the exact internal entry/version path instead of following a supplied URL", () => {
    const item = reference();
    expect(knowledgeReferenceHref(item)).toBe(`/knowledge?entry=${item.entryId}&version=3`);
    expect(knowledgeReferenceHref({ ...item, entryId: "not-an-entry" })).toBeNull();
    expect(knowledgeReferenceHref({ ...item, version: 0 })).toBeNull();
    expect(knowledgeReferenceHref({ ...item, version: 1.2 })).toBeNull();
  });

  it("provides the same pinned version from the Agent read result and answer, preserving the separate external source", () => {
    const view = answer(), item = view.knowledge[0]!;
    const tool = renderToStaticMarkup(<KnowledgeToolResult data={{ references: [item], diagnostics: [], scanned: 1, retrievedAt: view.createdAt, mode: "keyword" }} />);
    const text = renderToStaticMarkup(<KnowledgeAnswer view={view} />);
    for (const html of [tool, text]) {
      expect(html).toContain(`/knowledge?entry=${item.entryId}&amp;version=3`);
      expect(html).not.toContain("javascript:forged-reference");
    }
    expect(tool).toContain("核对原知识 V3");
    expect(tool).toContain('href="https://example.com/source"');
  });

  it("prioritizes invalidation and hides all body-derived text even when a stale DTO still contains its old content", () => {
    const view = { ...answer(), stale: true }, html = renderToStaticMarkup(<KnowledgeAnswer view={view} />);
    expect(html).toContain("原依据已变化");
    expect(html).toContain("本次正文与固定引用已隐藏");
    expect(html).not.toContain("SYNTHETIC_ORIGINAL_BODY");
    expect(html).not.toContain("SYNTHETIC_ORIGINAL_EXCERPT");
    expect(html).not.toContain("SYNTHETIC_ORIGINAL_DIAGNOSTIC");
    expect(html).not.toContain("/knowledge?entry=");
    expect(html).toContain("历史费用值 $0.12");
  });

  it("distinguishes an unavailable completed body from an active readable answer without starting another task", () => {
    const view = answer(), unavailable = renderToStaticMarkup(<KnowledgeAnswer view={{ ...view, result: null }} />);
    expect(unavailable).toContain("原回答正文当前不可读");
    expect(unavailable).not.toContain("SYNTHETIC_ORIGINAL_BODY");
    expect(renderToStaticMarkup(<KnowledgeAnswer view={view} />)).toContain("SYNTHETIC_ORIGINAL_BODY");
  });
});
