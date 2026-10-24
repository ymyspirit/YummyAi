import { describe, expect, it } from "vitest";
import { createEntityId } from "@yummyai/contracts";
import { SalesPlanFieldsSchema, type SalesPlanDetail } from "@yummyai/contracts/catalog/sales-plan";
import type { SalesPlanLaunch } from "@yummyai/contracts/catalog/sales-plan-launch";
import { preparationDecision } from "./sales-plan-agent-policy.js";

function basis() {
  const id = createEntityId();
  const detail: SalesPlanDetail = { plan: { id, spuId: createEntityId(), spuCode: "QA", spuName: "Synthetic",
    revision: 2, fields: SalesPlanFieldsSchema.parse({ name: "Synthetic", mode: "custom", fulfillment: "fbm" }),
    archived: false, updatedAt: new Date().toISOString() }, listingAccess: true, listings: [] };
  const launch: SalesPlanLaunch = { planId: id, revision: 2, nextStage: null, tasks: [], hasMoreTasks: false,
    adoptions: [], packages: [], fees: { knownUsd: 0, unknown: 0, active: 0, activeUpperUsd: null }, diagnostics: [],
    canAnalyze: { creative: true, sku_package: true }, stages: (["product", "design"] as const).map(key => ({ key, label: key,
      status: "ready", detail: "ready", issues: [], href: "/sales-plans", action: "open" })) };
  return { detail, launch };
}
describe("bounded sales preparation decisions", () => {
  it("requires actual product and media readiness before creating a draft", () => {
    const { detail, launch } = basis();
    expect(preparationDecision(detail, launch).action).toBe("sync_draft");
    launch.stages[1]!.status = "blocked";
    expect(preparationDecision(detail, launch).action).toBe("blocked");
    launch.stages[1]!.status = "unavailable";
    expect(preparationDecision(detail, launch).ready).toBe(false);
  });
  it("distinguishes ready for review from approved or published and retains every blocker", () => {
    const { detail, launch } = basis();
    detail.listings.push({ id: createEntityId(), versionId: createEntityId(), version: 1, status: "draft",
      title: "Synthetic", marketplaceId: detail.plan.fields.marketplaceId, locale: detail.plan.fields.locale,
      planRevision: 2, completeness: 100, blockers: [] });
    expect(preparationDecision(detail, launch).action).toBe("ready");
    launch.stages[1]!.status = "blocked";
    expect(preparationDecision(detail, launch).steps[3]).toMatchObject({ state: "waiting", detail: "请先补齐上方资料，再核对提交条件" });
    launch.stages[1]!.status = "ready";
    detail.listings[0]!.blockers = ["Missing verified main photo"];
    expect(preparationDecision(detail, launch)).toMatchObject({ action: "review", ready: false, message: "Missing verified main photo" });
    detail.listings[0]!.status = "in_review";
    detail.listings[0]!.planRevision = 1;
    expect(preparationDecision(detail, launch).action).toBe("blocked");
  });
});
