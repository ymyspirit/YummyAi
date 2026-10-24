"use client";
import { useEffect, useRef, useState } from "react";
import type {
  SalesPlanDetail,
  SalesPlanList,
  SalesPlanOptions,
} from "@yummyai/contracts/catalog/sales-plan";
import { useErpAccess } from "../identity/erp-access";
import { clearTaskDrafts } from "../navigation/task-draft";
import { salesPlanReadDenied, salesPlanRequest } from "./sales-plan-client";

type Snapshot = {
  key: string;
  options: SalesPlanOptions;
  detail: SalesPlanDetail | null;
  list: SalesPlanList | null;
};
export function useSalesPlanWorkspace(selected: string | null, filterQuery: string) {
  const { authority, localDevelopment, preferenceScope } = useErpAccess();
  const key = selected ? `plan:${selected}` : `list:${filterQuery}`;
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [usable, setUsable] = useState(false),
    [refresh, setRefresh] = useState(0);
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
  const generation = useRef(0);
  useEffect(() => {
    let active: AbortController | null = null;
    const check = async () => {
      const ticket = ++generation.current;
      active?.abort();
      active = new AbortController();
      const abort = active;
      setLoading(true);
      try {
        const [options, result] = await Promise.all([
          salesPlanRequest<SalesPlanOptions>("options", undefined, abort.signal),
          selected
            ? salesPlanRequest<SalesPlanDetail>(selected, undefined, abort.signal)
            : salesPlanRequest<SalesPlanList>(`?${filterQuery}`, undefined, abort.signal),
        ]);
        if (abort.signal.aborted || ticket !== generation.current) return;
        if (
          ![
            options.spus,
            options.specifications,
            options.skus,
            options.artworks,
            options.researchItems,
            options.assets,
            options.projects,
            options.accounts,
          ].every(Array.isArray) ||
          !options.access ||
          typeof options.access.write !== "boolean"
        )
          throw Error("方案选项格式无法核对 请重试读取");
        if (
          !options.preferenceScope ||
          (!localDevelopment &&
            (authority === null ||
              options.contextAuthority !== authority ||
              options.preferenceScope !== preferenceScope))
        ) {
          if (preferenceScope) clearTaskDrafts(`${preferenceScope}:sales-plan`);
          setSnapshot(null);
          setUsable(false);
          setError("当前身份与方案依据已变化 请重新核对当前权限");
          return;
        }
        if (selected && (result as SalesPlanDetail).plan?.id !== selected)
          throw Error("读取结果与当前方案不一致");
        if (
          selected
            ? !Array.isArray((result as SalesPlanDetail).listings)
            : !Array.isArray((result as SalesPlanList).items)
        )
          throw Error("方案记录格式无法核对 请重试读取");
        setSnapshot({
          key,
          options,
          detail: selected ? (result as SalesPlanDetail) : null,
          list: selected ? null : (result as SalesPlanList),
        });
        setUsable(true);
        setError("");
      } catch (error) {
        if (abort.signal.aborted || ticket !== generation.current) return;
        if (salesPlanReadDenied(error)) {
          const scope = preferenceScope ?? snapshotRef.current?.options.preferenceScope;
          if (scope && selected) clearTaskDrafts(`${scope}:sales-plan:${selected}`);
          setSnapshot(null);
        }
        setUsable(false);
        setError(error instanceof Error ? error.message : "销售方案暂时无法核对 请重试");
      } finally {
        if (!abort.signal.aborted && ticket === generation.current) setLoading(false);
      }
    };
    const shown = () => {
      if (document.visibilityState !== "hidden") void check();
    };
    shown();
    const timer = window.setInterval(shown, 30000);
    window.addEventListener("focus", shown);
    window.addEventListener("pageshow", shown);
    document.addEventListener("visibilitychange", shown);
    return () => {
      generation.current++;
      active?.abort();
      window.clearInterval(timer);
      window.removeEventListener("focus", shown);
      window.removeEventListener("pageshow", shown);
      document.removeEventListener("visibilitychange", shown);
    };
  }, [key, selected, filterQuery, refresh, authority, localDevelopment, preferenceScope]);
  const current = snapshot?.key === key ? snapshot : null;
  return {
    options: current?.options ?? null,
    detail: current?.detail ?? null,
    list: current?.list ?? null,
    loading,
    error,
    usable: Boolean(current && usable),
    retry: () => setRefresh((value) => value + 1),
  };
}
