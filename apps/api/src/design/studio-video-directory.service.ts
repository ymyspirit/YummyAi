import { createHash } from "node:crypto";
import { ConflictException, Inject, Injectable, UnprocessableEntityException } from "@nestjs/common";
import { erpPermissionContext } from "@yummyai/authz";
import type { TenantContext } from "@yummyai/contracts";
import { erpSessionAuthority } from "@yummyai/contracts/auth/session";
import { STUDIO_VIDEO_DIRECTORY_MAX_ITEMS, STUDIO_VIDEO_DIRECTORY_MAX_SOURCE_BYTES,
  StudioVideoDirectorySchema, StudioVideoPreflightSchema, type StudioVideoDirectory } from "@yummyai/contracts/pod/studio-video-directory";
import { creativeStudioEntries, creativeStudioGenerations, withTenant, type DatabaseConnection } from "@yummyai/database";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { DATABASE_CONNECTION } from "../platform.tokens.js";
import { currentCreativeWorkspaceAuthority } from "./canvas-workflow-access.js";
import { projectStudioVideoLog, studioVideoTaskId } from "./studio-video-directory-projection.js";

const changed = () => new ConflictException({ code: "studio_video_directory_changed", message: "视频日志或任务已变化 请重新读取完整目录" });
const tooLarge = () => new UnprocessableEntityException({ code: "studio_video_directory_too_large", message: "视频日志超过本次完整读取上限 未将部分结果视为空目录" });
const stamp = (context: TenantContext) => erpSessionAuthority(erpPermissionContext(context));
function canonical(value: unknown): string {
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

/** A complete metadata inventory. Never hydrate a task, read media, or invoke a generation owner here. */
@Injectable()
export class StudioVideoDirectoryService {
  constructor(@Inject(DATABASE_CONNECTION) private readonly database: DatabaseConnection) {}

  private async read(context: TenantContext, scope: string): Promise<StudioVideoDirectory> {
    const result = await withTenant(this.database.db, context, async tx => {
      const { authority } = await currentCreativeWorkspaceAuthority(tx, context, scope);
      const contextAuthority = stamp(authority);
      const filter = and(eq(creativeStudioEntries.ownerId, context.userId), eq(creativeStudioEntries.scope, scope),
        eq(creativeStudioEntries.namespace, "video_generation_logs"), isNull(creativeStudioEntries.deletedAt));
      // Inspect complete size before materializing any native documents. A bound
      // violation is an explicit failure, never a successful truncated inventory.
      const [size] = await tx.select({
        count: sql<string>`count(*)::text`,
        bytes: sql<string>`coalesce(sum(octet_length(coalesce(${creativeStudioEntries.value}::text, 'null'))), 0)::text`,
      }).from(creativeStudioEntries).where(filter);
      const count = Number(size?.count), bytes = Number(size?.bytes);
      if (!Number.isSafeInteger(count) || !Number.isSafeInteger(bytes) || count < 0 || bytes < 0 ||
        count > STUDIO_VIDEO_DIRECTORY_MAX_ITEMS || bytes > STUDIO_VIDEO_DIRECTORY_MAX_SOURCE_BYTES) throw tooLarge();
      const entries = await tx.select({ id: creativeStudioEntries.id, key: creativeStudioEntries.key,
        revision: creativeStudioEntries.revision, value: creativeStudioEntries.value,
        assetId: creativeStudioEntries.assetId, updatedAt: creativeStudioEntries.updatedAt,
      }).from(creativeStudioEntries).where(filter).orderBy(asc(creativeStudioEntries.id)).for("share");
      if (entries.length !== count) throw changed();
      const taskIds = [...new Set(entries.flatMap(entry => {
        const id = studioVideoTaskId(entry.value); return id ? [id] : [];
      }))];
      // A native task ID is only a lookup hint. Current tenant RLS, exact owner,
      // original scope and video capability remain the actual association gate.
      const generations = taskIds.length ? await tx.select({ id: creativeStudioGenerations.id,
        status: creativeStudioGenerations.status, updatedAt: creativeStudioGenerations.updatedAt,
        assetId: creativeStudioGenerations.assetId,
      }).from(creativeStudioGenerations).where(and(inArray(creativeStudioGenerations.id, taskIds),
        eq(creativeStudioGenerations.ownerId, context.userId), eq(creativeStudioGenerations.scope, scope),
        sql`${creativeStudioGenerations.modelSnapshot}->>'capability' = 'video'`))
        .orderBy(asc(creativeStudioGenerations.id)).for("share") : [];
      const tracked = new Map(generations.map(row => [row.id, { status: row.status }]));
      const items = entries.map(entry => projectStudioVideoLog(entry, tracked));
      const snapshotHash = createHash("sha256").update(canonical({ version: 1, tenantId: context.tenantId,
        ownerId: context.userId, scope, contextAuthority, entries, generations })).digest("hex");
      const directory = StudioVideoDirectorySchema.parse({ version: 1, snapshotHash, total: count, items });
      // Keep room for the personal transport envelope inside its existing 10MiB
      // metadata limit, including worst-case UTF-8 titles. Do not stream a prefix.
      if (Buffer.byteLength(JSON.stringify(directory), "utf8") > 9 * 1024 * 1024) throw tooLarge();
      return { contextAuthority, directory };
    }, { isolationLevel: "repeatable read", accessMode: "read write" });
    // Original authority uses row locks. Keep its read-write transaction mode;
    // this owner performs no business writes and verifies current authority again.
    const current = await withTenant(this.database.db, context, async tx =>
      (await currentCreativeWorkspaceAuthority(tx, context, scope)).authority);
    if (stamp(current) !== result.contextAuthority) throw new ConflictException({ code: "authority_changed", message: "当前本人权限已变化 请重新核对" });
    return result.directory;
  }

  directory(context: TenantContext, scope: string) { return this.read(context, scope); }

  async preflight(context: TenantContext, scope: string, snapshotHash: string) {
    const directory = await this.read(context, scope);
    if (directory.snapshotHash !== snapshotHash) throw changed();
    const blockedEntryIds = directory.items.filter(item => item.diagnostics.length > 0 || item.nativeStatus === "unknown" ||
      item.origin === "invalid" || item.task === "invalid" || item.origin === "original" && item.task === "untracked")
      .map(item => item.entryId);
    return StudioVideoPreflightSchema.parse({ version: 1, snapshotHash, total: directory.total,
      canOpen: blockedEntryIds.length === 0, blockedEntryIds, mode: "view_only", execution: "paused" });
  }
}
