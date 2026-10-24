"use client";
import { useEffect, useRef, useState } from "react";
import type {
  SalesPlanFields,
  SalesPlanOptions,
  SalesPlanReferenceOptions,
} from "@yummyai/contracts/catalog/sales-plan";
import { salesPlanReadDenied, salesPlanRequest } from "./sales-plan-client";
import { salesPlanReferenceSelection } from "./sales-plan-references";

type State = {
  key: string;
  basis: SalesPlanOptions;
  options: SalesPlanOptions | null;
  error: string;
};
export function useSalesPlanReferences(
  planId: string,
  spuId: string,
  fields: SalesPlanFields,
  basis: SalesPlanOptions,
  recheck: () => void,
) {
  const selection = salesPlanReferenceSelection(fields),
    signature = JSON.stringify(selection),
    key = `${planId}:${basis.contextAuthority}:${signature}`,
    hasReferences = Object.values(selection).some((v) =>
      Array.isArray(v) ? v.length > 0 : v !== null,
    );
  const [state, setState] = useState<State | null>(null),
    [attempt, setAttempt] = useState(0);
  const deniedKey = useRef<string | null>(null),
    callback = useRef(recheck);
  callback.current = recheck;
  useEffect(() => {
    if (!hasReferences) return;
    const abort = new AbortController();
    setState({ key, basis, options: null, error: "" });
    const timer = window.setTimeout(() => {
      void salesPlanRequest<SalesPlanReferenceOptions>(
        `${planId}/reference-options`,
        JSON.parse(signature),
        abort.signal,
      )
        .then((result) => {
          if (abort.signal.aborted) return;
          if (
            result.planId !== planId ||
            result.spuId !== spuId ||
            result.contextAuthority !== basis.contextAuthority ||
            result.preferenceScope !== basis.preferenceScope ||
            JSON.stringify(result.selection) !== signature ||
            ![
              result.specifications,
              result.skus,
              result.artworks,
              result.researchItems,
              result.assets,
              result.projects,
              result.accounts,
            ].every(Array.isArray)
          )
            throw Error("关联资料与当前方案或权限不一致 请重新核对");
          deniedKey.current = null;
          setState({ key, basis, options: result, error: "" });
        })
        .catch((error) => {
          if (abort.signal.aborted) return;
          setState({
            key,
            basis,
            options: null,
            error: "关联资料暂时无法核对 已有输入已保留 请重试核对",
          });
          if (salesPlanReadDenied(error) && deniedKey.current !== key) {
            deniedKey.current = key;
            callback.current();
          }
        });
    }, 180);
    return () => {
      window.clearTimeout(timer);
      abort.abort();
    };
  }, [planId, spuId, signature, key, basis, hasReferences, attempt]);
  const current = state?.key === key && state.basis === basis ? state : null;
  return {
    options: hasReferences ? (current?.options ?? basis) : basis,
    ready: !hasReferences || Boolean(current?.options),
    checking: hasReferences && !current?.options && !current?.error,
    error: hasReferences ? (current?.error ?? "") : "",
    retry: () => setAttempt((value) => value + 1),
  };
}
