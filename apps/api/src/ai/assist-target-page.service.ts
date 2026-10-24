import { BadRequestException, ConflictException, Inject, Injectable, RequestTimeoutException } from "@nestjs/common";
import { harnessChecksum, type SecretVault } from "@yummyai/ai-core";
import { authorize, erpPermissionContext, intersectPermissionContexts, requiredAssistPermissions } from "@yummyai/authz";
import type { TenantContext } from "@yummyai/contracts";
import { erpSessionAuthority } from "@yummyai/contracts/auth/session";
import { ASSIST_TARGET_PAGE_VERSION, AssistTargetPageQuerySchema, AssistTargetPageViewSchema } from "@yummyai/contracts/ai/task-target-page";
import { withTenant, loadCurrentMembershipContext, type DatabaseConnection } from "@yummyai/database";
import { z } from "zod";
import { sql } from "drizzle-orm";
import { DATABASE_CONNECTION, INTEGRATION_SECRET_VAULT } from "../platform.tokens.js";
import { AssistTargetPageOwner } from "./assist-target-page-owner.js";

const Cursor = z.object({ version: z.literal(ASSIST_TARGET_PAGE_VERSION), tenantId: z.uuidv7(), actorId: z.uuidv7(),
  authorityChecksum: z.string().regex(/^[a-f0-9]{64}$/), queryChecksum: z.string().regex(/^[a-f0-9]{64}$/),
  collectionFingerprint: z.string().regex(/^[a-f0-9]{64}$/), after: z.string().min(1).max(80),
  total: z.int().nonnegative().max(Number.MAX_SAFE_INTEGER), readCount: z.int().positive().max(Number.MAX_SAFE_INTEGER), expiresAt: z.iso.datetime() }).strict();
const changed = () => new ConflictException({ code: "assist_target_collection_changed", message: "原业务对象集合或游标已变化 请清除旧页并重新读取" });
const active = (signal: AbortSignal) => { if (signal.aborted) throw new RequestTimeoutException({ code: "assist_target_read_timeout", message: "业务对象读取已超时 请重新读取" }); };
@Injectable()
export class AssistTargetPageService {
  constructor(@Inject(DATABASE_CONNECTION) private readonly database: DatabaseConnection,
    @Inject(AssistTargetPageOwner) private readonly owner: AssistTargetPageOwner,
    @Inject(INTEGRATION_SECRET_VAULT) private readonly vault: SecretVault) {}

  async page(context: TenantContext, raw: unknown) {
    const parsed = AssistTargetPageQuerySchema.safeParse(raw);
    if (!parsed.success) throw new BadRequestException("业务对象查询参数无效");
    const query = parsed.data, { cursor: token, ...selection } = query, signal = AbortSignal.timeout(15_000);
    const current = await this.current(context, query.kind), authority = erpSessionAuthority(current);
    const binding = { version: ASSIST_TARGET_PAGE_VERSION, tenantId: current.tenantId, actorId: current.userId,
      authorityChecksum: harnessChecksum(authority), queryChecksum: harnessChecksum(selection) };
    let cursor: z.infer<typeof Cursor> | null = null;
    if (token) {
      try { cursor = await this.vault.withSecret(token, value => Cursor.parse(JSON.parse(value))); }
      catch { throw changed(); }
      if (Object.entries(binding).some(([key, value]) => cursor![key as keyof typeof binding] !== value) || cursor.expiresAt <= new Date().toISOString()) throw changed();
    }
    active(signal);
    const page = await this.owner.read(current, selection, cursor ? { after: cursor.after, collectionFingerprint: cursor.collectionFingerprint } : null, signal);
    active(signal);
    if (cursor && (page.collectionFingerprint !== cursor.collectionFingerprint || page.total !== cursor.total)) throw changed();
    const readCount = (cursor?.readCount ?? 0) + page.items.length;
    if (page.items.length > selection.pageSize || readCount > page.total ||
      page.hasMore && (!page.items.length || !page.lastKey || readCount >= page.total) || !page.hasMore && readCount !== page.total) throw changed();
    const final = await this.current(context, query.kind);
    if (erpSessionAuthority(final) !== authority) throw new ConflictException({ code: "authority_changed", message: "当前授权已变化 原业务对象已隐藏" });
    active(signal);
    const nextCursor = page.hasMore ? this.vault.encrypt(JSON.stringify(Cursor.parse({ ...binding, after: page.lastKey,
      collectionFingerprint: page.collectionFingerprint, total: page.total, readCount,
      expiresAt: cursor?.expiresAt ?? new Date(Date.now() + 15 * 60_000).toISOString() }))) : null;
    return AssistTargetPageViewSchema.parse({ version: ASSIST_TARGET_PAGE_VERSION, effect: "read", kind: selection.kind,
      contextAuthority: erpSessionAuthority(erpPermissionContext(current)), checkedAt: page.checkedAt, collectionFingerprint: page.collectionFingerprint,
      total: page.total, readCount, consistency: "unchanged_collection", complete: !page.hasMore, nextCursor, query, items: page.items });
  }
  private current(context: TenantContext, kind: Parameters<typeof requiredAssistPermissions>[0]) {
    return withTenant(this.database.db, context, async tx => {
      await tx.execute(sql`set local statement_timeout = '10000'`);
      const current = intersectPermissionContexts(context, await loadCurrentMembershipContext(tx, context, { lock: true }));
      for (const permission of requiredAssistPermissions(kind, "read")) authorize(current, permission);
      return current;
    }, { isolationLevel: "repeatable read", accessMode: "read write" });
  }
}
