"use client";

import type { MarketplaceAccountView, MarketplacePublicationRequestView } from "@yummyai/contracts";
import {
  BadgeCheck,
  Ban,
  Check,
  CircleAlert,
  CloudSync,
  ExternalLink,
  KeyRound,
  LoaderCircle,
  Plus,
  ShieldCheck,
  Store,
  Unplug,
} from "lucide-react";
import { useActionState, useEffect, useState } from "react";
import { useFormStatus } from "react-dom";

import {
  authorizeAmazonPrivate,
  createMarketplaceAccount,
  revokeMarketplaceAuthorization,
  setMarketplaceAccountEnabled,
  startMarketplaceOAuth,
  syncMarketplaceCapabilities,
  type MarketplaceActionState,
} from "./marketplace-actions";

const initialState: MarketplaceActionState = { message: "", status: "idle" };

export function MarketplaceAccountsWorkspace({
  accounts,
  error,
  oauthNotice,
  publications,
}: {
  accounts: MarketplaceAccountView[];
  error?: string;
  oauthNotice?: { message: string; status: "success" | "error" };
  publications: MarketplacePublicationRequestView[];
}) {
  const [platform, setPlatform] = useState<"amazon" | "etsy">("etsy");
  const [createState, createAction] = useActionState(createMarketplaceAccount, initialState);
  const activeCount = accounts.filter((account) => account.status === "active").length;
  const attentionCount = accounts.filter((account) => account.status === "degraded" || account.status === "revoked").length;

  return (
    <div className="store-workspace">
      {(error || oauthNotice) && (
        <p className={`store-page-notice ${error || oauthNotice?.status === "error" ? "error" : "success"}`} role="status">
          {error ?? oauthNotice?.message}
        </p>
      )}

      <dl className="store-signal-strip" aria-label="店铺连接概览">
        <Signal label="店铺连接" value={accounts.length} />
        <Signal label="可发布" value={activeCount} />
        <Signal label="待授权" value={accounts.filter((account) => !account.hasCredential).length} />
        <Signal label="需处理" value={attentionCount} />
      </dl>

      <details className="store-create-panel" open={accounts.length === 0}>
        <summary><Plus size={16} />新增店铺连接</summary>
        <form action={createAction} className="store-create-form">
          <fieldset className="platform-segments">
            <legend>平台</legend>
            {(["amazon", "etsy"] as const).map((value) => (
              <label key={value}>
                <input
                  checked={platform === value}
                  name="platform"
                  onChange={() => setPlatform(value)}
                  type="radio"
                  value={value}
                />
                <span>{value === "amazon" ? "Amazon" : "Etsy"}</span>
              </label>
            ))}
          </fieldset>
          <label><span>连接名称</span><input name="displayName" placeholder={platform === "amazon" ? "Amazon US" : "Etsy 主店"} required /></label>
          <label>
            <span>授权方式</span>
            <select name="authorizationMode" defaultValue={platform === "amazon" ? "amazon_private" : "etsy_oauth"} key={platform}>
              {platform === "amazon" ? (
                <><option value="amazon_private">私有应用</option><option value="amazon_public">公开应用 OAuth</option></>
              ) : <option value="etsy_oauth">Etsy OAuth</option>}
            </select>
          </label>
          <label>
            <span>区域</span>
            <select name="region" defaultValue={platform === "amazon" ? "NA" : "GLOBAL"} key={`region-${platform}`}>
              {platform === "amazon" ? (
                <><option value="NA">North America</option><option value="EU">Europe</option><option value="FE">Far East</option></>
              ) : <option value="GLOBAL">Global</option>}
            </select>
          </label>
          <label><span>Marketplace IDs</span><input name="marketplaceIds" defaultValue={platform === "amazon" ? "ATVPDKIKX0DER" : "etsy"} key={`market-${platform}`} required /></label>
          <label className="store-create-scopes"><span>请求权限</span><input name="requestedScopes" defaultValue={platform === "amazon" ? "product-listing" : "listings_r, listings_w, shops_r"} key={`scopes-${platform}`} required /></label>
          <div className="store-create-submit"><ActionNotice state={createState} /><SubmitButton icon={Plus}>创建连接</SubmitButton></div>
        </form>
      </details>

      {accounts.length === 0 ? (
        <section className="store-empty">
          <Store size={28} />
          <strong>暂无店铺连接</strong>
          <span>创建后先完成授权，再同步平台能力。</span>
        </section>
      ) : (
        <section className="store-ledger" aria-label="店铺连接台账">
          {accounts.map((account) => (
            <MarketplaceAccountRecord
              account={account}
              key={account.id}
              publicationCount={publications.filter((publication) => publication.accountId === account.id).length}
            />
          ))}
        </section>
      )}
    </div>
  );
}

function MarketplaceAccountRecord({ account, publicationCount }: { account: MarketplaceAccountView; publicationCount: number }) {
  const [authorizationState, authorizationAction] = useActionState(
    authorizeAmazonPrivate.bind(null, account.id),
    initialState,
  );
  const [oauthState, oauthAction] = useActionState(startMarketplaceOAuth.bind(null, account.id), initialState);
  const [syncState, syncAction] = useActionState(
    syncMarketplaceCapabilities.bind(null, account.id, account.platform),
    initialState,
  );
  const [toggleState, toggleAction] = useActionState(
    setMarketplaceAccountEnabled.bind(null, account.id, account.status === "disabled"),
    initialState,
  );
  const [revokeState, revokeAction] = useActionState(
    revokeMarketplaceAuthorization.bind(null, account.id),
    initialState,
  );

  useEffect(() => {
    if (oauthState.redirectUrl) window.location.assign(oauthState.redirectUrl);
  }, [oauthState.redirectUrl]);

  const notice = [authorizationState, oauthState, syncState, toggleState, revokeState]
    .find((state) => state.status !== "idle");

  return (
    <article className="store-record">
      <header>
        <div className="store-identity">
          <span className={`platform-mark ${account.platform}`}>{account.platform === "amazon" ? "AMZ" : "ETSY"}</span>
          <div><h2>{account.displayName}</h2><p>{account.externalAccountId ?? "尚未绑定平台账号"} · {account.region}</p></div>
        </div>
        <StatusBadge status={account.status} />
      </header>

      <AccountWorkflowTrack account={account} />

      <div className="store-record-body">
        <dl className="store-facts">
          <Fact label="Marketplace" value={account.marketplaceIds.join(" · ")} />
          <Fact label="授权状态" value={credentialLabel(account.credentialStatus)} />
          <Fact label="健康检查" value={healthLabel(account.healthStatus)} />
          <Fact label="能力同步" value={formatDate(account.lastCapabilitySyncAt)} />
          <Fact label="能力有效期" value={formatDate(account.capabilityExpiresAt)} />
          <Fact label="发布请求" value={`${publicationCount} 次`} />
        </dl>
        <div className="store-capabilities">
          <p className="section-code">GRANTED CAPABILITIES</p>
          <div>{account.capabilities.length ? account.capabilities.map((capability) => <span key={capability}>{capability}</span>) : <em>尚未同步</em>}</div>
        </div>
      </div>

      <div className="store-account-actions">
        {!account.hasCredential && account.authorizationMode === "amazon_private" && (
          <details>
            <summary><KeyRound size={15} />验证私有应用</summary>
            <form action={authorizationAction} className="store-secret-form">
              <label><span>Seller ID</span><input autoComplete="off" name="sellingPartnerId" required /></label>
              <label><span>LWA Client ID</span><input autoComplete="off" name="clientId" required /></label>
              <label><span>Client secret</span><input autoComplete="off" name="clientSecret" required type="password" /></label>
              <label><span>Refresh token</span><input autoComplete="off" name="refreshToken" required type="password" /></label>
              <SubmitButton icon={ShieldCheck}>验证并保存</SubmitButton>
            </form>
          </details>
        )}
        {account.authorizationMode !== "amazon_private" && !account.hasCredential && (
          <form action={oauthAction}><SubmitButton icon={ExternalLink}>前往平台授权</SubmitButton></form>
        )}
        {account.hasCredential && (
          <form action={syncAction} className="store-sync-form">
            <label><span>{account.platform === "amazon" ? "Product Types" : "Taxonomy IDs"}</span><input name="targets" placeholder={account.platform === "amazon" ? "HOME, PILLOW" : "42, 123"} /></label>
            <SubmitButton icon={CloudSync}>同步能力</SubmitButton>
          </form>
        )}
        <form action={toggleAction}><SubmitButton icon={account.status === "disabled" ? Check : Ban}>{account.status === "disabled" ? "启用" : "停用"}</SubmitButton></form>
        {account.hasCredential && <form action={revokeAction}><SubmitButton danger icon={Unplug}>撤销授权</SubmitButton></form>}
      </div>
      {notice && <ActionNotice state={notice} />}
      {account.lastErrorCode && <p className="store-diagnostic"><CircleAlert size={14} />{account.lastErrorCode}</p>}
    </article>
  );
}

function AccountWorkflowTrack({ account }: { account: MarketplaceAccountView }) {
  const steps = [
    { done: true, label: "连接" },
    { done: account.hasCredential, label: "授权" },
    { done: account.status === "active" && account.healthStatus === "healthy", label: "能力" },
    { done: account.status === "active", label: "可发布" },
  ];
  const firstPending = steps.findIndex((step) => !step.done);
  return (
    <ol className="store-workflow" aria-label={`${account.displayName} 发布准备状态`}>
      {steps.map((step, index) => (
        <li className={step.done ? "done" : index === firstPending ? "current" : "pending"} key={step.label}>
          <span>{step.done ? <Check size={13} /> : index + 1}</span><b>{step.label}</b>
        </li>
      ))}
    </ol>
  );
}

function Signal({ label, value }: { label: string; value: number }) {
  return <div><dt>{label}</dt><dd>{value}</dd></div>;
}

function Fact({ label, value }: { label: string; value: string }) {
  return <div><dt>{label}</dt><dd>{value}</dd></div>;
}

function StatusBadge({ status }: { status: MarketplaceAccountView["status"] }) {
  const labels = { active: "可发布", degraded: "异常", disabled: "已停用", pending_authorization: "待授权", revoked: "已撤销" };
  return <span className={`store-status ${status}`}>{labels[status]}</span>;
}

function SubmitButton({ children, danger, icon: Icon }: { children: React.ReactNode; danger?: boolean; icon: typeof Plus }) {
  const { pending } = useFormStatus();
  return <button className={danger ? "danger" : undefined} disabled={pending} type="submit">{pending ? <LoaderCircle className="spin" size={15} /> : <Icon size={15} />}{children}</button>;
}

function ActionNotice({ state }: { state: MarketplaceActionState }) {
  if (state.status === "idle") return null;
  return <p className={`store-action-notice ${state.status}`} role="status">{state.status === "success" ? <BadgeCheck size={14} /> : <CircleAlert size={14} />}{state.message}</p>;
}

function credentialLabel(status: MarketplaceAccountView["credentialStatus"]): string {
  return ({ expiring: "即将过期", missing: "未授权", revoked: "已撤销", valid: "有效" })[status];
}

function healthLabel(status: MarketplaceAccountView["healthStatus"]): string {
  return ({ degraded: "异常", healthy: "健康", not_checked: "未检查", unauthorized: "未授权", unavailable: "不可用" })[status];
}

function formatDate(value: string | null): string {
  if (!value) return "—";
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}
