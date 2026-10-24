"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { FileUp, Archive, Download } from "lucide-react";
import {
  KnowledgeFieldsSchema,
  type KnowledgeFields,
  type KnowledgeWorkspace,
} from "@yummyai/contracts/knowledge";
import {
  KnowledgeDocumentViewSchema,
  KnowledgeSavedRecordSchema,
  KnowledgeOriginalDownloadSchema,
  type KnowledgeDocumentView,
  type KnowledgeGovernanceView,
} from "@yummyai/contracts/knowledge/governance";
import { TaskDrawer, TaskDrawerActions } from "../navigation/task-drawer";
import { governanceApi } from "./knowledge-api";
import { KnowledgeMetadataForm, knowledgeBlankFields } from "./knowledge-shared";
export function KnowledgeImports({
  data,
  library,
  onChanged,
  accountOnly = false,
  initialId = "",
}: {
  data: KnowledgeGovernanceView;
  library: KnowledgeWorkspace;
  onChanged: () => void;
  accountOnly?: boolean;
  initialId?: string;
}) {
  const [uploadOpen, setUploadOpen] = useState(false),
    [file, setFile] = useState<File | null>(null),
    [fields, setFields] = useState<KnowledgeFields>(knowledgeBlankFields);
  const [kind, setKind] = useState<"reference" | "account">(accountOnly ? "account" : "reference"),
    [storeId, setStoreId] = useState(""),
    [currency, setCurrency] = useState("USD"),
    [periodFrom, setPeriodFrom] = useState(""),
    [periodUntil, setPeriodUntil] = useState(""),
    [attribution, setAttribution] = useState(""),
    [retention, setRetention] = useState(7);
  const [document, setDocument] = useState<KnowledgeDocumentView | null>(null),
    [preview, setPreview] = useState(""),
    [reason, setReason] = useState("");
  const [checks, setChecks] = useState([false, false, false]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [candidate, setCandidate] = useState<KnowledgeDocumentView["candidates"][number] | null>(
      null,
    ),
    [candidateFields, setCandidateFields] = useState<KnowledgeFields>(knowledgeBlankFields),
    [targetId, setTargetId] = useState(""),
    [candidateReason, setCandidateReason] = useState("");
  const pending = useRef<{ key: string; id: string } | null>(null);
  const requestId = (key: string) => {
    if (pending.current?.key !== key) pending.current = { key, id: crypto.randomUUID() };
    return pending.current.id;
  };
  const openDocument = async (id: string) => {
    setBusy(true);
    setError("");
    try {
      const value = KnowledgeDocumentViewSchema.parse(await governanceApi("documents/" + id));
      setDocument(value);
      setPreview(value.safeText);
      setChecks([false, false, false]);
      setReason("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "资料读取失败");
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    if (!initialId) return;
    const controller = new AbortController();
    governanceApi("documents/" + initialId, undefined, controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) {
          const doc = KnowledgeDocumentViewSchema.parse(value);
          setDocument(doc);
          setPreview(doc.safeText);
        }
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e instanceof Error ? e.message : "资料读取失败");
      });
    return () => controller.abort();
  }, [initialId]);
  const upload = async (e: FormEvent) => {
    e.preventDefault();
    if (!file) return;
    setBusy(true);
    setError("");
    try {
      if (file.size > 5 * 1024 * 1024) throw new Error("单份资料最多 5 MB");
      const parsed = KnowledgeFieldsSchema.parse({
        ...fields,
        sourceType: kind === "account" ? "case" : fields.sourceType,
      });
      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
        reader.onerror = () => reject(new Error("文件读取失败"));
        reader.readAsDataURL(file);
      });
      const key = JSON.stringify({
        fields: parsed,
        kind,
        storeId,
        currency,
        periodFrom,
        periodUntil,
        attribution,
        retention,
        fileName: file.name,
        size: file.size,
        modified: file.lastModified,
      });
      const saved = KnowledgeSavedRecordSchema.parse(
        await governanceApi("documents/upload", {
          requestId: requestId(key),
          fileName: file.name,
          base64,
          fields: parsed,
          account:
            kind === "account" ? { storeId, currency, periodFrom, periodUntil, attribution } : null,
          retentionDays: retention,
        }),
      );
      pending.current = null;
      setUploadOpen(false);
      setFile(null);
      onChanged();
      await openDocument(saved.id);
      setNotice("资料已处理，请核对解析诊断和待确认内容。");
    } catch (e) {
      setError(e instanceof Error ? e.message : "资料导入失败");
    } finally {
      setBusy(false);
    }
  };
  const decide = async (decision: "accept" | "reject") => {
    if (!candidate || !document) return;
    setBusy(true);
    setError("");
    try {
      const payload = {
        expectedRevision: candidate.revision,
        decision,
        fields: KnowledgeFieldsSchema.parse(candidateFields),
        targetEntryId: targetId || null,
        targetRevision: library.entries.find((e) => e.id === targetId)?.revision ?? 0,
        reason: candidateReason,
      };
      await governanceApi("candidates/" + candidate.id + "/decide", {
        ...payload,
        requestId: requestId(JSON.stringify({ candidate: candidate.id, payload })),
      });
      pending.current = null;
      setCandidate(null);
      onChanged();
      await openDocument(document.id);
      setNotice(
        decision === "accept"
          ? "已确认入库为草稿，审核发布后 AI 才会使用。"
          : "已拒绝该候选卡，原资料与处理记录保留。",
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "候选卡处理失败");
    } finally {
      setBusy(false);
    }
  };
  const confirm = async () => {
    if (!document) return;
    setBusy(true);
    setError("");
    try {
      await governanceApi("documents/" + document.id + "/confirm", {
        expectedRevision: document.revision,
        text: preview,
        identitiesRemoved: checks[0],
        credentialsRemoved: checks[1],
        minimumNecessary: checks[2],
        reason,
      });
      onChanged();
      await openDocument(document.id);
      setNotice("脱敏证据已确认，仅在所属店铺的授权检索范围中使用。");
    } catch (e) {
      setError(e instanceof Error ? e.message : "脱敏确认失败");
    } finally {
      setBusy(false);
    }
  };
  const dispose = async (action: "purge" | "archive") => {
    if (!document) return;
    setBusy(true);
    setError("");
    try {
      await governanceApi("documents/" + document.id + "/" + action, {});
      onChanged();
      await openDocument(document.id);
      setNotice(
        action === "purge"
          ? "加密原件已删除；已确认的证据和历史引用保留。"
          : "资料已归档，新检索停止使用该资料。",
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "资料处理失败");
    } finally {
      setBusy(false);
    }
  };
  const download = async () => {
    if (!document) return;
    setBusy(true);
    setError("");
    try {
      const original = KnowledgeOriginalDownloadSchema.parse(
        await governanceApi("documents/" + document.id + "/original", {}),
      );
      const bytes = Uint8Array.from(atob(original.base64), (c) => c.charCodeAt(0)),
        url = URL.createObjectURL(new Blob([bytes], { type: "application/octet-stream" }));
      const link = window.document.createElement("a");
      link.href = url;
      link.download = original.fileName.split(/[/\\]/).pop() ?? "knowledge-document";
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      setError(e instanceof Error ? e.message : "原件读取失败");
    } finally {
      setBusy(false);
    }
  };
  const items = data.documents.filter((d) => !accountOnly || d.kind === "account");
  return (
    <section className="kb-expanded" aria-label={accountOnly ? "账户证据" : "资料导入"}>
      <div className="kb-section-toolbar">
        <p className="kb-meta">
          {accountOnly
            ? "账户证据先脱敏、人工确认，再按店铺和报告期间使用。"
            : "上传资料 → 核对候选卡 → 确认入库为草稿 → 审核发布。"}
        </p>
        {data.canManage && (!accountOnly || data.canReadAccount) && (
          <button
            className="oc-button primary"
            onClick={() => {
              setKind(accountOnly ? "account" : "reference");
              setUploadOpen(true);
              setError("");
            }}
          >
            <FileUp size={14} />
            导入资料
          </button>
        )}
      </div>
      {!data.canReadAccount && accountOnly && (
        <p className="kb-warning">账户证据需要店铺读取和财务读取权限。</p>
      )}
      {error && (
        <p role="alert" className="kb-error">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {!items.length ? (
        <p className="kb-empty">暂无资料。可导入 SOP、产品参考资料或已取得使用授权的运营报告。</p>
      ) : (
        <div className="kb-rows">
          {items.map((d) => (
            <div className="kb-row" key={d.id}>
              <div>
                <button className="kb-text-button" onClick={() => void openDocument(d.id)}>
                  {d.fileName}
                </button>
                <p className="kb-meta">
                  {d.kind === "account" ? "账户证据" : "参考资料"} ·{" "}
                  {
                    {
                      preview: "待脱敏确认",
                      confirmed: "已处理",
                      failed: "解析失败",
                      archived: "已归档",
                    }[d.state]
                  }{" "}
                  · 复查 {d.fields.reviewDueOn}
                </p>
                {d.diagnostics.map((v, i) => (
                  <p key={i} className="kb-meta">
                    {v}
                  </p>
                ))}
              </div>
              <button className="oc-button" disabled={busy} onClick={() => void openDocument(d.id)}>
                查看资料
              </button>
            </div>
          ))}
        </div>
      )}
      {uploadOpen && (
        <TaskDrawer
          state={{ dirty: !!file, busy, loading: false }}
          title="导入知识资料"
          description="支持 UTF-8 TXT / Markdown / CSV、文字 PDF 和 DOCX，单份最多 5 MB。扫描 PDF 需先进行 OCR。"
          onClose={() => !busy && setUploadOpen(false)}
          footer={
            <TaskDrawerActions>
              <button className="oc-button" disabled={busy} onClick={() => setUploadOpen(false)}>
                取消
              </button>
              <button
                form="kb-upload-form"
                type="submit"
                className="oc-button primary"
                disabled={busy || !file}
              >
                {busy ? "正在扫描与解析…" : "上传并生成导入草稿"}
              </button>
            </TaskDrawerActions>
          }
        >
          <form id="kb-upload-form" className="kb-form" onSubmit={upload}>
            <label>
              文件
              <input
                type="file"
                accept=".txt,.md,.csv,.pdf,.docx"
                required
                onChange={(e) => {
                  const f = e.target.files?.[0] ?? null;
                  setFile(f);
                  pending.current = null;
                  if (f)
                    setFields((v) => ({
                      ...v,
                      title: v.title || f.name.replace(/\.[^.]+$/, ""),
                      sourceLabel: v.sourceLabel || f.name,
                    }));
                }}
              />
            </label>
            <label>
              资料类型
              <select
                aria-label="资料类型"
                value={kind}
                onChange={(e) => setKind(e.target.value as "reference" | "account")}
              >
                <option value="reference">SOP / 产品参考资料 / 运营方法</option>
                {data.canReadAccount && <option value="account">账户证据（需脱敏确认）</option>}
              </select>
            </label>
            <KnowledgeMetadataForm value={fields} onChange={setFields} spus={library.spus} />
            {kind === "account" && (
              <fieldset className="kb-form">
                <legend>账户报告范围</legend>
                <label>
                  所属店铺
                  <select
                    aria-label="所属店铺"
                    value={storeId}
                    required
                    onChange={(e) => {
                      setStoreId(e.target.value);
                      const store = data.stores.find((s) => s.id === e.target.value);
                      if (store)
                        setFields((v) => ({
                          ...v,
                          platform: store.platform as KnowledgeFields["platform"],
                          market: v.market === "ALL" ? "US" : v.market,
                          sourceType: "case",
                        }));
                    }}
                  >
                    <option value="">选择店铺</option>
                    {data.stores.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="kb-form-grid">
                  <label>
                    币种
                    <input
                      value={currency}
                      required
                      maxLength={3}
                      onChange={(e) => setCurrency(e.target.value.toUpperCase())}
                    />
                  </label>
                  <label>
                    报告开始
                    <input
                      type="date"
                      value={periodFrom}
                      required
                      onChange={(e) => setPeriodFrom(e.target.value)}
                    />
                  </label>
                  <label>
                    报告结束
                    <input
                      type="date"
                      value={periodUntil}
                      required
                      onChange={(e) => setPeriodUntil(e.target.value)}
                    />
                  </label>
                </div>
                <label>
                  归因口径
                  <input
                    value={attribution}
                    maxLength={300}
                    required
                    placeholder="例如：7 天点击归因；按报告日期汇总"
                    onChange={(e) => setAttribution(e.target.value)}
                  />
                </label>
              </fieldset>
            )}
            <label>
              原件保留天数
              <input
                type="number"
                min={1}
                max={30}
                value={retention}
                onChange={(e) => setRetention(Number(e.target.value))}
              />
            </label>
            <p className="kb-meta">
              原件到期会清除；已确认的证据、知识版本和引用记录保留。账户原文不会直接用于 AI。
            </p>
            {error && (
              <p className="kb-error" role="alert">
                {error}
              </p>
            )}
          </form>
        </TaskDrawer>
      )}
      {document && !candidate && (
        <TaskDrawer
          state={{
            dirty:
              document.state === "preview" &&
              (preview !== document.safeText || checks.some(Boolean) || !!reason),
            busy,
            loading: false,
          }}
          title={document?.fileName ?? "原资料"}
          description={document ? "原资料校验值：" + document.checksum.slice(0, 16) : ""}
          onClose={() => !busy && setDocument(null)}
          footer={
            <TaskDrawerActions>
              {document && data.canManage && (
                <>
                  <button
                    disabled={busy || !document.hasOriginal}
                    className="oc-button"
                    onClick={() => void dispose("purge")}
                  >
                    删除原件
                  </button>
                  <button
                    disabled={busy || document.state === "archived"}
                    className="oc-button"
                    onClick={() => void dispose("archive")}
                  >
                    <Archive size={14} />
                    归档资料
                  </button>
                </>
              )}
              {document?.hasOriginal && data.canManage && data.canPublish && (
                <button className="oc-button" disabled={busy} onClick={() => void download()}>
                  <Download size={14} />
                  下载本人导入的原件
                </button>
              )}
            </TaskDrawerActions>
          }
        >
          {document && (
            <div className="kb-form">
              {document.diagnostics.map((d, i) => (
                <p key={i} className="kb-warning">
                  {d}
                </p>
              ))}
              <p className="kb-meta">
                负责人 {document.fields.owner} · 复查 {document.fields.reviewDueOn} · 原件保留至{" "}
                {new Date(document.rawExpiresAt).toLocaleString("zh-CN")}
              </p>
              {document.kind === "account" && document.state === "preview" ? (
                <>
                  <label>
                    脱敏预览与人工修订
                    <textarea
                      value={preview}
                      rows={14}
                      maxLength={200000}
                      onChange={(e) => setPreview(e.target.value)}
                    />
                  </label>
                  {[
                    "已移除顾客姓名、地址和联系方式等身份信息",
                    "已移除凭证、令牌、Cookie 和密码",
                    "只保留本次知识用途所需的字段",
                  ].map((label, i) => (
                    <label className="kb-checkbox" key={label}>
                      <input
                        type="checkbox"
                        checked={checks[i]}
                        onChange={(e) =>
                          setChecks((v) => v.map((c, n) => (n === i ? e.target.checked : c)))
                        }
                      />
                      {label}
                    </label>
                  ))}
                  <label>
                    确认依据
                    <textarea
                      value={reason}
                      rows={2}
                      maxLength={1000}
                      onChange={(e) => setReason(e.target.value)}
                    />
                  </label>
                  {data.canManage && (
                    <button
                      className="oc-button primary"
                      disabled={busy || checks.some((c) => !c) || !reason.trim() || !preview.trim()}
                      onClick={() => void confirm()}
                    >
                      确认脱敏证据
                    </button>
                  )}
                </>
              ) : (
                <details open={document.kind === "account"}>
                  <summary>
                    {document.kind === "account" ? "已确认的脱敏证据" : "解析原文与来源定位"}
                  </summary>
                  <p className="kb-prose">
                    {document.safeText || "没有可用正文，请查看解析诊断。"}
                  </p>
                </details>
              )}
              {document.kind === "account" && document.state === "confirmed" && (
                <p className="kb-meta">
                  该证据仅供所属店铺的知识对话使用，不会生成通用运营知识卡。
                </p>
              )}
              {document.candidates.map((c) => (
                <div className="kb-candidate" key={c.id}>
                  <strong>{c.fields.title}</strong>
                  <p className="kb-meta">
                    {c.locator} ·{" "}
                    {
                      { pending: "待确认", accepted: "已入库为草稿", rejected: "已拒绝" }[
                        c.decision
                      ]
                    }
                  </p>
                  <p className="kb-prose">{c.excerpt}</p>
                  {!!c.duplicateIds.length && (
                    <p className="kb-warning">
                      可能重复：
                      {c.duplicateIds.map((id) => (
                        <Link key={id} href={"/knowledge?entry=" + id}>
                          查看已有知识{" "}
                        </Link>
                      ))}
                    </p>
                  )}
                  {c.entryId && (
                    <Link href={"/knowledge?entry=" + c.entryId}>前往知识卡审核发布</Link>
                  )}
                  {c.decision === "pending" && data.canManage && (
                    <button
                      className="oc-button"
                      onClick={() => {
                        setCandidate(c);
                        setCandidateFields(c.fields);
                        setTargetId("");
                        setCandidateReason("");
                      }}
                    >
                      编辑并确认候选卡
                    </button>
                  )}
                </div>
              ))}
              {error && (
                <p className="kb-error" role="alert">
                  {error}
                </p>
              )}
            </div>
          )}
        </TaskDrawer>
      )}
      {candidate && (
        <TaskDrawer
          state={{
            dirty:
              JSON.stringify(candidateFields) !== JSON.stringify(candidate.fields) ||
              !!candidateReason ||
              !!targetId,
            busy,
            loading: false,
          }}
          title="确认候选知识卡"
          description="确认入库创建可审核的草稿。需要编辑、预览差异并显式发布后 AI 才会使用。"
          onClose={() => !busy && setCandidate(null)}
          footer={
            <TaskDrawerActions>
              <button className="oc-button" disabled={busy} onClick={() => setCandidate(null)}>
                返回资料
              </button>
              <button
                className="oc-button"
                disabled={busy || !candidateReason.trim()}
                onClick={() => void decide("reject")}
              >
                拒绝候选卡
              </button>
              <button
                className="oc-button primary"
                disabled={busy || !candidateReason.trim()}
                onClick={() => void decide("accept")}
              >
                确认入库为草稿
              </button>
            </TaskDrawerActions>
          }
        >
          {candidate && (
            <div className="kb-form">
              <p className="kb-meta">来源位置：{candidate.locator}</p>
              <KnowledgeMetadataForm
                value={candidateFields}
                onChange={setCandidateFields}
                spus={library.spus}
              />
              <label>
                摘要
                <textarea
                  rows={3}
                  maxLength={1000}
                  value={candidateFields.summary}
                  onChange={(e) => setCandidateFields((v) => ({ ...v, summary: e.target.value }))}
                />
              </label>
              <label>
                知识正文
                <textarea
                  rows={12}
                  maxLength={24000}
                  value={candidateFields.body}
                  onChange={(e) => setCandidateFields((v) => ({ ...v, body: e.target.value }))}
                />
              </label>
              <label>
                入库目标
                <select
                  aria-label="入库目标"
                  value={targetId}
                  onChange={(e) => setTargetId(e.target.value)}
                >
                  <option value="">新建知识卡</option>
                  {library.entries.map((e) => (
                    <option value={e.id} key={e.id}>
                      修订：{e.latest.title}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                接受或拒绝依据
                <textarea
                  rows={2}
                  maxLength={1000}
                  value={candidateReason}
                  onChange={(e) => setCandidateReason(e.target.value)}
                />
              </label>
              {error && (
                <p role="alert" className="kb-error">
                  {error}
                </p>
              )}
            </div>
          )}
        </TaskDrawer>
      )}
    </section>
  );
}
