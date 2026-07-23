import {
  ChannelInventoryWorkspaceViewSchema,
  type ChannelInventoryWorkspaceView,
} from "@yummyai/contracts/channel-inventory";
import { Network, ShieldAlert } from "lucide-react";

import { ChannelInventoryWorkspace } from "../../../features/channel-inventory/channel-inventory-workspace";
import { ErpSidebar } from "../../../features/navigation/erp-sidebar";
import { apiFetch } from "../../../server-api";

export const dynamic = "force-dynamic";

export default async function ChannelInventoryPage() {
  const result = await loadChannelInventoryWorkspace();
  return (
    <div className="research-shell channel-inventory-shell">
      <ErpSidebar
        active="channel-inventory"
        contextLabel="CHANNEL AVAILABILITY"
        note="渠道可售量来自库存快照与已锁定策略版本；新证据到达后必须重新计算。"
      />
      <main className="research-main channel-inventory-main">
        <header className="channel-inventory-header">
          <div>
            <p className="kicker">NETWORK STOCK / CHANNEL ALLOCATION</p>
            <h1>渠道库存</h1>
            <p>区分自有、FBA、FBM、海外仓、在途、隔离、损坏和虚拟库存，并核对每个店铺的可售上限。</p>
          </div>
          <div className="channel-inventory-integrity-mark">
            <Network size={18} />
            <span><b>投影有据</b>来源快照、策略版本与渠道结果可逐层追溯</span>
          </div>
        </header>

        {"error" in result ? (
          <section className={`channel-inventory-load-state state-${result.kind}`} role="alert">
            <ShieldAlert size={20} />
            <div>
              <strong>{result.kind === "unauthorized" ? "渠道库存访问未授权" : result.kind === "forbidden" ? "缺少渠道库存权限" : "渠道库存工作区不可用"}</strong>
              <span>{result.error}</span>
            </div>
          </section>
        ) : <ChannelInventoryWorkspace data={result.data} />}
      </main>
    </div>
  );
}

async function loadChannelInventoryWorkspace(): Promise<
  | { data: ChannelInventoryWorkspaceView; error?: never; kind?: never }
  | { data?: never; error: string; kind: "unauthorized" | "forbidden" | "failed" }
> {
  const apiBase = process.env.API_BASE_URL;
  if (!apiBase) return { error: "尚未配置渠道库存 API。", kind: "failed" };
  try {
    const response = await apiFetch(`${apiBase.replace(/\/$/, "")}/v1/channel-inventory/workspace`, {
      cache: "no-store",
    });
    if (!response.ok) {
      if (response.status === 401) return { error: "身份会话无效，请重新登录本地身份服务。", kind: "unauthorized" };
      if (response.status === 403) return { error: "当前成员没有 channel_inventory:read 权限。", kind: "forbidden" };
      return { error: `渠道库存读取失败 (${response.status})。`, kind: "failed" };
    }
    return { data: ChannelInventoryWorkspaceViewSchema.parse(await response.json()) };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "渠道库存读取失败。",
      kind: "failed",
    };
  }
}
