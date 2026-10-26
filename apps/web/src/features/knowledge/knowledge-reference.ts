import { z } from "zod";
import type { KnowledgeReference } from "@yummyai/contracts/knowledge";

/** Build a fixed internal version link from checked identity, never a supplied URL or today's active version. */
export function knowledgeReferenceHref(reference: Pick<KnowledgeReference, "entryId" | "version">) {
  const id = z.uuidv7().safeParse(reference.entryId);
  if (!id.success || !Number.isSafeInteger(reference.version) || reference.version < 1) return null;
  return "/knowledge?" + new URLSearchParams({ entry: id.data, version: String(reference.version) });
}
