"use client";

import type { MarketplaceAccountView } from "@yummyai/contracts";
import { Plus, Pencil } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Field, RecordDialog, RecordForm } from "../manual-operations/record-form";
import { formText } from "../manual-operations/operation-types";

// Same marketplace identities used by the order-report importer.
const sites = [
  ["ATVPDKIKX0DER", "美国", "NA"], ["A2EUQ1WTGCTBG2", "加拿大", "NA"], ["A1AM78C64UM0Y8", "墨西哥", "NA"],
  ["A1F83G8C2ARO7P", "英国", "EU"], ["A1PA6795UKMFR9", "德国", "EU"], ["A13V1IB3VIYZZH", "法国", "EU"],
  ["APJ6JRA9NG5V4", "意大利", "EU"], ["A1RKKUPIHCS9HS", "西班牙", "EU"],
  ["A1VC38T7YXB528", "日本", "FE"], ["A39IBJ37TRP1C6", "澳大利亚", "FE"],
];

type StoreRecordAccount = Pick<MarketplaceAccountView, "hasCredential" | "authorizationMode">;
export function storeRecordInput(form: FormData, platform: "amazon" | "etsy", account?: StoreRecordAccount) {
  if (account) return { displayName: formText(form, "displayName"), ...(!account.hasCredential ? { authorizationMode: formText(form, "authorizationMode") } : {}) };
  const site = sites.find(([id]) => id === formText(form, "site"));
  return { displayName: formText(form, "displayName"), platform,
    region: platform === "etsy" ? "GLOBAL" : site?.[2], marketplaceIds: platform === "etsy" ? ["etsy"] : [site?.[0]],
    authorizationMode: platform === "etsy" ? "etsy_oauth" : formText(form, "authorizationMode") || "amazon_private",
    requestedScopes: platform === "etsy" ? ["listings_r", "listings_w", "shops_r"] : ["product-listing"],
  };
}

export function StoreAuthorizationModeField({ platform, mode = "amazon_private" }: { platform: "amazon" | "etsy"; mode?: MarketplaceAccountView["authorizationMode"] }) {
  return <Field label="平台连接方式" help="在店铺详情完成所选应用的实际授权 建立档案不会自动连接平台">
    <select name="authorizationMode" required defaultValue={platform === "etsy" ? "etsy_oauth" : mode}>
      {platform === "amazon" ? <><option value="amazon_private">Amazon 私有应用</option><option value="amazon_public">Amazon 公开应用 OAuth</option></> : <option value="etsy_oauth">Etsy OAuth</option>}
    </select>
  </Field>;
}

export function StoreRecordButton({ account }: { account?: MarketplaceAccountView }) {
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState("");
  const router = useRouter();
  const title = account ? "编辑店铺资料" : "新增店铺";
  return <>
    <div className="record-toolbar"><button className={account ? "" : "primary"} onClick={() => setOpen(true)}>{account ? <Pencil size={15} /> : <Plus size={15} />}{title}</button>
      {!account && <p>先建立店铺档案即可手动导入订单，需要自动同步时再连接平台。</p>}
    </div>
    {message && <p className="record-notice success" role="status">{message}</p>}
    {open && <StoreRecordForm account={account} onClose={() => setOpen(false)} onSaved={(id) => {
      setOpen(false); setMessage(account ? "店铺资料已更新。" : "店铺档案已创建，可进入详情或导入订单。"); router.refresh();
      if (id && !account) router.push(`/stores/${id}`);
    }} />}
  </>;
}

function StoreRecordForm({ account, onClose, onSaved }: { account?: MarketplaceAccountView; onClose: () => void; onSaved: (id: string) => void }) {
  const [platform, setPlatform] = useState(account?.platform ?? "amazon");
  return <RecordDialog title={account ? "编辑店铺资料" : "新增店铺"} onClose={onClose}>
    <RecordForm operation={account ? "store.update" : "store.create"} id={account?.id} onCancel={onClose}
      onSaved={(record) => onSaved(String(record.id ?? ""))} submitLabel={account ? "保存店铺资料" : "创建店铺档案"}
      description="店铺档案用于归集订单和运营资料。平台授权在店铺详情单独完成。"
      build={(form) => storeRecordInput(form, platform, account)}>
      <Field label="店铺名称"><input autoFocus name="displayName" required maxLength={120} defaultValue={account?.displayName} placeholder="例如：品牌美国主店" /></Field>
      {!account ? <div className="record-grid">
        <Field label="平台"><select value={platform} onChange={(event) => setPlatform(event.target.value as "amazon" | "etsy")}><option value="amazon">Amazon</option><option value="etsy">Etsy</option></select></Field>
        {platform === "amazon" ? <Field label="站点"><select name="site" required>{sites.map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></Field> : <p className="record-help">Etsy 店铺使用全球站点。</p>}
        <StoreAuthorizationModeField key={platform} platform={platform} />
      </div> : <>
        <p className="record-help">{account.platform === "amazon" ? "Amazon" : "Etsy"} · {account.marketplaceIds.map((id) => sites.find(([site]) => site === id)?.[1] ?? id).join("、")}</p>
        {!account.hasCredential && <StoreAuthorizationModeField platform={account.platform} mode={account.authorizationMode} />}
      </>}
    </RecordForm>
  </RecordDialog>;
}
