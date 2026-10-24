import {
  IntegrationWorkspaceViewSchema,
  type IntegrationWorkspaceView,
} from "@yummyai/contracts/integration";
import {
  PlanningWorkspaceViewSchema,
  type PlanningWorkspaceView,
} from "@yummyai/contracts/planning";
import { Activity, ShieldAlert } from "lucide-react";

import { OperatingCockpit } from "../../../features/operating-cockpit/operating-cockpit";
import { apiFetch } from "../../../server-api";
import { erpAmbientIdentity } from "../../../erp-auth/request";
import { assertErpIdentityCurrent } from "../../../erp-auth/server";
import { erpSessionAuthority } from "@yummyai/contracts/auth/session";
import { authorize } from "@yummyai/authz/authorize";
import { Permission } from "@yummyai/authz/permissions";
import { PersonalSessionError } from "../../../identity/core";

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
  try {
    const identity = await erpAmbientIdentity();
    try { authorize(identity.view, Permission.IntegrationRead); } catch { return { error: "当前成员没有开放集成读取权限", kind: "forbidden" }; }
    const base = process.env.API_BASE_URL?.replace(/\/$/, ""); if (!base) return { error: "尚未配置运营 API", kind: "failed" };
    const response = await apiFetch(base + "/v1/integrations/workspace", { cache: "no-store", signal: AbortSignal.timeout(20_000) });
    if (!response.ok) { await response.body?.cancel(); return { error: response.status === 401 ? "请重新登录自己的运营账户" : response.status === 403 ? "当前成员没有开放集成读取权限" : "开放集成工作区暂时无法读取", kind: response.status === 401 ? "unauthorized" : response.status === 403 ? "forbidden" : "failed" }; }
    const reader = response.body?.getReader(); if (!reader) throw new Error("body"); let size = 0; const chunks: Uint8Array[] = [];
    try { for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > 8 * 1024 * 1024) { await reader.cancel(); throw new Error("size"); } chunks.push(part.value); } } finally { reader.releaseLock(); }
    const data = IntegrationWorkspaceViewSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))));
    await assertErpIdentityCurrent(identity); const authority = erpSessionAuthority(identity.view);
    if (data.contextAuthority !== authority || data.agentCatalog.contextAuthority !== authority) throw new Error("authority");
    return { data };
  } catch (error) { return { error: error instanceof PersonalSessionError && error.status === 401 ? "请重新登录自己的运营账户" : "当前开放集成资料与权限尚未核对 请刷新重读", kind: error instanceof PersonalSessionError && error.status === 401 ? "unauthorized" : "failed" }; }
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
  } catch {
    return { error: "工作区读取失败 请核对当前权限后重读", kind: "failed" };
  }
}
