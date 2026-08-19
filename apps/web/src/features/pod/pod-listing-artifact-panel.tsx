"use client";

import type { PodListingArtifactOptionsView } from "@yummyai/contracts/pod/listing-artifacts";
import { BadgeCheck, CircleAlert, FileImage, Link2, LoaderCircle } from "lucide-react";
import { useActionState } from "react";
import { useFormStatus } from "react-dom";

import {
  createListingArtifactBinding,
  type PodGovernanceActionState,
} from "./pod-governance-actions";

const idle: PodGovernanceActionState = { message: "", status: "idle" };

export function PodListingArtifactPanel({
  error,
  options,
}: {
  error?: string;
  options?: PodListingArtifactOptionsView;
}) {
  const [state, action] = useActionState(createListingArtifactBinding, idle);
  const listingVersions = options?.listingVersions ?? [];
  const assets = options?.assets ?? [];
  const bindings = options?.bindings ?? [];
  return (
    <section className="pod-governance-panel pod-listing-console" aria-labelledby="pod-listing-console-title">
      <header>
        <div><p>LISTING ARTIFACT SLOTS</p><h3 id="pod-listing-console-title">Listing 素材槽位</h3></div>
        <span>REVIEWED OUTPUTS ONLY</span>
      </header>
      <div className="pod-listing-boundary">
        <FileImage size={15} />
        <span><b>双重准入</b>仅展示权利批准且设计版本已审核的图片或标题；竞品研究素材和顾客订单素材不会进入候选列表。</span>
      </div>
      {error ? <p className="pod-governance-error"><CircleAlert size={14} />{error}</p> : null}
      {!error ? (
        <div className="pod-listing-layout">
          <form action={action} className="pod-listing-form">
            <div className="pod-form-heading"><Link2 size={15} /><div><strong>关联候选素材</strong><span>绑定到固定 Listing 版本与槽位，不覆盖历史版本。</span></div></div>
            <label><span>Listing 版本 *</span><select disabled={!listingVersions.length} name="listingVersionId" required><option value="">{listingVersions.length ? "选择 Listing 版本" : "暂无 Listing 版本"}</option>{listingVersions.map((version) => <option key={version.id} value={version.id}>{version.platform.toUpperCase()} · {version.locale} · V{version.versionNumber} · {listingStatus(version.status)}</option>)}</select></label>
            <label><span>已审核素材 *</span><select disabled={!assets.length} name="assetSelection" required><option value="">{assets.length ? "选择设计输出" : "暂无已审核设计输出"}</option>{assets.map((asset) => <option key={`${asset.id}:${asset.version}`} value={`${asset.id}:${asset.version}`}>{asset.fileName} · V{asset.version} · {asset.mediaType}</option>)}</select></label>
            <div className="pod-inline-fields two">
              <label><span>内容类型 *</span><select name="contentKind"><option value="image">图片</option><option value="title">标题</option></select></label>
              <label><span>槽位键 *</span><input defaultValue="main" maxLength={80} name="slotKey" pattern="[A-Za-z0-9](?:[A-Za-z0-9_.]|-){0,79}" required /></label>
            </div>
            <footer><Notice state={state} /><SubmitButton disabled={!listingVersions.length || !assets.length} /></footer>
          </form>
          <div className="pod-listing-ledger">
            <header><strong>最近槽位绑定</strong><span>{bindings.length} BINDINGS</span></header>
            {!bindings.length ? <p className="pod-governance-empty">尚无素材绑定。先完成设计结果审核，再建立 Listing 候选槽位。</p> : null}
            {bindings.slice(0, 24).map((binding) => {
              const listing = listingVersions.find((item) => item.id === binding.listingVersionId);
              const asset = assets.find((item) => item.id === binding.assetId && item.version === binding.assetVersion);
              return (
                <article key={binding.id}>
                  <span className={`pod-record-status ${binding.status}`}>{bindingStatus(binding.status)}</span>
                  <div><strong>{binding.contentKind === "image" ? "图片" : "标题"} / {binding.slotKey}</strong><span>{listing ? `${listing.platform.toUpperCase()} · ${listing.locale} · V${listing.versionNumber}` : short(binding.listingVersionId)}</span></div>
                  <code>{asset?.fileName ?? `${short(binding.assetId)} · V${binding.assetVersion}`}</code>
                </article>
              );
            })}
          </div>
        </div>
      ) : null}
    </section>
  );
}

function SubmitButton({ disabled }: { disabled: boolean }) {
  const { pending } = useFormStatus();
  return <button disabled={disabled || pending} type="submit">{pending ? <LoaderCircle className="spin" size={13} /> : <Link2 size={13} />}{pending ? "正在关联" : "创建候选绑定"}</button>;
}

function Notice({ state }: { state: PodGovernanceActionState }) {
  if (state.status === "idle") return null;
  return <p className={`pod-governance-notice ${state.status}`} role="status">{state.status === "success" ? <BadgeCheck size={13} /> : <CircleAlert size={13} />}{state.message}</p>;
}

function listingStatus(status: PodListingArtifactOptionsView["listingVersions"][number]["status"]) {
  return ({ draft: "草稿", approved: "已批准", superseded: "已替代" } as const)[status];
}

function bindingStatus(status: PodListingArtifactOptionsView["bindings"][number]["status"]) {
  return ({ candidate: "候选", approved: "已批准", rejected: "已驳回" } as const)[status];
}

function short(value: string) {
  return `${value.slice(0, 8)}…${value.slice(-4)}`;
}
