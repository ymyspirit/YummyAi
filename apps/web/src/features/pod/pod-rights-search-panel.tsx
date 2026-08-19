"use client";

import type { PodTaskInputOptionsView } from "@yummyai/contracts/pod";
import { BadgeCheck, CircleAlert, LoaderCircle, Scale, Search, ShieldAlert } from "lucide-react";
import { useActionState } from "react";
import { useFormStatus } from "react-dom";

import {
  runPodVisualSearch,
  type PodVisualSearchActionState,
} from "./pod-governance-actions";

const idle: PodVisualSearchActionState = { message: "", status: "idle" };

export function PodRightsSearchPanel({ error, options }: { error?: string; options?: PodTaskInputOptionsView }) {
  const [state, action] = useActionState(runPodVisualSearch, idle);
  const assets = options?.assets ?? [];
  return (
    <section className="pod-governance-panel pod-rights-console" aria-labelledby="pod-rights-search-title">
      <header>
        <div><p>VISUAL EVIDENCE</p><h3 id="pod-rights-search-title">视觉相似度检索</h3></div>
        <span>LEGAL RISK ≠ SIMILARITY</span>
      </header>
      <div className="pod-risk-separation">
        <div><Scale size={15} /><span><b>法律风险</b>商标、TRO、版权与许可证据进入单独评估。</span></div>
        <div><Search size={15} /><span><b>视觉相似度</b>仅表示指纹接近程度，不是侵权法律结论。</span></div>
      </div>
      {error ? <p className="pod-governance-error"><CircleAlert size={14} />{error}</p> : null}
      {!error ? (
        <form action={action} className="pod-visual-search-form">
          <label><span>查询资产 *</span><select disabled={!assets.length} name="assetSelection" onChange={(event) => selectAsset(event.currentTarget)} required><option value="">{assets.length ? "选择已索引资产" : "暂无可检索资产"}</option>{assets.map((asset) => <option key={asset.id} value={`${asset.id}:${asset.version}`}>{asset.fileName} · {asset.domain === "research" ? "研究域" : "授权域"} · V{asset.version}</option>)}</select></label>
          <input name="assetId" type="hidden" />
          <input name="assetVersion" type="hidden" />
          <label><span>结果资产域</span><select name="domain"><option value="all">全部域（分开标记）</option><option value="authorized">仅授权域</option><option value="research">仅研究域</option></select></label>
          <label><span>汉明距离上限</span><input defaultValue={16} max={512} min={0} name="maxHammingDistance" required type="number" /></label>
          <label><span>结果数量</span><input defaultValue={20} max={100} min={1} name="limit" required type="number" /></label>
          <footer><VisualSearchNotice state={state} /><VisualSearchButton disabled={!assets.length} /></footer>
        </form>
      ) : null}
      {state.hits ? <VisualSearchResults state={state} /> : null}
    </section>
  );
}

function selectAsset(select: HTMLSelectElement) {
  const form = select.form;
  if (!form) return;
  const separator = select.value.lastIndexOf(":");
  const id = separator > 0 ? select.value.slice(0, separator) : "";
  const version = separator > 0 ? select.value.slice(separator + 1) : "";
  const assetId = form.elements.namedItem("assetId");
  const assetVersion = form.elements.namedItem("assetVersion");
  if (assetId instanceof HTMLInputElement) assetId.value = id;
  if (assetVersion instanceof HTMLInputElement) assetVersion.value = version;
}

function VisualSearchResults({ state }: { state: PodVisualSearchActionState }) {
  return (
    <div className="pod-visual-results">
      <header><ShieldAlert size={14} /><strong>相似度证据</strong><code>{short(state.queryFingerprintId)}</code></header>
      {!state.hits?.length ? <p>当前阈值内没有匹配项。可调整资产域或距离阈值后重新检索。</p> : (
        <ol>{state.hits.map((hit) => <li key={hit.fingerprintId}><span className={`pod-domain-tag ${hit.assetDomain}`}>{hit.assetDomain === "authorized" ? "授权域" : "研究域"}</span><div><strong>{short(hit.assetId)} · V{hit.assetVersion}</strong><small>{hit.exactChecksumMatch ? "校验值完全一致" : "感知哈希相似"}</small></div><b>{hit.perceptualSimilarityPermille === undefined ? "EXACT" : `${(hit.perceptualSimilarityPermille / 10).toFixed(1)}%`}</b></li>)}</ol>
      )}
    </div>
  );
}

function VisualSearchButton({ disabled }: { disabled: boolean }) {
  const { pending } = useFormStatus();
  return <button disabled={disabled || pending} type="submit">{pending ? <LoaderCircle className="spin" size={13} /> : <Search size={13} />}{pending ? "正在检索" : "运行视觉检索"}</button>;
}

function VisualSearchNotice({ state }: { state: PodVisualSearchActionState }) {
  if (state.status === "idle") return null;
  return <p className={`pod-governance-notice ${state.status}`} role="status">{state.status === "success" ? <BadgeCheck size={13} /> : <CircleAlert size={13} />}{state.message}</p>;
}

function short(value: string | undefined) {
  return value ? `${value.slice(0, 8)}…${value.slice(-4)}` : "—";
}
