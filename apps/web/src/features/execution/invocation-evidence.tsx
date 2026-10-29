"use client";
import { useId, useState } from "react";
import { ChevronDown, FileDown, ListTree } from "lucide-react";
import Link from "next/link";
import {
  HarnessInvocationViewSchema,
  type HarnessInvocationView,
} from "@yummyai/contracts/harness";
import "./invocation-evidence.css";
import { ModelTokenUsageLine } from "../ai-assist/model-usage-summary";

const boundaryNames = {
  legacy_missing: "历史提交证据缺失",
  not_submitted: "尚未提交",
  submitted: "已记录提交边界",
  received: "已保存响应回执",
  owner_receipt: "已核对业务回执",
  delegated_task: "已关联原子任务",
};
const stateNames = {
  queued: "排队中",
  running: "处理中",
  waiting: "等待子任务",
  completed: "技术处理完成",
  failed: "执行未完成",
  cancelled: "已取消",
  uncertain: "原请求待核对",
};
const costNames = {
  configured_rate: "按配置估算",
  processor_reported: "处理服务报告",
  unknown: "费用未知",
  not_submitted: "尚未提交渠道",
  not_applicable: "本步骤未记录外部费用",
};
const issueNames = {
  legacy_execution_missing: "历史记录缺少调用证据",
  execution_contract_unavailable: "原记录未提供方法或工具版本",
  receipt_unavailable: "业务回执暂不可读取",
  submission_unknown: "需核对原请求 避免重复提交",
  cost_unknown: "原报告缺少费用依据 未补证时不按零费用处理",
  linked_owner_unavailable: "关联业务记录不可读取或当前权限不足",
  response_metadata_invalid: "响应计价或模型元数据不完整",
  ambiguous_budget: "预算记录存在歧义 需人工核对",
};

export function InvocationEvidence({ entries }: { entries?: HarnessInvocationView[] }) {
  const [open, setOpen] = useState(false),
    [notice, setNotice] = useState("");
  const id = useId();
  function download() {
    if (!entries?.length) return;
    try {
      const invocations = entries.map((entry) => HarnessInvocationViewSchema.parse(entry));
      const bytes = JSON.stringify(
        {
          version: "harness-reconciliation-handoff-v1",
          exportedAt: new Date().toISOString(),
          providerInvoiceVerified: false,
          verificationMode: "operator_attestation_only",
          invocations,
        },
        null,
        2,
      );
      const url = URL.createObjectURL(new Blob([bytes], { type: "application/json" }));
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `execution-evidence-${entries[0]!.id}.json`;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setNotice("已下载本次核对记录");
    } catch {
      setNotice("核对记录下载失败 请刷新后重试");
    }
  }
  return (
    <section className="invocation-evidence" aria-label="调用与费用记录">
      <button
        type="button"
        className="invocation-disclosure"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((value) => !value)}
      >
        <ListTree size={14} />
        <span>调用与费用记录</span>
        <ChevronDown size={14} />
      </button>
      <div
        className="invocation-collapse"
        data-open={open}
        inert={!open}
        aria-hidden={!open}
        id={id}
      >
        <div>
          {!entries?.length ? (
            <p>这条记录尚未提供调用证据 请核对原任务</p>
          ) : (
            <>
              <ol>
                {entries.map((entry) => (
                  <li key={entry.id}>
                    <header>
                      <strong>
                        {
                          { assist: "AI 辅助", workflow: "工作流步骤", pod: "POD 处理" }[
                            entry.owner
                          ]
                        }
                      </strong>
                      <span>{stateNames[entry.state]}</span>
                    </header>
                    <p>
                      {boundaryNames[entry.boundary]}
                      {entry.dispatches !== null ? ` · 派发 ${entry.dispatches} 次` : ""}
                      {entry.processingAttempts !== null
                        ? ` · 本地处理 ${entry.processingAttempts} 次`
                        : ""}
                    </p>
                    <dl>
                      <div>
                        <dt>原请求</dt>
                        <dd>{entry.requestId ?? "未记录"}</dd>
                      </div>
                      {entry.parentId && (
                        <div>
                          <dt>父步骤</dt>
                          <dd>{entry.parentId}</dd>
                        </div>
                      )}
                      {entry.tool && (
                        <div>
                          <dt>工具</dt>
                          <dd>
                            {entry.tool.key} · {entry.tool.version}
                          </dd>
                        </div>
                      )}
                      {entry.method && (
                        <div>
                          <dt>方法</dt>
                          <dd>
                            {entry.method.key} · {entry.method.version}
                          </dd>
                        </div>
                      )}
                      {entry.model && (
                        <div>
                          <dt>模型</dt>
                          <dd>
                            {entry.model.key}
                            {entry.model.version ? ` · ${entry.model.version}` : ""}
                          </dd>
                        </div>
                      )}
                      {entry.providerRequestId && (
                        <div>
                          <dt>渠道请求号</dt>
                          <dd>{entry.providerRequestId}</dd>
                        </div>
                      )}
                      {entry.receivedAt && (
                        <div>
                          <dt>响应时间</dt>
                          <dd>{new Date(entry.receivedAt).toLocaleString("zh-CN")}</dd>
                        </div>
                      )}
                      {entry.responseChecksum && (
                        <div>
                          <dt>响应校验值</dt>
                          <dd>{entry.responseChecksum}</dd>
                        </div>
                      )}
                      {entry.artifact && (
                        <div>
                          <dt>
                            {entry.artifact.kind === "owner_receipt" ? "业务回执" : "产物版本"}
                          </dt>
                          <dd>{entry.artifact.id}</dd>
                        </div>
                      )}
                    </dl>
                    <p className="invocation-cost">
                      {costNames[entry.billing.basis]}
                      {entry.billing.amountUsd !== null ? ` $${entry.billing.amountUsd}` : ""}
                    </p>
                    {entry.billing.budgetState && (
                      <p>
                        预算
                        {
                          { reserved: "预留中", committed: "已计入", released: "已释放" }[
                            entry.billing.budgetState
                          ]
                        }
                        {entry.billing.budgetAmountUsd !== null
                          ? ` · $${entry.billing.budgetAmountUsd}`
                          : ""}
                      </p>
                    )}
                    {(entry.model || Object.values(entry.usage).some(value => value != null)) && <ModelTokenUsageLine usage={entry.usage} className="invocation-muted" />}
                    {entry.billing.needsProviderEvidence && (
                      <p className="invocation-muted">费用需结合渠道原请求及账单核对</p>
                    )}
                    {entry.billing.reconciliation && <p className="invocation-cost">人工核对 ${entry.billing.reconciliation.amountUsd} · 第 {entry.billing.reconciliation.sequence} 次 · {new Date(entry.billing.reconciliation.checkedAt).toLocaleString("zh-CN")}</p>}
                    {entry.owner !== "workflow" && !["queued","running"].includes(entry.state) && entry.boundary !== "not_submitted" && <Link className="invocation-billing-link" href={`/model-billing?owner=${entry.owner}&id=${entry.id}`}>查看或补充人工费用核对</Link>}
                    {entry.boundary === "delegated_task" && (
                      <p className="invocation-muted">
                        委派步骤的费用查看子任务记录 各记录不重复相加
                      </p>
                    )}
                    {!!entry.issues.length && (
                      <ul className="invocation-issues">
                        {entry.issues.map((issue) => (
                          <li key={issue}>{issueNames[issue]}</li>
                        ))}
                      </ul>
                    )}
                  </li>
                ))}
              </ol>
              <p className="invocation-muted">
                派发和本地恢复次数不等于渠道扣费次数 此处只展示已保存的执行证据
              </p>
              <button type="button" className="invocation-download" onClick={download}>
                <FileDown size={14} />
                下载核对记录
              </button>
              {notice && <p role="status">{notice}</p>}
            </>
          )}
        </div>
      </div>
    </section>
  );
}
