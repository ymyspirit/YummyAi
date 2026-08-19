import {
  WorkflowDefinitionListSchema,
  WorkflowRunListSchema,
  type WorkflowDefinitionSummary,
  type WorkflowRunSummary,
} from "@yummyai/contracts/workflow";

import { ErpSidebar } from "../../../features/navigation/erp-sidebar";
import { WorkflowCenter } from "../../../features/workflows/workflow-center";
import { apiFetch } from "../../../server-api";

export const dynamic = "force-dynamic";

interface ProductPlanChoice { id: string; name: string; status: string }

export default async function WorkflowsPage() {
  const result = await loadWorkspace();
  return (
    <div className="research-shell workflow-shell">
      <ErpSidebar
        active="workflows"
        contextLabel="WORKFLOW OPS"
        note="模板版本固定、证据逐步交接；已完成任务仍可补充说明并留下审计事件。"
      />
      <main className="research-main workflow-main">
        <WorkflowCenter {...result} />
      </main>
    </div>
  );
}

async function loadWorkspace(): Promise<{
  definitions: WorkflowDefinitionSummary[];
  runs: WorkflowRunSummary[];
  plans: ProductPlanChoice[];
  error?: string;
}> {
  const apiBase = process.env.API_BASE_URL;
  if (!apiBase) return { definitions: [], runs: [], plans: [], error: "API_BASE_URL 未配置。" };
  const base = apiBase.replace(/\/$/, "");
  try {
    const [definitionsResponse, runsResponse, plansResponse] = await Promise.all([
      apiFetch(`${base}/v1/workflows/definitions`, { cache: "no-store" }),
      apiFetch(`${base}/v1/workflow-runs`, { cache: "no-store" }),
      apiFetch(`${base}/v1/products/plans`, { cache: "no-store" }),
    ]);
    if (!definitionsResponse.ok || !runsResponse.ok) {
      const status = !definitionsResponse.ok ? definitionsResponse.status : runsResponse.status;
      return {
        definitions: [],
        runs: [],
        plans: [],
        error: status === 403 ? "当前成员缺少 workflow:read 权限。" : `工作流中心读取失败 (${status})。`,
      };
    }
    const definitions = WorkflowDefinitionListSchema.parse(await definitionsResponse.json()).items;
    const runs = WorkflowRunListSchema.parse(await runsResponse.json()).items;
    const planPayload = plansResponse.ok ? await plansResponse.json() : [];
    return { definitions, runs, plans: productPlanChoices(planPayload) };
  } catch (error) {
    return {
      definitions: [],
      runs: [],
      plans: [],
      error: error instanceof Error ? error.message : "工作流中心读取失败。",
    };
  }
}

function productPlanChoices(value: unknown): ProductPlanChoice[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    return typeof record.id === "string" && typeof record.name === "string" && typeof record.status === "string"
      ? [{ id: record.id, name: record.name, status: record.status }]
      : [];
  });
}
