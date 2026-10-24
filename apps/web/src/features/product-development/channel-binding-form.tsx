"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { CheckCircle2, LoaderCircle, AlertCircle } from "lucide-react";
import {
  BindSalesChannelSchema,
  SalesChannelPreviewSchema,
  type SalesChannelPreview,
  type SalesPackageView,
  type DevelopmentOptions,
} from "@yummyai/contracts/catalog/development";
import { developmentRequest, DevelopmentRequestError } from "./development-client";
import { formFingerprint } from "../navigation/use-form-edits";

type Fields = {
  packageId: string;
  accountId: string;
  externalSku: string;
  externalListingId: string;
  choiceKey: string;
  choiceValue: string;
  effective: string;
  evidence: string;
};
export function ChannelBindingForm({
  packages,
  accounts,
  skuCode,
  disabled,
  onBusy,
  onSaved,
  onDenied,
}: {
  packages: SalesPackageView[];
  accounts: DevelopmentOptions["accounts"];
  skuCode: string;
  disabled: boolean;
  onBusy: (busy: boolean) => void;
  onSaved: (form: HTMLFormElement, fingerprint: string) => void;
  onDenied: () => void;
}) {
  const [fields, setFields] = useState<Fields>({
    packageId: packages[0]?.id ?? "",
    accountId: "",
    externalSku: skuCode,
    externalListingId: "",
    choiceKey: "",
    choiceValue: "",
    effective: "",
    evidence: "",
  });
  const [state, setState] = useState<{
      signature: string;
      data: SalesChannelPreview | null;
      error: string;
      denied: boolean;
    } | null>(null),
    [attempt, setAttempt] = useState(0),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const requests = useRef(
      new Map<string, { key: string; unconfirmed: boolean; confirmed: boolean }>(),
    ),
    notified = useRef(new Set<string>()),
    active = useRef(false),
    write = useRef<AbortController | null>(null),
    denied = useRef(onDenied),
    callbacks = useRef({ onBusy, onSaved });
  denied.current = onDenied;
  callbacks.current = { onBusy, onSaved };
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      write.current?.abort();
    };
  }, []);
  let input: ReturnType<typeof SalesChannelPreviewSchema.parse> | null = null;
  try {
    input = SalesChannelPreviewSchema.parse({
      packageId: fields.packageId,
      accountId: fields.accountId,
      externalSku: fields.externalSku,
      externalListingId: fields.externalListingId,
      customChoice: fields.choiceKey ? { [fields.choiceKey]: fields.choiceValue } : {},
      effectiveFrom: new Date(fields.effective).toISOString(),
    });
  } catch {
    /* Incomplete inputs are not submitted for preflight. */
  }
  const signature = input ? JSON.stringify(input) : "",
    current = state?.signature === signature ? state : null;
  useEffect(() => {
    if (!signature) return;
    const abort = new AbortController();
    setState({ signature, data: null, error: "", denied: false });
    const timer = window.setTimeout(
      () =>
        void developmentRequest<SalesChannelPreview>(
          "channels/preview",
          JSON.parse(signature),
          abort.signal,
        )
          .then((data) => {
            if (abort.signal.aborted) return;
            if (
              JSON.stringify(data.input) !== signature ||
              data.package.id !== data.input.packageId ||
              data.account.id !== data.input.accountId
            )
              throw Error("映射依据与当前输入不一致 请重新核对");
            notified.current.delete(signature);
            setState({ signature, data, error: "", denied: false });
          })
          .catch((cause) => {
            if (abort.signal.aborted) return;
            const unavailable =
              cause instanceof DevelopmentRequestError && [401, 403, 404].includes(cause.status);
            setState({
              signature,
              data: null,
              error: cause instanceof Error ? cause.message : "映射暂时无法核对 现有输入已保留",
              denied: unavailable,
            });
            if (unavailable && !notified.current.has(signature)) {
              notified.current.add(signature);
              denied.current();
            }
          }),
      180,
    );
    return () => {
      window.clearTimeout(timer);
      abort.abort();
    };
  }, [signature, attempt, packages, accounts]);
  useEffect(() => {
    const refresh = () => setAttempt((n) => n + 1),
      timer = window.setInterval(refresh, 30000);
    window.addEventListener("focus", refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
    };
  }, []);
  const body =
      input && fields.evidence.trim() ? { ...input, evidence: fields.evidence.trim() } : null,
    bodySignature = body ? JSON.stringify(body) : "",
    receipt = bodySignature ? requests.current.get(bodySignature) : undefined;
  const retry = !!receipt?.unconfirmed && !current?.denied;
  const ready = !!current?.data && current.data.status === "ready" && current.data.canBind;
  const change = (key: keyof Fields, value: string) => {
    setFields((previous) => ({ ...previous, [key]: value }));
    setError("");
    setNotice("");
  };
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || disabled || !body || (!ready && !retry) || receipt?.confirmed) return;
    const element = event.currentTarget,
      submitted = formFingerprint(element),
      entry = receipt ?? { key: crypto.randomUUID(), unconfirmed: false, confirmed: false };
    requests.current.set(bodySignature, entry);
    const payload = BindSalesChannelSchema.parse({ ...body, idempotencyKey: entry.key }),
      abort = new AbortController();
    write.current = abort;
    setBusy(true);
    callbacks.current.onBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await developmentRequest<{ bindingId: string }>(
        "channels",
        payload,
        abort.signal,
      );
      if (!result.bindingId)
        throw new DevelopmentRequestError("登记结果尚未确认 请用原请求重试", 502);
      if (abort.signal.aborted || !active.current) return;
      entry.unconfirmed = false;
      entry.confirmed = true;
      setNotice("渠道映射已登记 订单按下单时间匹配版本");
      callbacks.current.onSaved(element, submitted);
      setAttempt((n) => n + 1);
    } catch (cause) {
      if (abort.signal.aborted || !active.current) return;
      entry.unconfirmed =
        !(cause instanceof DevelopmentRequestError) || cause.status === 408 || cause.status >= 500;
      setError(
        entry.unconfirmed
          ? "操作结果尚未确认 现有输入与原请求编号已保留 请核对后重试原请求"
          : cause instanceof Error
            ? cause.message
            : "登记未完成 请重新核对",
      );
      if (cause instanceof DevelopmentRequestError && [401, 403, 404].includes(cause.status))
        denied.current();
    } finally {
      if (!abort.signal.aborted && active.current) {
        setBusy(false);
        callbacks.current.onBusy(false);
      }
    }
  }
  const date = (value: string) => new Date(value).toLocaleString("zh-CN");
  return (
    <form onSubmit={submit} aria-label="登记店铺 SKU 映射">
      <fieldset disabled={disabled || busy || !!receipt?.unconfirmed} className="pd-form">
        <label>
          渠道资料包
          <select
            name="package"
            required
            value={fields.packageId}
            onChange={(e) => change("packageId", e.target.value)}
          >
            {!packages.some((p) => p.id === fields.packageId) && (
              <option value={fields.packageId}>原资料包当前不可读取</option>
            )}
            {packages.map((p) => (
              <option key={p.id} value={p.id}>
                {p.platform} / {p.marketplaceId} · 资料包 V{p.version}
              </option>
            ))}
          </select>
        </label>
        <label>
          店铺
          <select
            name="account"
            required
            value={fields.accountId}
            onChange={(e) => change("accountId", e.target.value)}
          >
            <option value="">请选择</option>
            {fields.accountId && !accounts.some((a) => a.id === fields.accountId) && (
              <option value={fields.accountId}>原店铺当前不可读取</option>
            )}
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.displayName} · {a.platform}
              </option>
            ))}
          </select>
        </label>
        <label>
          平台销售 SKU
          <input
            name="sku"
            required
            maxLength={200}
            value={fields.externalSku}
            onChange={(e) => change("externalSku", e.target.value)}
          />
        </label>
        <label>
          平台 Listing 编号
          <input
            name="listing"
            required
            maxLength={200}
            value={fields.externalListingId}
            onChange={(e) => change("externalListingId", e.target.value)}
          />
        </label>
        <label>
          Custom 选款字段（可留空）
          <input
            name="choiceKey"
            pattern="[a-z][a-z0-9_]*"
            maxLength={80}
            value={fields.choiceKey}
            onChange={(e) => change("choiceKey", e.target.value)}
            placeholder="print_style"
          />
        </label>
        <label>
          Custom 选款值
          <input
            name="choiceValue"
            maxLength={120}
            value={fields.choiceValue}
            onChange={(e) => change("choiceValue", e.target.value)}
            placeholder="与顾客选项的实际值一致"
          />
        </label>
        <label>
          生效时间
          <input
            name="effective"
            type="datetime-local"
            required
            value={fields.effective}
            onChange={(e) => change("effective", e.target.value)}
          />
          <small>按当前浏览器时区填写</small>
        </label>
        <label>
          登记依据
          <input
            name="evidence"
            required
            maxLength={2000}
            value={fields.evidence}
            onChange={(e) => change("evidence", e.target.value)}
            placeholder="上架记录编号及核对说明"
          />
        </label>
      </fieldset>
      <section className="pd-channel-preview" aria-label="映射只读预检" aria-live="polite">
        {!signature ? (
          <p>请选择资料包与店铺 填写平台编号及生效时间后核对</p>
        ) : current?.error ? (
          <>
            <p role="alert">
              <AlertCircle size={15} />
              {current.error}
            </p>
            <button
              type="button"
              className="oc-button"
              disabled={busy || disabled}
              onClick={() => setAttempt((n) => n + 1)}
            >
              重试映射核对
            </button>
          </>
        ) : !current?.data ? (
          <p role="status">
            <LoaderCircle size={15} />
            正在核对原包与生效区间
          </p>
        ) : (
          <>
            <p>
              <CheckCircle2 size={15} />
              {current.data.account.displayName} · 原 SKU {current.data.package.skuCode} · 资料包 V
              {current.data.package.version}
            </p>
            <p className="pd-code">SHA256 {current.data.package.checksum}</p>
            <p>
              本次生效 {date(current.data.input.effectiveFrom)}
              {current.data.effectiveUntil
                ? ` 至 ${date(current.data.effectiveUntil)} 之前`
                : " 起 至同一渠道与选款的下一条映射生效前"}
            </p>
            {current.data.previous && (
              <p>
                此前映射 {date(current.data.previous.effectiveFrom)} ·{" "}
                {current.data.previous.package
                  ? `资料包 V${current.data.previous.package.version}`
                  : "资料包当前不可读取"}
              </p>
            )}
            {current.data.next && (
              <p>
                随后映射 {date(current.data.next.effectiveFrom)} ·{" "}
                {current.data.next.package
                  ? `资料包 V${current.data.next.package.version}`
                  : "资料包当前不可读取"}{" "}
                保留原样
              </p>
            )}
            {current.data.status === "conflict" && (
              <p role="alert">
                这个生效时间已有映射 请核对登记历史
                {retry ? " 结果未确认的原请求仍可按原编号重试" : ""}
              </p>
            )}
            {!current.data.canBind && <p>当前只能核对 还没有此商品与店铺的登记权限</p>}
          </>
        )}
      </section>
      {error && (
        <p role="alert" className="oc-notice oc-notice-error">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="oc-notice">
          {notice}
        </p>
      )}
      <button
        className="oc-button primary"
        disabled={disabled || busy || !body || (!ready && !retry) || !!receipt?.confirmed}
      >
        {busy
          ? "正在核对并登记"
          : receipt?.confirmed
            ? "已登记"
            : retry
              ? "重试原登记请求"
              : "登记映射"}
      </button>
    </form>
  );
}
