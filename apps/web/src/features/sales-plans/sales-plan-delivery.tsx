"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { RefreshCw, Download } from "lucide-react";
import type { SalesPlanView } from "@yummyai/contracts/catalog/sales-plan";
import type {
  DeliveryEvidence,
  SalesPlanDelivery as DeliveryData,
} from "@yummyai/contracts/catalog/sales-plan-delivery";
import { salesPlanRequest } from "./sales-plan-client";
import { salesPlanReadDenied } from "./sales-plan-client";
import { useErpAccess } from "../identity/erp-access";
import { SalesPackageHistory } from "./sales-package-history";
import { useSalesPackageDownload } from "./use-sales-package-download";
import { flushSync } from "react-dom";
import { observeViewTransition } from "../navigation/view-transition";
import "./sales-plan-delivery.css";

const kinds: Record<DeliveryEvidence[number]["kind"], string> = {
  finished_photo: "真实成品照片",
  mockup: "已审核规格套图",
  detail: "细节图",
  size: "尺寸图",
  customization: "定制说明图",
};
const checkLabels = {
  skuFacts: "已核对每个 SKU 的尺寸、单双面、材质与数量",
  customization: "已核对定制字段、说明与实际 Custom 页面配置",
  images: "已逐张核对图片保真、用途及真实成品主图",
  copyClaims: "已核对标题、卖点和描述中的事实与服务承诺",
};
const fieldTypes: Record<string, string> = {
  short_text: "短文本",
  long_text: "长文本",
  image: "上传图片",
  date: "日期",
  color: "颜色",
  single_choice: "单选",
  multiple_choice: "多选",
};
type Check = keyof typeof checkLabels;
const blankChecks = () => ({
  skuFacts: false,
  customization: false,
  images: false,
  copyClaims: false,
});
export function SalesPlanDelivery({
  plan,
  disabledReason,
}: {
  plan: SalesPlanView;
  disabledReason: string;
}) {
  const access = useErpAccess();
  if (!access.authority) return <p className="oc-empty">正在核对当前身份</p>;
  return (
    <DeliverySession
      key={`${plan.id}:${access.authority}`}
      plan={plan}
      disabledReason={disabledReason}
    />
  );
}
function DeliverySession({
  plan,
  disabledReason,
}: {
  plan: SalesPlanView;
  disabledReason: string;
}) {
  const [data, setData] = useState<DeliveryData | null>(null),
    [loading, setLoading] = useState(true),
    [reload, setReload] = useState(0);
  const [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false);
  const [checks, setChecks] = useState(blankChecks),
    [note, setNote] = useState(""),
    [evidence, setEvidence] = useState<Record<string, string>>({});
  const [failedImages, setFailedImages] = useState<Record<string, boolean>>({}),
    [previewRetries, setPreviewRetries] = useState<Record<string, number>>({});
  const [loadedImages, setLoadedImages] = useState<Record<string, boolean>>({});
  const [packagePage, setPackagePage] = useState(1);
  const [downloadError, setDownloadError] = useState("");
  const downloads = useSalesPackageDownload(setDownloadError);
  const cancelDownloads = useRef(downloads.cancel);
  cancelDownloads.current = downloads.cancel;
  const requests = useRef(new Map<string, string>()),
    pin = useRef("");
  const refresh = useCallback(() => setReload((value) => value + 1), []);
  useEffect(() => {
    const abort = new AbortController();
    setLoading(true);
    setError("");
    void salesPlanRequest<DeliveryData>(
      `${plan.id}/launch/delivery?packagePage=${packagePage}`,
      undefined,
      abort.signal,
    )
      .then((next) => {
        if (abort.signal.aborted) return;
        if (
          next.planId !== plan.id ||
          next.packageHistory?.page !== packagePage ||
          !Array.isArray(next.packages) ||
          !Array.isArray(next.currentPackages)
        )
          throw Error("交付资料与当前方案不一致 请重新核对");
        const currentPin = `${plan.id}:${next.fingerprint}`;
        if (pin.current !== currentPin) {
          pin.current = currentPin;
          setChecks(blankChecks());
          setNote("");
          setEvidence(
            Object.fromEntries(
              next.review?.current ? next.review.imageEvidence.map((e) => [e.assetId, e.kind]) : [],
            ),
          );
          setFailedImages({});
          setLoadedImages({});
          setPreviewRetries({});
          setNotice("");
        }
        setData(next);
      })
      .catch((cause) => {
        if (!abort.signal.aborted) {
          cancelDownloads.current();
          if (salesPlanReadDenied(cause)) {
            setDownloadError("");
            setChecks(blankChecks());
            setNote("");
            setEvidence({});
            pin.current = "";
            setFailedImages({});
            setLoadedImages({});
            setPreviewRetries({});
            requests.current.clear();
          }
          setData(null);
          setError(cause instanceof Error ? cause.message : "交付核对读取失败");
        }
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false);
      });
    return () => abort.abort();
  }, [plan.id, plan.revision, reload, packagePage]);
  useEffect(() => {
    const focus = () => refresh(),
      timer = window.setInterval(focus, 30000);
    window.addEventListener("focus", focus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", focus);
    };
  }, [refresh]);
  async function command(path: string, body: Record<string, unknown>, success: string) {
    if (busy || disabledReason) return;
    const signature = JSON.stringify({ plan: plan.id, path, body });
    const key = requests.current.get(signature) ?? crypto.randomUUID();
    requests.current.set(signature, key);
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await salesPlanRequest(`${plan.id}/launch/delivery/${path}`, {
        ...body,
        idempotencyKey: key,
      });
      setNotice(success);
      refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "操作未完成，请重试");
    } finally {
      setBusy(false);
    }
  }
  const reviewed = !!data?.review?.current;
  const allEvidence =
    !!data?.images.length &&
    data.images.every(
      (image) => !!evidence[image.id] && loadedImages[image.id] && !failedImages[image.id],
    );
  return (
    <section className="sd-workspace" id="sales-plan-delivery" aria-label="刊登与定制交付核对">
      <div className="sl-heading">
        <div>
          <h3>刊登与定制交付核对</h3>
          <p>核对当前商品、定制配置与图文，再按销售 SKU 封存交接资料。</p>
        </div>
        <button type="button" className="oc-button" disabled={busy || loading} onClick={refresh}>
          <RefreshCw size={14} />
          刷新交付核对
        </button>
      </div>
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
      {loading && <p role="status">正在读取当前交付依据…</p>}
      {data && !data.access.read && <p className="sp-hint">{data.diagnostics[0]}</p>}
      {data?.access.read && (
        <>
          <p className="sd-meta">
            方案 V{data.revision}
            {data.listing && (
              <>
                {" "}
                · 刊登 V{data.listing.version} ·{" "}
                <Link href={data.listing.href}>打开刊登编辑器</Link>
              </>
            )}
          </p>
          {disabledReason && <p className="sp-hint">{disabledReason}</p>}
          {data.issues.length > 0 && (
            <div className="sd-blockers" aria-label="交付缺项">
              <strong>{data.issues.length} 项需要处理</strong>
              <ul>
                {data.issues.map((issue, index) => (
                  <li key={`${issue.path}:${index}`}>
                    <span>{issue.message}</span>
                    <small>{issue.path}</small>
                    <Link href={issue.href}>处理此项</Link>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {data.review && (
            <div className="sd-review-history" aria-label="交付核对记录">
              <strong>{reviewed ? "当前交付已核对" : "上次交付核对已失效"}</strong>
              <p>
                {data.review.note} · 方案 V{data.review.revision} ·{" "}
                {new Date(data.review.occurredAt).toLocaleString("zh-CN")}
              </p>
              {data.review.changes.map((change) => (
                <p key={change.label}>
                  {change.label}：{change.effects.join("；")}
                </p>
              ))}
            </div>
          )}
          <details open={!reviewed} className="sd-section">
            <summary>SKU 与商品事实（{data.skus.length}）</summary>
            {!data.skus.length && <p>尚未选择销售 SKU。</p>}
            {data.skus.map((sku) => (
              <div className="sd-sku" key={sku.id}>
                <div>
                  <strong>{sku.code}</strong>
                  <p>{sku.specification}</p>
                  <p>
                    {Object.entries(sku.attributes)
                      .map(([key, value]) => `${key}：${value}`)
                      .join(" · ") || "规格选项未记录"}
                  </p>
                  {sku.facts && (
                    <p>
                      材质：{sku.facts.material} · 尺寸：{sku.facts.dimensions} · 包装数量：
                      {sku.facts.packageQuantity}
                      <br />
                      包含：{sku.facts.packageContents}
                    </p>
                  )}
                  {sku.issues.map((issue, index) => (
                    <p key={index} className="sp-hint">
                      {issue.message}
                    </p>
                  ))}
                </div>
                <Link href={sku.href}>核对制作依据</Link>
              </div>
            ))}
          </details>
          <details open={!reviewed} className="sd-section">
            <summary>定制字段与配置依据</summary>
            {!data.customization.length && <p>尚未配置定制字段。</p>}
            {data.customization.map((field) => (
              <div className="sd-field" key={field.key}>
                <strong>
                  {field.label} · {field.required ? "必填" : "选填"}
                </strong>
                <span>
                  {field.key} · {fieldTypes[field.type] ?? field.type}
                </span>
                <pre>{field.details}</pre>
              </div>
            ))}
            <p>定制说明</p>
            <pre>{data.instructions || "未填写"}</pre>
            <p>实际页面配置核验依据</p>
            <pre>{data.configurationEvidence || "未记录"}</pre>
            <Link href={`/sales-plans?plan=${plan.id}&step=3`}>修改定制配置</Link>
          </details>
          {data.copy && (
            <details open={!reviewed} className="sd-section">
              <summary>刊登文案与承诺</summary>
              <p>标题</p>
              <pre>{data.copy.title}</pre>
              <p>卖点</p>
              <ul>
                {data.copy.bullets.map((value, index) => (
                  <li key={index}>{value}</li>
                ))}
              </ul>
              <p>描述</p>
              <pre>{data.copy.description}</pre>
              <p>刊登编辑器中的定制说明</p>
              <pre>{data.copy.personalization || "未单独填写，请与方案定制说明及实际页面核对"}</pre>
            </details>
          )}
          <details open={!reviewed} className="sd-section">
            <summary>逐张核对图片用途（{data.images.length}）</summary>
            <div className="sd-images">
              {data.images.map((image) => (
                <div className="sd-image" key={image.id}>
                  <a href={image.previewPath} target="_blank" rel="noreferrer">
                    <img
                      key={`${data.fingerprint}:${image.id}:${previewRetries[image.id] ?? 0}`}
                      src={`${image.previewPath}?retry=${previewRetries[image.id] ?? 0}`}
                      alt={image.main ? `主图：${image.name}` : image.name}
                      onLoad={() => {
                        setLoadedImages((current) => ({ ...current, [image.id]: true }));
                        setFailedImages((current) => ({ ...current, [image.id]: false }));
                      }}
                      onError={() =>
                        setFailedImages((current) => ({ ...current, [image.id]: true }))
                      }
                    />
                  </a>
                  <p>
                    {image.main ? "主图 · " : ""}
                    {image.name}
                  </p>
                  {failedImages[image.id] && (
                    <p role="alert">
                      图片读取失败，核对前请
                      <button
                        type="button"
                        className="oc-button"
                        onClick={() =>
                          setPreviewRetries((current) => ({
                            ...current,
                            [image.id]: (current[image.id] ?? 0) + 1,
                          }))
                        }
                      >
                        重读此图
                      </button>
                    </p>
                  )}
                  <label>
                    图片用途：{image.name}
                    <select
                      aria-label={`图片用途：${image.name}`}
                      value={evidence[image.id] ?? ""}
                      disabled={busy || reviewed || !!disabledReason}
                      onChange={(event) => {
                        setEvidence((current) => ({ ...current, [image.id]: event.target.value }));
                        setChecks(blankChecks());
                      }}
                    >
                      <option value="">请选择并核对用途</option>
                      {Object.entries(kinds).map(([key, label]) => (
                        <option key={key} value={key}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </label>
                  {image.suggestedKind && !reviewed && (
                    <small>系统找到已审核套图来源，请核对是否用于此槽位。</small>
                  )}
                </div>
              ))}
            </div>
          </details>
          {!reviewed && data.supported && (
            <div className="sd-checks">
              <strong>运营逐项核对</strong>
              {(Object.entries(checkLabels) as Array<[Check, string]>).map(([key, label]) => (
                <label key={key}>
                  <input
                    type="checkbox"
                    checked={checks[key]}
                    disabled={busy || !!disabledReason || !data.access.review}
                    onChange={(event) =>
                      setChecks((current) => ({ ...current, [key]: event.target.checked }))
                    }
                  />
                  <span>{label}</span>
                </label>
              ))}
              <label>
                核对依据与说明
                <textarea
                  value={note}
                  maxLength={2000}
                  disabled={busy || !!disabledReason || !data.access.review}
                  onChange={(event) => setNote(event.target.value)}
                />
              </label>
              <button
                type="button"
                className="oc-button"
                disabled={
                  busy ||
                  loading ||
                  !!disabledReason ||
                  !data.access.review ||
                  data.issues.length > 0 ||
                  !Object.values(checks).every(Boolean) ||
                  !allEvidence ||
                  !note.trim()
                }
                onClick={() =>
                  void command(
                    "review",
                    {
                      expectedRevision: data.revision,
                      expectedFingerprint: data.fingerprint,
                      listingVersionId: data.listing!.versionId,
                      checks,
                      note,
                      imageEvidence: data.images.map((image) => ({
                        assetId: image.id,
                        kind: evidence[image.id],
                      })),
                    },
                    "交付核对已记录，可按 SKU 封存资料包",
                  )
                }
              >
                记录交付核对
              </button>
              {!data.access.review && <p>当前账号没有刊登审核权限。</p>}
            </div>
          )}
          <div className="sd-section" aria-label="按 SKU 封存资料包">
            <strong>按 SKU 封存与下载</strong>
            {data.skus.map((sku) => {
              const current = data.currentPackages.find((p) => p.skuId === sku.id);
              return (
                <div className="sd-package" key={sku.id}>
                  <strong>{sku.code}</strong>
                  {current ? (
                    <a
                      className="oc-button"
                      aria-disabled={downloads.pending !== null}
                      href={current.downloadPath}
                      onClick={(event) => {
                        event.preventDefault();
                        if (downloads.pending === null) void downloads.download(current);
                      }}
                    >
                      <Download size={14} />
                      下载当前交付包 V{current.version}
                    </a>
                  ) : (
                    <button
                      type="button"
                      className="oc-button"
                      disabled={
                        busy ||
                        loading ||
                        !!disabledReason ||
                        !reviewed ||
                        data.issues.length > 0 ||
                        !data.access.seal
                      }
                      onClick={() =>
                        void command(
                          "seal",
                          {
                            reviewId: data.review!.id,
                            skuId: sku.id,
                            expectedFingerprint: data.fingerprint,
                          },
                          `${sku.code} 交付资料包已封存`,
                        )
                      }
                    >
                      封存此 SKU 资料包
                    </button>
                  )}
                  <span>{current ? "当前审核版本已齐套" : "等待核对并封存"}</span>
                </div>
              );
            })}
          </div>
          <SalesPackageHistory
            data={data}
            loading={loading || busy}
            pending={downloads.pending}
            error={downloadError}
            onDownload={(pack) => void downloads.download(pack)}
            onPage={(page) => {
              const update = () => flushSync(() => setPackagePage(page));
              if (
                document.startViewTransition &&
                !window.matchMedia("(prefers-reduced-motion: reduce)").matches
              )
                observeViewTransition(document.startViewTransition(update));
              else update();
            }}
          />
          {data.diagnostics.map((message, index) => (
            <p className="sp-hint" key={index}>
              {message}
            </p>
          ))}
        </>
      )}
    </section>
  );
}
