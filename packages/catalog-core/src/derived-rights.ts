import type { assetFiles } from "@yummyai/database";

/** Deterministic derivation inherits actual source restrictions, never a fabricated new approval. */
export function creativeDerivedRights(files: Array<typeof assetFiles.$inferSelect>, derivative: Record<string, unknown>) {
  if (!files.length) throw new Error("CREATIVE_INPUT_ASSET_MISSING");
  const sources = files.map(file => ({ file, source: file.rightsMetadata.source as Record<string, unknown> }));
  const basis = sources.find(item => item.source.kind === "licensed") ?? sources.find(item => item.source.kind === "commissioned")
    ?? sources.find(item => item.source.kind === "ai_generated") ?? sources[0]!;
  const expiries = sources.map(item => item.source.licenseExpiresAt).filter((date): date is string => typeof date === "string");
  const earliest = expiries.sort((a, b) => Date.parse(a) - Date.parse(b))[0];
  return { source: { ...basis.source, ...(earliest ? { licenseExpiresAt: earliest } : {}) }, derivative,
    inheritedRights: sources.map(({ file }) => ({ assetId: file.id, version: file.version, checksumSha256: file.checksumSha256,
      rightsStatus: file.rightsStatus, evidence: file.rightsMetadata })) };
}
