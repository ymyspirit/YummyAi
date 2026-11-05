"use client";

import { createEntityId } from "@yummyai/contracts/common/ids";
import { OrderSyncSettingsViewSchema, type OrderSyncSettingsView } from "@yummyai/contracts/order/sync";
import { RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { readMarketplaceJson } from "./marketplace-lifecycle";

export function OrderSyncSettings({ accountId, contextAuthority, sourceBusy, onDenied }: {
  accountId: string; contextAuthority: string; sourceBusy: boolean; onDenied(): void;
}) {
  const [view, setView] = useState<OrderSyncSettingsView | null>(null), [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("正在读取自动拉单设置");
  const active = useRef<AbortController | null>(null), alive = useRef(true);
  const denied = useRef(onDenied); denied.current = onDenied;
  const current = useRef(view); current.current = view;
  const load = useCallback(async (enabled?: boolean) => {
    if (active.current || sourceBusy) return;
    if (enabled !== undefined && !current.current) return;
    const controller = new AbortController(); active.current = controller; setBusy(true);
    try {
      const response = await fetch(`/api/marketplace-accounts/${accountId}/order-sync`, { method: enabled === undefined ? "GET" : "POST", cache: "no-store",
        signal: controller.signal, headers: { "x-yummyai-context-authority": contextAuthority, ...(enabled === undefined ? {} : { "content-type": "application/json" }) },
        ...(enabled === undefined ? {} : { body: JSON.stringify({ requestKey: createEntityId(), expectedVersion: current.current!.version, enabled }) }) });
      if (!alive.current || controller.signal.aborted) return;
      if (response.status === 401 || response.status === 403) { denied.current(); return; }
      if (!response.ok || response.headers.get("x-yummyai-context-authority") !== contextAuthority) throw new Error("unverified");
      const result = OrderSyncSettingsViewSchema.parse(await readMarketplaceJson(response, 8192));
      if (result.accountId !== accountId) throw new Error("account_changed");
      if (alive.current && !controller.signal.aborted) { setView(result); setNotice(enabled === undefined ? "" : "设置已保存"); }
    } catch {
      if (alive.current && !controller.signal.aborted) { setView(null); setNotice(enabled === undefined ? "自动拉单状态暂时无法读取 请重试" : "保存结果暂未核对 请重新读取状态后操作"); }
    } finally { if (active.current === controller) { active.current = null; if (alive.current) setBusy(false); } }
  }, [accountId, contextAuthority, sourceBusy]);
  useEffect(() => { alive.current = true; void load(); return () => { alive.current = false; active.current?.abort(); active.current = null; }; }, [load]);
  return <section className="store-lifecycle" aria-label="自动拉单" aria-busy={busy}>
    <header><h2>自动拉单 · {view ? view.enabled ? "已启用" : "未启用" : "待核对"}</h2>
      <button disabled={busy || sourceBusy} onClick={() => void load()}><RefreshCw size={15} />重新读取拉单状态</button></header>
    <p className="store-lifecycle-note">启用一次后约每 5 分钟检查订单 初次读取近 7 天 已有订单按平台编号更新 新订单进入统一工作台待审单</p>
    {view?.reason && <p className="store-lifecycle-risk" role="status">{view.reason}</p>}
    {view && <p>{view.activeExecutionId ? "正在读取本店订单" : view.nextRunAt ? `下次检查 ${new Date(view.nextRunAt).toLocaleString("zh-CN")}` : "尚未安排下一次读取"}
      {view.canManage && (view.supported || view.enabled) && <button disabled={busy || sourceBusy || !view.enabled && !view.canEnable} onClick={() => void load(!view.enabled)}>{view.enabled ? "暂停自动拉单" : "启用自动拉单"}</button>}
      {!view.canManage && " · 由店铺管理员统一设置"}</p>}
    <p role="status" aria-live="polite">{notice}</p>
  </section>;
}
