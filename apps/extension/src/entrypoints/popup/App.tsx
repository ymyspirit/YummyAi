import type { CaptureDomain, CaptureDraft } from "@yummyai/contracts";
import {
  AlertCircle,
  Check,
  CircleStop,
  ExternalLink,
  Image as ImageIcon,
  LoaderCircle,
  RefreshCw,
  ScanSearch,
  Send,
  ShieldCheck,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { browser } from "wxt/browser";

import {
  readActiveCapture,
  redactCaptureDraft,
  uploadCapture,
  type CaptureProgressState,
} from "../../lib/capture-client.js";

const stateLabel: Record<CaptureProgressState, string> = {
  pending: "待采集",
  parsing: "解析中",
  preview: "待确认",
  uploading: "上传中",
  normalizing: "标准化中",
  complete: "已完成",
  partial: "部分完成",
  failed: "失败",
  cancelled: "已取消",
};

type FieldSelection = "title" | "price" | "bullets";

export function App() {
  const [draft, setDraft] = useState<CaptureDraft | null>(null);
  const [state, setState] = useState<CaptureProgressState>("pending");
  const [domain, setDomain] = useState<CaptureDomain>("research");
  const [includedMedia, setIncludedMedia] = useState<Set<string>>(new Set());
  const [includedFields, setIncludedFields] = useState<Set<FieldSelection>>(
    new Set(["title", "price", "bullets"]),
  );
  const [error, setError] = useState<string | null>(null);
  const abortController = useRef<AbortController | null>(null);

  const loadPage = useCallback(async () => {
    setState("parsing");
    setError(null);
    try {
      const nextDraft = await readActiveCapture();
      setDraft(nextDraft);
      setDomain("research");
      setIncludedMedia(new Set(nextDraft.media.map((item) => item.id)));
      setState("preview");
    } catch (loadError) {
      setDraft(null);
      setError(messageFrom(loadError));
      setState("failed");
    }
  }, []);

  useEffect(() => {
    void loadPage();
    return () => abortController.current?.abort();
  }, [loadPage]);

  const includedMediaCount = includedMedia.size;
  const progress = progressFor(state);
  const canUpload = draft !== null && includedMediaCount > 0 && state === "preview";
  const visibleFields = useMemo(
    () => [
      { key: "title" as const, label: "标题", available: Boolean(draft?.title) },
      { key: "price" as const, label: "价格", available: Boolean(draft?.price) },
      { key: "bullets" as const, label: "卖点", available: Boolean(draft?.bullets.length) },
    ],
    [draft],
  );

  async function submitCapture() {
    if (!draft) return;
    const controller = new AbortController();
    abortController.current = controller;
    setError(null);

    const prepared = redactCaptureDraft(draft, {
      domain,
      includeTitle: includedFields.has("title"),
      includePrice: includedFields.has("price"),
      includeBullets: includedFields.has("bullets"),
      includedMediaIds: includedMedia,
    });

    try {
      const token = await getSessionAccessToken();
      await uploadCapture(prepared, {
        apiBaseUrl: import.meta.env.VITE_API_BASE_URL ?? "http://localhost:8000",
        ...(token ? { accessToken: token } : {}),
        signal: controller.signal,
        onProgress: setState,
      });
    } catch (uploadError) {
      if (controller.signal.aborted) {
        setState("cancelled");
      } else {
        setError(messageFrom(uploadError));
        setState("failed");
      }
    }
  }

  function cancelUpload() {
    abortController.current?.abort();
  }

  function toggleField(field: FieldSelection) {
    setIncludedFields((current) => toggled(current, field));
  }

  function toggleMedia(id: string) {
    setIncludedMedia((current) => toggled(current, id));
  }

  const busy = state === "parsing" || state === "uploading" || state === "normalizing";

  return (
    <main className="capture-shell">
      <header className="capture-header">
        <div className="brand-mark" aria-hidden="true">
          <ScanSearch size={19} strokeWidth={1.8} />
        </div>
        <div className="brand-copy">
          <p className="eyebrow">YUMMYAI / CAPTURE</p>
          <h1>页面证据检查</h1>
        </div>
        <StatusBadge state={state} />
      </header>

      <div className="progress-track" aria-label={`采集进度：${stateLabel[state]}`}>
        <span style={{ transform: `scaleX(${progress / 100})` }} />
      </div>

      {busy && !draft ? (
        <EmptyState icon={<LoaderCircle className="spin" />} title="正在读取公开页面" detail="只分析当前页面中你能看到的商品信息。" />
      ) : error && !draft ? (
        <EmptyState icon={<AlertCircle />} title="无法生成预览" detail={error}>
          <button className="secondary-button" type="button" onClick={() => void loadPage()}>
            <RefreshCw size={16} />重新读取
          </button>
        </EmptyState>
      ) : draft ? (
        <>
          <section className="source-section" aria-labelledby="source-heading">
            <div className="section-heading">
              <div>
                <p className="section-index">01 / SOURCE</p>
                <h2 id="source-heading">来源快照</h2>
              </div>
              <span className={`platform-tag platform-${draft.platform}`}>{draft.platform}</span>
            </div>
            <p className="product-title">{draft.title ?? "未识别商品标题"}</p>
            <a className="source-url" href={draft.sourceUrl} target="_blank" rel="noreferrer" title={draft.sourceUrl}>
              <span>{compactUrl(draft.sourceUrl)}</span><ExternalLink size={14} />
            </a>
            <dl className="evidence-stats">
              <div><dt>商品 ID</dt><dd>{draft.externalId ?? "—"}</dd></div>
              <div><dt>媒体</dt><dd>{includedMediaCount}<span> / {draft.media.length}</span></dd></div>
              <div><dt>字段缺失</dt><dd>{draft.missingFields.length}</dd></div>
            </dl>
          </section>

          <section className="review-section" aria-labelledby="scope-heading">
            <div className="section-heading compact">
              <div>
                <p className="section-index">02 / SCOPE</p>
                <h2 id="scope-heading">采集范围</h2>
              </div>
              <ShieldCheck size={18} aria-hidden="true" />
            </div>
            <fieldset className="domain-switch">
              <legend className="sr-only">资料用途</legend>
              <label className={domain === "research" ? "selected" : ""}>
                <input type="radio" name="domain" value="research" checked={domain === "research"} onChange={() => setDomain("research")} />
                竞品研究<span>默认</span>
              </label>
              <label className={domain === "authorized" ? "selected" : ""}>
                <input type="radio" name="domain" value="authorized" checked={domain === "authorized"} onChange={() => setDomain("authorized")} />
                自有 / 已授权
              </label>
            </fieldset>
            <div className="field-row" aria-label="字段排除">
              {visibleFields.map((field) => (
                <label key={field.key} className={!field.available ? "unavailable" : ""}>
                  <input
                    type="checkbox"
                    checked={field.available && includedFields.has(field.key)}
                    disabled={!field.available}
                    onChange={() => toggleField(field.key)}
                  />
                  <span>{field.label}</span>
                </label>
              ))}
            </div>
          </section>

          <section className="media-section" aria-labelledby="media-heading">
            <div className="section-heading compact">
              <div>
                <p className="section-index">03 / MEDIA</p>
                <h2 id="media-heading">媒体取舍</h2>
              </div>
              <span className="media-count"><ImageIcon size={15} />{includedMediaCount} 已选</span>
            </div>
            <div className="media-grid">
              {draft.media.map((item, index) => {
                const included = includedMedia.has(item.id);
                return (
                  <label className={`media-tile ${included ? "included" : "excluded"}`} key={item.id}>
                    <input type="checkbox" checked={included} onChange={() => toggleMedia(item.id)} />
                    <img src={item.sourceUrl} alt={item.alt ?? `商品媒体 ${index + 1}`} width="72" height="72" loading="lazy" />
                    <span className="media-check" aria-hidden="true"><Check size={13} /></span>
                    <span className="media-number">{String(index + 1).padStart(2, "0")}</span>
                  </label>
                );
              })}
            </div>
          </section>

          {draft.diagnostics.length > 0 && (
            <section className="diagnostics" aria-labelledby="diagnostics-heading">
              <div className="diagnostic-title">
                <AlertCircle size={16} />
                <h2 id="diagnostics-heading">解析提示</h2>
              </div>
              <ul>
                {draft.diagnostics.map((item, index) => <li key={`${item.field}-${index}`}>{item.message}</li>)}
              </ul>
            </section>
          )}

          {error && <p className="inline-error" role="alert">{error}</p>}
        </>
      ) : null}

      <footer className="action-dock">
        <div className="privacy-note"><ShieldCheck size={14} /><span>仅采集当前公开页面</span></div>
        {state === "uploading" || state === "normalizing" ? (
          <button className="danger-button" type="button" onClick={cancelUpload}>
            <CircleStop size={17} />取消
          </button>
        ) : state === "complete" || state === "partial" ? (
          <button className="primary-button success" type="button" onClick={() => void loadPage()}>
            <Check size={17} />{stateLabel[state]}
          </button>
        ) : (
          <button className="primary-button" type="button" disabled={!canUpload} onClick={() => void submitCapture()}>
            <Send size={17} />发送到研究库
          </button>
        )}
      </footer>
    </main>
  );
}

function StatusBadge({ state }: { state: CaptureProgressState }) {
  const active = state === "parsing" || state === "uploading" || state === "normalizing";
  return <span className={`status-badge status-${state}`} role="status" aria-live="polite">{active && <LoaderCircle className="spin" size={13} />}{stateLabel[state]}</span>;
}

function EmptyState({ icon, title, detail, children }: { icon: React.ReactNode; title: string; detail: string; children?: React.ReactNode }) {
  return <section className="empty-state"><div className="empty-icon">{icon}</div><h2>{title}</h2><p>{detail}</p>{children}</section>;
}

function toggled<T>(current: ReadonlySet<T>, value: T): Set<T> {
  const next = new Set(current);
  if (next.has(value)) next.delete(value); else next.add(value);
  return next;
}

function progressFor(state: CaptureProgressState): number {
  return { pending: 4, parsing: 22, preview: 44, uploading: 68, normalizing: 86, complete: 100, partial: 100, failed: 100, cancelled: 100 }[state];
}

function compactUrl(value: string): string {
  const url = new URL(value);
  return `${url.hostname}${url.pathname}`;
}

function messageFrom(error: unknown): string {
  return error instanceof Error ? error.message : "发生未知错误，请重试。";
}

async function getSessionAccessToken(): Promise<string | undefined> {
  const result = await browser.storage.session.get("yummyai.accessToken");
  const token = result["yummyai.accessToken"];
  return typeof token === "string" && token.length > 0 ? token : undefined;
}
