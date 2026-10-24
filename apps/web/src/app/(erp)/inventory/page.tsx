import type { InventoryWorkspaceView } from "@yummyai/contracts/inventory";
import { PackageSearch, ShieldCheck } from "lucide-react";

import { InventoryDailyView } from "../../../features/inventory/inventory-daily-view";
import { parseInventoryWorkspaceResponse } from "../../../features/inventory/inventory-response";
import { apiFetch } from "../../../server-api";

export const dynamic = "force-dynamic";

export default async function InventoryPage() {
  const result = await loadInventoryWorkspace();
  return (
    <div className="research-shell inventory-shell">
      <main className="research-main inventory-main">
        <header className="inventory-header">
          <div>
            <p className="kicker">WAREHOUSE / STOCK LEDGER</p>
            <h1>库存台账</h1>
            <p>按物料、库位和批次核对实物、预占、可用与在途库存，并追溯每一次数量变化。</p>
          </div>
          <div className="inventory-integrity-mark">
            <ShieldCheck size={18} />
            <span><b>账本为准</b>余额可从流水与有效预占重建</span>
          </div>
        </header>

        {"error" in result ? (
          <section className={`inventory-load-state state-${result.kind}`} role="alert">
            <PackageSearch size={20} />
            <div>
              <strong>{result.kind === "unauthorized" ? "库存访问未授权" : result.kind === "forbidden" ? "缺少库存权限" : "库存工作区不可用"}</strong>
              <span>{result.error}</span>
            </div>
          </section>
        ) : <InventoryDailyView data={result.data} />}
      </main>
    </div>
  );
}

async function loadInventoryWorkspace(): Promise<
  | { data: InventoryWorkspaceView; error?: never; kind?: never }
  | { data?: never; error: string; kind: "unauthorized" | "forbidden" | "failed" }
> {
  const apiBase = process.env.API_BASE_URL;
  if (!apiBase) return { error: "尚未配置库存 API。", kind: "failed" };
  try {
    const response = await apiFetch(`${apiBase.replace(/\/$/, "")}/v1/inventory/workspace`, { cache: "no-store" });
    if (!response.ok) {
      if (response.status === 401) return { error: "身份会话无效，请重新登录本地身份服务。", kind: "unauthorized" };
      if (response.status === 403) return { error: "当前成员没有 inventory:read 权限。", kind: "forbidden" };
      return { error: `库存读取失败 (${response.status})。`, kind: "failed" };
    }
    return { data: parseInventoryWorkspaceResponse(await response.json()) };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "库存读取失败。",
      kind: "failed",
    };
  }
}

