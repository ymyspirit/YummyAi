import { ConflictException, Inject, Injectable } from "@nestjs/common";
import { authorize, ForbiddenError, intersectPermissionContexts, Permission, permissionScope, requiredAssistPermissions } from "@yummyai/authz";
import type { TenantContext } from "@yummyai/contracts";
import {
  AssistTargetPageItemSchema, AssistTargetPageQuerySchema,
  type AssistTargetOwnerPage, type AssistTargetOwnerPosition, type AssistTargetPageItem, type AssistTargetPageSelection,
} from "@yummyai/contracts/ai/task-target-page";
import { loadCurrentMembershipContext, withTenant, type DatabaseConnection } from "@yummyai/database";
import { sql } from "drizzle-orm";
import { DATABASE_CONNECTION } from "../platform.tokens.js";
import { assistTargetSource } from "./assist-target-source.js";

@Injectable()
export class AssistTargetPageOwner {
  constructor(@Inject(DATABASE_CONNECTION) private readonly database: DatabaseConnection) {}

  async read(context: TenantContext, query: AssistTargetPageSelection, position: AssistTargetOwnerPosition, signal: AbortSignal): Promise<AssistTargetOwnerPage> {
    signal.throwIfAborted();
    const selection = AssistTargetPageQuerySchema.omit({ cursor: true }).parse(query);
    const result = await withTenant(this.database.db, context, async tx => {
      await tx.execute(sql`set local statement_timeout = '10000'`);
      const current = intersectPermissionContexts(context, await loadCurrentMembershipContext(tx, context, { lock: true }));
      for (const permission of requiredAssistPermissions(selection.kind, "read")) authorize(current, permission);
      const tenantBits = selection.kind === "business_review" ? [Permission.FinanceRead, Permission.OrderRead] :
        selection.kind === "procurement_review" ? [Permission.ProcurementRead, Permission.InventoryRead] :
          ["order_review", "artwork_preflight", "after_sales_review"].includes(selection.kind) ? [Permission.OrderRead, Permission.OrderPiiRead] : [];
      for (const permission of tenantBits) {
        authorize(current, permission);
        if (permissionScope(current, permission) !== "tenant") throw new ForbiddenError(permission, "outside_data_scope");
      }
      signal.throwIfAborted();
      const { source } = assistTargetSource(current, selection);
      const [page] = await tx.execute<{
        total: string; checkedAt: string; collectionFingerprint: string; anchorExists: boolean; items: AssistTargetPageItem[];
      }>(sql`
        with source as materialized (${source}), projected as materialized (
          select s.id, s.label, s.detail, s.href from source s
        ), summary as (
          select count(*)::text as total,
            encode(sha256(convert_to(coalesce(string_agg(row_to_json(p)::text, '' order by p.id collate "C" desc), ''), 'UTF8')), 'hex') as fingerprint
          from projected p
        ), selected as (
          select p.* from projected p
          where ${position ? sql`p.id collate "C" < ${position.after}` : sql`true`}
          order by p.id collate "C" desc limit ${selection.pageSize + 1}
        )
        select summary.total, summary.fingerprint as "collectionFingerprint",
          to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "checkedAt",
          ${position ? sql`exists(select 1 from projected p where p.id collate "C" = ${position.after})` : sql`true`} as "anchorExists",
          coalesce((select jsonb_agg(to_jsonb(s) order by s.id collate "C" desc) from selected s), '[]'::jsonb) as items
        from summary
      `);
      signal.throwIfAborted();
      if (!page) throw new Error("Assist target collection query returned no summary");
      if (position && (page.collectionFingerprint !== position.collectionFingerprint || !page.anchorExists))
        throw new ConflictException({ code: "assist_target_collection_changed", message: "资料已变化 请从第一页重新读取" });
      const total = Number(page.total);
      if (!Number.isSafeInteger(total) || total < 0) throw new Error("Assist target collection count is invalid");
      const items = page.items.slice(0, selection.pageSize).map(item => AssistTargetPageItemSchema.parse(item));
      return { items, total, checkedAt: page.checkedAt, collectionFingerprint: page.collectionFingerprint,
        hasMore: page.items.length > selection.pageSize, lastKey: items.at(-1)?.id ?? null };
    }, { isolationLevel: "repeatable read", accessMode: "read write" });
    signal.throwIfAborted();
    return result;
  }
}
