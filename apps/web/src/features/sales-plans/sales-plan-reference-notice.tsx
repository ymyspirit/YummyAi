import { AlertCircle, LoaderCircle } from "lucide-react";
import { flushSync } from "react-dom";
import { observeViewTransition } from "../navigation/view-transition";
import type { SalesPlanReferenceIssue } from "./sales-plan-references";

export function SalesPlanReferenceNotice({
  checking,
  error,
  issues,
  disabled,
  retry,
  remove,
}: {
  checking: boolean;
  error: string;
  issues: SalesPlanReferenceIssue[];
  disabled: boolean;
  retry: () => void;
  remove: (issue: SalesPlanReferenceIssue) => void;
}) {
  if (!checking && !error && !issues.length) return null;
  return (
    <section className="sp-reference-checks" aria-label="关联资料核对">
      {checking ? (
        <p role="status">
          <LoaderCircle size={16} className="sp-reference-loading" />
          正在核对关联资料
        </p>
      ) : error ? (
        <div role="alert">
          <p>
            <AlertCircle size={16} />
            {error}
          </p>
          <button type="button" className="oc-button" onClick={retry}>
            重试核对关联资料
          </button>
        </div>
      ) : (
        <>
          <h3>
            <AlertCircle size={16} />
            关联资料需要核对
          </h3>
          <p>以下原关联当前不可用于此方案 已保留原编号 请更换或明确移除后再保存和同步</p>
          <ul>
            {issues.map((issue) => (
              <li key={`${issue.kind}:${issue.id}`}>
                <div>
                  <strong>{issue.label}</strong>
                  <code>{issue.id}</code>
                  {issue.usages?.length ? <small>{issue.usages.join(" · ")}</small> : null}
                </div>
                <button
                  type="button"
                  className="oc-button"
                  disabled={disabled}
                  aria-label={`移除${issue.label}关联 ${issue.id}`}
                  onClick={() => {
                    const update = () => remove(issue);
                    if (
                      typeof document.startViewTransition === "function" &&
                      !window.matchMedia("(prefers-reduced-motion: reduce)").matches
                    )
                      observeViewTransition(document.startViewTransition(() => flushSync(update)));
                    else update();
                  }}
                >
                  {issue.kind === "asset"
                    ? "移除此素材的全部关联"
                    : issue.kind === "sku"
                      ? "移除 SKU 及选款配置"
                      : "移除关联"}
                </button>
              </li>
            ))}
          </ul>
          {disabled && <small>当前内容仅可查看 请由有方案编辑权限的人员处理</small>}
        </>
      )}
    </section>
  );
}
