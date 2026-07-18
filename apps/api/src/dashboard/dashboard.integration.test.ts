import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { connectDatabase, migrateDatabase } from "@yummyai/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DashboardService, DrizzleDashboardRepository } from "./dashboard.service.js";

describe("dashboard database aggregation", () => {
  const database = connectDatabase(); const userId = createEntityId();
  const first = tenant(createEntityId(), userId); const second = tenant(createEntityId(), userId);
  const service = new DashboardService(new DrizzleDashboardRepository(database));

  beforeAll(async () => {
    await migrateDatabase(database);
    await database.client.unsafe(`insert into organizations (id,name,slug) values ($1,'Ops A',$2),($3,'Ops B',$4)`, [first.tenantId, `ops-${first.tenantId}`, second.tenantId, `ops-${second.tenantId}`]);
    await database.client.unsafe(`insert into app_users (id,oidc_subject,email,display_name) values ($1,$2,$3,'Ops User')`, [userId, `ops-${userId}`, `${userId}@example.test`]);
    await seed(first, 3, 1.25); await seed(second, 9, 8.5);
  });
  afterAll(async () => { await database.client.end(); });

  it("counts only the current tenant's captures and committed AI cost", async () => {
    const metrics = await service.getMetrics(first, { from: "2026-07-18", to: "2026-07-18", timezone: "UTC" });
    expect(metrics.capture.total).toBe(3); expect(metrics.capture.complete).toBe(3); expect(metrics.ai.costUsd).toBe(1.25);
  });

  async function seed(context: TenantContext, captures: number, cost: number) {
    const itemId = createEntityId();
    await database.client.unsafe(`insert into research_items (id,tenant_id,owner_user_id,platform,marketplace,normalized_url,latest_status) values ($1,$2,$3,'amazon','US',$4,'complete')`, [itemId, context.tenantId, userId, `https://example.test/${itemId}`]);
    for (let index = 0; index < captures; index += 1) await database.client.unsafe(`insert into capture_snapshots (id,tenant_id,research_item_id,captured_by,source_url,status,domain,draft,captured_at) values ($1,$2,$3,$4,$5,'complete','research',$6::jsonb,'2026-07-18T06:00:00Z')`, [createEntityId(), context.tenantId, itemId, userId, `https://example.test/${itemId}/${index}`, JSON.stringify({ platform: "amazon", marketplace: "US", sourceUrl: `https://example.test/${index}`, capturedAt: "2026-07-18T06:00:00Z", fields: {}, media: [], diagnostics: [] })]);
    await database.client.unsafe(`insert into ai_budget_ledger (id,tenant_id,request_id,task_type,model_key,provider,amount_usd,state,created_at) values ($1,$2,$3,'AI-01','analyst.default','test',$4,'committed','2026-07-18T06:00:00Z')`, [createEntityId(), context.tenantId, createEntityId(), cost]);
  }
});

function tenant(tenantId: string, userId: string): TenantContext { return { tenantId, userId, permissions: [], dataScope: "tenant" }; }
