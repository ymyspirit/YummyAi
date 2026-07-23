import type { InventoryWorkspaceView } from "@yummyai/contracts";
import { PackageSearch, ShieldCheck } from "lucide-react";

import { InventoryWorkspace } from "../../../features/inventory/inventory-workspace";
import { ErpSidebar } from "../../../features/navigation/erp-sidebar";
import { apiFetch } from "../../../server-api";

export const dynamic = "force-dynamic";

export default async function InventoryPage() {
  const result = await loadInventoryWorkspace();
  return (
    <div className="research-shell inventory-shell">
      <ErpSidebar
        active="inventory"
        contextLabel="INVENTORY LEDGER"
        note="数量来自不可变库存流水；余额是可重建投影，缺失事实不会被推测或补零。"
      />
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
        ) : <InventoryWorkspace data={result.data} />}
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
    return { data: parseInventoryWorkspace(await response.json()) };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "库存读取失败。",
      kind: "failed",
    };
  }
}

function parseInventoryWorkspace(value: unknown): InventoryWorkspaceView {
  if (!isRecord(value)) throw new TypeError("库存 API 返回了无效的数据结构。");
  const collectionKeys = [
    "warehouses",
    "locations",
    "stockItems",
    "lots",
    "balances",
    "reservations",
    "transfers",
    "movements",
  ] as const;
  for (const key of collectionKeys) {
    if (!Array.isArray(value[key])) throw new TypeError(`库存 API 缺少 ${key} 集合。`);
  }
  const balances = value.balances as unknown[];
  const movements = value.movements as unknown[];
  for (const [index, balance] of balances.entries()) {
    if (!isRecord(balance) || typeof balance.stockItemId !== "string" ||
      typeof balance.locationId !== "string" || typeof balance.physicalQuantity !== "number" ||
      typeof balance.reservedQuantity !== "number" || typeof balance.availableQuantity !== "number" ||
      typeof balance.inTransitQuantity !== "number" || typeof balance.unit !== "string") {
      throw new TypeError(`库存余额第 ${index + 1} 条记录无效。`);
    }
  }
  for (const [index, movement] of movements.entries()) {
    if (!isRecord(movement) || typeof movement.id !== "string" ||
      typeof movement.stockItemId !== "string" || typeof movement.locationId !== "string" ||
      typeof movement.quantityDelta !== "number" || typeof movement.occurredAt !== "string") {
      throw new TypeError(`库存流水第 ${index + 1} 条记录无效。`);
    }
  }
  for (const item of collectionKeys.flatMap((key) => value[key])) {
    if (!isRecord(item)) throw new TypeError("库存 API 返回了无效的记录。");
    for (const protectedKey of ["tenantId", "createdBy", "recordedBy", "idempotencyKey"]) {
      if (protectedKey in item) throw new TypeError("库存 API 返回了内部租户或幂等字段。");
    }
  }
  return value as InventoryWorkspaceView;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
