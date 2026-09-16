"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  ResearchStudyContentSchema,
  SaveResearchStudyInputSchema,
  type ResearchStudyContent,
  type ResearchStudyRevision,
  type ResearchStudyWorkspace,
} from "@yummyai/contracts/research/creative";
import type { CaptureDraft } from "@yummyai/contracts/capture";
import { researchRequest, studyStatusLabels } from "./research-client";

const fields = [
  ["theme", "设计主题", 160, "例如：宠物纪念、退休致谢"],
  ["audience", "目标人群", 500, "谁在购买，送给谁"],
  ["occasion", "使用场景", 500, "场合、节日与赠礼关系"],
  ["buyingReasons", "购买动机", 2000, "买家希望表达或解决什么"],
  ["style", "风格与配色观察", 1000, "记录构图、字体、配色的特点"],
  ["fixedElements", "图案与元素观察", 2000, "值得分析的元素及其作用"],
  ["differentiation", "原创差异化方向", 2000, "我们准备如何形成自己的设计"],
  ["customizationNotes", "定制方式", 2000, "文字、照片、数量限制和版面变化"],
  ["imageInstructions", "图片处理要求", 2000, "抠图、画风转换或定制图片处理"],
  ["acceptance", "交付与验收要求", 3000, "母版、分层文件和审核要点"],
] as const;

export function ResearchStudyPanel({
  itemId,
  snapshotId,
  media,
  revisionId,
  historical = false,
  onDirtyChange,
}: {
  itemId: string;
  snapshotId: string;
  media: CaptureDraft["media"];
  revisionId?: string;
  historical?: boolean;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const router = useRouter();
  const [workspace, setWorkspace] = useState<ResearchStudyWorkspace | null>(null);
  const [content, setContent] = useState<ResearchStudyContent>(() =>
    ResearchStudyContentSchema.parse({}),
  );
  const [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [dirty, setDirty] = useState(false);
  const [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [retry, setRetry] = useState(0);
  const request = useRef({ signature: "", id: "" });
  const readonly = Boolean(revisionId) || historical;
  const dirtyCallback = useRef(onDirtyChange);
  useEffect(() => {
    dirtyCallback.current = onDirtyChange;
  });
  useEffect(() => {
    dirtyCallback.current?.(dirty);
  }, [dirty]);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    void researchRequest<ResearchStudyWorkspace>(
      `${itemId}/study${revisionId && revisionId !== "none" ? `?revision=${revisionId}` : ""}`,
      undefined,
      controller.signal,
    )
      .then((data) => {
        setWorkspace(data);
        const revision = revisionId === "none" ? null : data.revision;
        const matches = revision?.snapshotId === snapshotId;
        setContent(
          revision && (matches || !readonly)
            ? { ...revision.content, annotations: matches ? revision.content.annotations : [] }
            : ResearchStudyContentSchema.parse({}),
        );
        setDirty(false);
      })
      .catch((e: unknown) => {
        if (!controller.signal.aborted)
          setError(e instanceof Error ? e.message : "研究结论读取失败");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [itemId, snapshotId, revisionId, readonly, retry]);
  useEffect(() => {
    const guard = (event: BeforeUnloadEvent) => {
      if (dirty) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [dirty]);
  function edit(value: Partial<ResearchStudyContent>) {
    setContent((current) => ({ ...current, ...value }));
    setDirty(true);
    setNotice("");
  }
  async function save() {
    if (!workspace || readonly || busy) return;
    const payload = { snapshotId, expectedVersion: workspace.revision?.version ?? 0, content };
    const signature = JSON.stringify(payload);
    if (signature !== request.current.signature)
      request.current = { signature, id: crypto.randomUUID() };
    const parsed = SaveResearchStudyInputSchema.safeParse({
      ...payload,
      requestId: request.current.id,
    });
    if (!parsed.success) {
      setError(parsed.error.issues.map((issue) => issue.message).join("；"));
      return;
    }
    setBusy(true);
    setError("");
    try {
      const revision = await researchRequest<ResearchStudyRevision>(`${itemId}/study`, parsed.data);
      setWorkspace((current) => (current ? { ...current, revision } : current));
      setContent(revision.content);
      setDirty(false);
      setNotice(`已保存研究 V${revision.version}，已有创意项目继续使用原引用版本。`);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "保存失败，填写内容已保留");
    } finally {
      setBusy(false);
    }
  }
  if (loading)
    return (
      <p className="research-study" role="status">
        正在读取研究结论…
      </p>
    );
  if (!workspace)
    return (
      <div className="research-study" role="alert">
        {error}
        <button type="button" onClick={() => setRetry((v) => v + 1)}>
          重新读取
        </button>
      </div>
    );
  const matchingRevision =
    revisionId !== "none" && workspace.revision?.snapshotId === snapshotId
      ? workspace.revision
      : null;
  return (
    <section className="research-study" aria-label="研究结论">
      <header>
        <div>
          <h4>研究结论 {matchingRevision ? `· V${matchingRevision.version}` : "· 尚未保存"}</h4>
          <p>
            {readonly
              ? "正在查看固定引用版本。"
              : "归纳竞品的设计特点，填写自己的创作方向，再加入创意项目。"}
            {dirty ? " 有未保存修改。" : ""}
          </p>
        </div>
        <label>
          研究状态
          <select
            aria-label="研究状态"
            value={content.status}
            disabled={readonly || busy}
            onChange={(e) => edit({ status: e.target.value as ResearchStudyContent["status"] })}
          >
            {Object.entries(studyStatusLabels).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
      </header>
      {!readonly && workspace.revision && workspace.revision.snapshotId !== snapshotId && (
        <p className="research-note">
          已有研究基于较早快照。文字已带入供复核，图片批注需按本次快照重新填写；保存后生成新版本。
        </p>
      )}
      {readonly && !matchingRevision && (
        <p className="research-note">此引用没有绑定研究结论，仅保留了采集快照。</p>
      )}
      <div className="research-study-fields">
        {fields.map(([key, label, maxLength, placeholder]) => (
          <label key={key}>
            {label}
            <textarea
              aria-label={label}
              rows={2}
              value={content[key]}
              maxLength={maxLength}
              placeholder={readonly ? "未填写" : placeholder}
              disabled={readonly || busy}
              onChange={(e) => edit({ [key]: e.target.value })}
            />
          </label>
        ))}
      </div>
      <details className="research-annotations" open={content.annotations.length > 0}>
        <summary>图片与视频批注 · {content.annotations.length} 条</summary>
        <p>编号与上方媒体一致。记录值得分析的细节和自己的设计改进方向。</p>
        {media.map((entry, mediaIndex) =>
          entry.included ? (
            <label key={mediaIndex}>
              媒体 {mediaIndex + 1} · {entry.kind === "video" ? "视频" : "图片"}
              <textarea
                aria-label={`媒体 ${mediaIndex + 1} · ${entry.kind === "video" ? "视频" : "图片"}`}
                rows={2}
                maxLength={1000}
                value={
                  content.annotations.find((note) => note.mediaIndex === mediaIndex)?.note ?? ""
                }
                disabled={readonly || busy}
                placeholder="例如：名字在深色背景上不够醒目，我们改用留白区域"
                onChange={(e) =>
                  edit({
                    annotations: [
                      ...content.annotations.filter((note) => note.mediaIndex !== mediaIndex),
                      ...(e.target.value.trim() ? [{ mediaIndex, note: e.target.value }] : []),
                    ].sort((a, b) => a.mediaIndex - b.mediaIndex),
                  })
                }
              />
            </label>
          ) : null,
        )}
        {!media.some((entry) => entry.included) && <p>此快照没有可批注的媒体。</p>}
      </details>
      {error && <p role="alert">{error}。当前填写内容已保留。</p>}
      {notice && <p role="status">{notice}</p>}
      <footer>
        {!readonly && (
          <button
            type="button"
            className="filter-button"
            disabled={busy}
            onClick={() => void save()}
          >
            {busy ? "正在保存…" : "保存研究结论"}
          </button>
        )}
        {dirty ? (
          <span>保存研究结论后可加入创意项目。</span>
        ) : (
          <Link
            className="research-creative-link"
            href={`/creative-designs/canvas?research=${itemId}${readonly ? `&snapshot=${snapshotId}&study=${matchingRevision?.id ?? "none"}` : ""}`}
          >
            加入创意项目
          </Link>
        )}
        {readonly && <Link href={`/research?item=${itemId}`}>查看最新资料</Link>}
      </footer>
      <details>
        <summary>关联创意项目 · {workspace.projects.length}</summary>
        {workspace.projects.length ? (
          <ul>
            {workspace.projects.map((project) => (
              <li key={project.id}>
                <Link href={`/creative-designs/canvas?brief=${project.id}`}>{project.name}</Link>
              </li>
            ))}
          </ul>
        ) : (
          <p>暂无可查看的关联项目。</p>
        )}
      </details>
    </section>
  );
}
