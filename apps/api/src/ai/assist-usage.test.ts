import { describe, expect, it, vi } from "vitest";
import { createEntityId } from "@yummyai/contracts";
import { normalizeModelTokenUsage } from "@yummyai/ai-core";
import type { TenantTransaction } from "@yummyai/database";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { readAssistUsageSummary } from "./assist-usage.js";

describe("assist scope original-call usage", () => {
  const usage=normalizeModelTokenUsage({input_tokens:12,output_tokens:4,total_tokens:16})!;
  function fixture(rows:Array<{tokenUsage:typeof usage|null;inputTokens:number|null;outputTokens:number|null}>) {
    const where=vi.fn<(condition:SQL)=>Promise<typeof rows>>(async()=>rows);
    const tx={select:()=>({from:()=>({leftJoin:()=>({where})})})};
    return {tx:tx as unknown as TenantTransaction,where};
  }
  it("aggregates all submitted rows instead of the twenty displayed history items",async()=>{
    const f=fixture([...Array.from({length:25},()=>({tokenUsage:usage,inputTokens:12,outputTokens:4})),{tokenUsage:null,inputTokens:null,outputTokens:null}]);
    const owner=createEntityId(),scope=`order:${createEntityId()}`;
    expect(await readAssistUsageSummary(f.tx,owner,"order_review",scope)).toMatchObject({scope:"assist_scope",state:"partial",callCount:26,reportedCalls:25,unknownCalls:1,totalTokens:400});
    const query=new PgDialect().sqlToQuery(f.where.mock.calls[0]![0]);
    expect(query.params).toEqual([owner,"order_review",scope]);
    expect(query.sql).toContain('"ai_assist_runs"."owner_id"');
    expect(query.sql).toContain('"ai_assist_runs"."benchmark_item_id" is null');
    expect(query.sql).toContain('"ai_assist_executions"."submitted_at" is not null');
    expect(query.sql).toContain('"ai_assist_executions"."run_id" is null');
    expect(query.sql).not.toContain("limit");
  });
  it("keeps fixed benchmark identity separate and reads legacy actual counts without backfilling JSON",async()=>{
    const row={tokenUsage:null,inputTokens:9,outputTokens:3};
    const f=fixture([row]),owner=createEntityId(),benchmark=createEntityId();
    expect(await readAssistUsageSummary(f.tx,owner,"creative","fixed-scope",benchmark)).toMatchObject({state:"complete",callCount:1,inputTokens:9,outputTokens:3,totalTokens:12,cachedInputTokens:null});
    expect(new PgDialect().sqlToQuery(f.where.mock.calls[0]![0]).params).toEqual([owner,"creative","fixed-scope",benchmark]);
    expect(row.tokenUsage).toBeNull();
  });
  it("reports an empty ledger as no calls rather than a billed zero-token call",async()=>{
    expect(await readAssistUsageSummary(fixture([]).tx,createEntityId(),"creative","empty")).toMatchObject({state:"empty",callCount:0,unknownCalls:0,totalTokens:0});
  });
});
