import { Permission, requireAssetAuthority } from "@yummyai/authz";
import { requireReferenceAuthority } from "@yummyai/catalog-core";
import { assetFiles } from "@yummyai/database";
import type { Storage } from "@yummyai/storage";
import { eq, inArray } from "drizzle-orm";
import type { CreativeWorkerIdentity } from "./creative-execution-admission.js";
import type { CreativeExecutionRecovery, CreativeExecutionClaim } from "./creative-execution-recovery.js";
import { hashPodResponse } from "./pod-artwork-response.js";
import type { PodArtworkExecutionAsset } from "./pod-artwork.processor.js";

export { creativeDerivedRights } from "@yummyai/catalog-core";

/** Current object policy before and after IO, with hashes over the actual source bytes. */
export async function readCreativeAssets(recovery: CreativeExecutionRecovery, storage: Storage, identity: CreativeWorkerIdentity,
  claim: CreativeExecutionClaim, ids: string[], allowDraftAi = false) {
  const unique = [...new Set(ids)];
  const loaded = await recovery.authorized(identity, claim, async (tx, admission) => {
    const files = unique.length ? await tx.select().from(assetFiles).where(inArray(assetFiles.id, unique)).for("share") : [];
    if (files.length !== unique.length) throw new Error("CREATIVE_INPUT_ASSET_MISSING");
    for (const file of files) validate(admission.authority, admission.checkedAt, file, allowDraftAi);
    return { files, authority: admission.authority, checkedAt: admission.checkedAt };
  });
  const result = [];
  for (const id of unique) {
    const file = loaded.files.find(file => file.id === id)!;
    const rightsStatus = validate(loaded.authority, loaded.checkedAt, file, allowDraftAi);
    const bytes = await storage.readPrivate(loaded.authority, { id: file.id, tenantId: identity.tenantId, assetDomain: "authorized", objectKey: file.objectKey },
      { requiredDomain: "authorized", maxBytes: Math.min(Number(file.byteSize), 50 * 1024 * 1024) });
    if (bytes.length !== file.byteSize || hashPodResponse(bytes) !== file.checksumSha256) throw new Error("CREATIVE_INPUT_ASSET_CHANGED");
    await recovery.authorized(identity, claim, async (tx, admission) => {
      const [current] = await tx.select().from(assetFiles).where(eq(assetFiles.id, id)).for("share");
      if (!current || current.version !== file.version || current.objectKey !== file.objectKey || current.checksumSha256 !== file.checksumSha256) throw new Error("CREATIVE_INPUT_ASSET_CHANGED");
      validate(admission.authority, admission.checkedAt, current, allowDraftAi);
    });
    const source = file.rightsMetadata.source as { kind: PodArtworkExecutionAsset["rightsSourceKind"] };
    result.push({ file, input: { id: file.id, version: file.version, checksumSha256: file.checksumSha256,
      domain: "authorized" as const, rightsStatus, rightsSourceKind: source.kind, bytes, mediaType: file.mediaType } satisfies PodArtworkExecutionAsset });
  }
  return result;
}

function validate(authority: Parameters<typeof requireReferenceAuthority>[0], checkedAt: number, file: typeof assetFiles.$inferSelect, allowDraftAi: boolean): "approved" | "unverified" {
  requireAssetAuthority(authority, Permission.AssetRead, file); requireReferenceAuthority(authority, [file], checkedAt);
  const source = file.rightsMetadata.source as { kind?: string } | undefined;
  if (file.deletedAt || file.assetDomain !== "authorized" || !["owned", "licensed", "commissioned", "ai_generated"].includes(source?.kind ?? "")
    || (file.rightsStatus !== "approved" && !(allowDraftAi && file.rightsStatus === "unverified" && source?.kind === "ai_generated")))
    throw new Error("CREATIVE_INPUT_ASSET_UNAVAILABLE");
  return file.rightsStatus === "approved" ? "approved" : "unverified";
}
