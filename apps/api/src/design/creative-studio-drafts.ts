import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { STUDIO_RESULT_INTENT_PREFIX } from "@yummyai/contracts/pod/studio-original";
import { Permission } from "@yummyai/authz";
import { assetFiles, creativeStudioEntries, creativeStudioRevisions, type TenantTransaction } from "@yummyai/database";
import { and, eq, inArray, isNull, ne, notLike, or } from "drizzle-orm";
import { NotFoundException } from "@nestjs/common";
import { currentCreativeWorkspaceAuthority, requireReferenceAuthority } from "./canvas-workflow-access.js";
import { lockStudioScopes } from "./studio-document-scope.js";

/** Continue this member's saved editor documents without sharing another member's workspace.
 * Immutable media bytes are referenced, while documents get independent revision histories.
 * Running jobs, generation logs and pinned submission intents stay with the
 * original requirements. An intent is an action on its original project. */
export async function copyStudioDrafts(tx: TenantTransaction, context: TenantContext, source: string, target: string) {
  await lockStudioScopes(tx, context, [source, target]);
  const origin = await currentCreativeWorkspaceAuthority(tx, context, source);
  const destination = await currentCreativeWorkspaceAuthority(tx, context, target, [Permission.DesignWrite]);
  const entries = await tx.select().from(creativeStudioEntries).where(and(
    eq(creativeStudioEntries.ownerId, context.userId), eq(creativeStudioEntries.scope, source),
    inArray(creativeStudioEntries.namespace, ["app_state", "image_files", "media_files"]),
    or(ne(creativeStudioEntries.namespace, "app_state"), notLike(creativeStudioEntries.key, `${STUDIO_RESULT_INTENT_PREFIX}%`)),
    isNull(creativeStudioEntries.deletedAt),
  )).for("share");
  const ids = [...new Set(entries.flatMap(entry => entry.assetId ? [entry.assetId] : []))];
  const assets = ids.length ? await tx.select().from(assetFiles).where(and(inArray(assetFiles.id, ids),
    eq(assetFiles.assetDomain, "authorized"), isNull(assetFiles.deletedAt))).for("share") : [];
  if (assets.length !== ids.length) throw new NotFoundException("草稿引用的素材不存在");
  for (const asset of assets) if (!["owned", "licensed", "ai_generated"].includes((asset.rightsMetadata.source as { kind?: string } | undefined)?.kind ?? ""))
    throw new NotFoundException("草稿引用的素材来源不可用");
  requireReferenceAuthority(origin.authority, assets, origin.checkedAt);
  requireReferenceAuthority(destination.authority, assets, destination.checkedAt);
  for (const entry of entries) {
    const id = createEntityId();
    await tx.insert(creativeStudioEntries).values({ id, tenantId: context.tenantId, ownerId: context.userId,
      scope: target, namespace: entry.namespace, key: entry.key, revision: 1, value: entry.value, assetId: entry.assetId });
    await tx.insert(creativeStudioRevisions).values({ id: createEntityId(), tenantId: context.tenantId,
      entryId: id, revision: 1, value: entry.value, assetId: entry.assetId });
  }
}
