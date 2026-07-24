import {
  IntegrationWorkspaceViewSchema,
  type IntegrationWorkspaceView,
} from "@yummyai/contracts/integration";
import {
  PlanningWorkspaceViewSchema,
  type PlanningWorkspaceView,
} from "@yummyai/contracts/planning";
import { Activity, ShieldAlert } from "lucide-react";

import { ErpSidebar } from "../../../features/navigation/erp-sidebar";
import { OperatingCockpit } from "../../../features/operating-cockpit/operating-cockpit";
import { apiFetch } from "../../../server-api";

export const dynamic = "force-dynamic";

type LoadFailure = {
  error: string;
  kind: "unauthorized" | "forbidden" | "failed";
};

export default async function OperatingCockpitPage() {
  const [planning, integration] = await Promise.all([
    loadPlanningWorkspace(),
    loadIntegrationWorkspace(),
  ]);
  const failures = [
    "error" in planning ? { ...planning, label: "预测与指标" } : null,
    "error" in integration ? { ...integration, label: "开放集成" } : null,
  ].filter((failure): failure is LoadFailure & { label: string } => failure !== null);

  return (
    <div className="research-shell operating-cockpit-shell">
      <ErpSidebar
        active="operating-cockpit"
        contextLabel="FORECAST / CONTROL"
        note="预测、指标快照、对账与 Webhook 投递都保留固定输入、版本和可下钻证据。"
      />
      <main className="research-main operating-cockpit-main">
        <header className="operating-cockpit-header">
          <div>
            <p className="kicker">FORECAST / FRESHNESS / DELIVERY CONTROL</p>
            <h1>运营驾驶舱</h1>
            <p>核对预测输入与准确度，追踪指标新鲜度、对账队列和签名事件投递。</p>
          </div>
          <div className="operating-cockpit-integrity">
            <Activity size={18} />
            <span><b>证据优先</b>每个信号都指向固定版本或不可变记录</span>
          </div>
        </header>

        {failures.length ? (
          <section className="operating-cockpit-load-state" role="alert">
            <ShieldAlert size={20} />
            <div>
              <strong>{failures.length === 2 ? "运营驾驶舱不可用" : "运营驾驶舱部分可用"}</strong>
              {failures.map((failure) => (
                <span key={failure.label}>{failure.label}：{failure.error}</span>
              ))}
            </div>
          </section>
        ) : null}

        <OperatingCockpit
          planning={"data" in planning ? planning.data : null}
          integration={"data" in integration ? integration.data : null}
        />
      </main>
    </div>
  );
}

async function loadPlanningWorkspace(): Promise<{ data: PlanningWorkspaceView } | LoadFailure> {
  return loadWorkspace("planning", PlanningWorkspaceViewSchema, "operations:read");
}

async function loadIntegrationWorkspace(): Promise<{ data: IntegrationWorkspaceView } | LoadFailure> {
  return loadWorkspace("integrations", IntegrationWorkspaceViewSchema, "integration:read");
}

async function loadWorkspace<T>(
  endpoint: string,
  schema: { parse(value: unknown): T },
  permission: string,
): Promise<{ data: T } | LoadFailure> {
  const apiBase = process.env.API_BASE_URL;
  if (!apiBase) return { error: "尚未配置运营 API。", kind: "failed" };
  try {
    const response = await apiFetch(`${apiBase.replace(/\/$/, "")}/v1/${endpoint}/workspace`, {
      cache: "no-store",
    });
    if (response.status === 401) return { error: "身份会话无效，请重新登录本地身份服务。", kind: "unauthorized" };
    if (response.status === 403) return { error: `当前成员没有 ${permission} 权限。`, kind: "forbidden" };
    if (!response.ok) return { error: `工作区读取失败 (${response.status})。`, kind: "failed" };
    return { data: schema.parse(await response.json()) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "工作区读取失败。", kind: "failed" };
  }
}
