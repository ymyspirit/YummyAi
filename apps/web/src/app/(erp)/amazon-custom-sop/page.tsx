import { WorkflowRunDetailSchema } from "@yummyai/contracts/workflow";
import { redirect } from "next/navigation";

import { apiFetch } from "../../../server-api";

export const dynamic = "force-dynamic";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function LegacyAmazonCustomSopPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const planId = typeof params.plan === "string" ? params.plan : undefined;
  if (planId) {
    const runId = await migratedRunId(planId);
    if (runId) redirect(`/workflows/runs/${runId}`);
  }
  redirect("/workflows");
}

async function migratedRunId(productPlanId: string) {
  const apiBase = process.env.API_BASE_URL;
  if (!apiBase) return undefined;
  try {
    const response = await apiFetch(`${apiBase.replace(/\/$/, "")}/v1/workflow-runs/by-plan/${encodeURIComponent(productPlanId)}`, { cache: "no-store" });
    if (!response.ok) return undefined;
    return WorkflowRunDetailSchema.parse(await response.json()).id;
  } catch {
    return undefined;
  }
}
