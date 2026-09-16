"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { Plus, RefreshCw, ArrowLeft, Upload } from "lucide-react";
import {
  CANVAS_BRIDGE,
  CanvasBriefSchema,
  CanvasResultViewSchema,
  CreateCanvasBriefInputSchema,
  type CanvasBrief,
  type CanvasResultView,
} from "@yummyai/contracts/pod/canvas-bridge";
import {
  CreativeRequirementsSchema,
  type CreativeRequirements,
} from "@yummyai/contracts/catalog/artwork";
import type { DevelopmentOptions } from "@yummyai/contracts/catalog/development";
import type {
  ResearchSourceReference,
  ResearchSourceSelection,
} from "@yummyai/contracts/research/creative";
import { resolveSources } from "../research/research-client";
import { ResearchSourcePanel } from "../research/research-source-panel";
import { AssistPanel } from "../ai-assist/assist-panel";
import { adoptCreativeRequirements } from "../ai-assist/assist-adoption";
import {
  fillResearchRequirements,
  researchProjectName,
  researchProjectPrompt,
} from "../research/research-brief";
import { canvasApi } from "./canvas-connection";
import {
  recentCanvasProjects,
  canvasResultSelection,
  nextCanvasPrompt,
  type CanvasBriefRow,
} from "./canvas-workspace-model";
import { CanvasResults } from "./canvas-results";
import { ArtworkFieldsEditor } from "../product-development/artwork-fields-editor";
import { ArtworkAssetPicker } from "../product-development/artwork-asset-picker";
import { ArtworkForm } from "../product-development/development-forms";
import { developmentRequest, modes } from "../product-development/development-client";
import "./canvas-workspace.css";
import "../product-development/development.css";
import "../product-development/artwork-workflow.css";

const tabs = ["需求单", "设计与素材", "定制配置", "审核与交付"];
const blank = () => CreativeRequirementsSchema.parse({ mode: "fixed" });
const message = (e: unknown) => (e instanceof Error ? e.message : "操作失败，请保留内容后重试");

export function CreativeProjectsWorkspace({
  initialBriefId,
  initialResearchSources = [],
  onLegacy,
}: {
  initialBriefId?: string;
  initialResearchSources?: ResearchSourceSelection[];
  onLegacy: () => void;
}) {
  const [rows, setRows] = useState<CanvasBriefRow[]>([]),
    [options, setOptions] = useState<DevelopmentOptions | null>(null);
  const [brief, setBrief] = useState<CanvasBrief | null>(null),
    [results, setResults] = useState<CanvasResultView[]>([]),
    [selected, setSelected] = useState<string[]>([]);
  const [creating, setCreating] = useState(initialResearchSources.length > 0),
    [tab, setTab] = useState(0),
    [search, setSearch] = useState(""),
    [status, setStatus] = useState("all"),
    [modeFilter, setModeFilter] = useState("all"),
    [page, setPage] = useState(0);
  const [name, setName] = useState(""),
    [prompt, setPrompt] = useState(""),
    [negativePrompt, setNegative] = useState(""),
    [references, setReferences] = useState<string[]>([]),
    [requirements, setRequirements] = useState<CreativeRequirements>(() => ({
      ...blank(),
      researchItemIds: initialResearchSources.map((source) => source.researchItemId),
    }));
  const [sourceSelections, setSourceSelections] =
    useState<ResearchSourceSelection[]>(initialResearchSources);
  const [researchSources, setResearchSources] = useState<ResearchSourceReference[]>([]);
  const [sourceLoading, setSourceLoading] = useState(false),
    [sourceError, setSourceError] = useState(""),
    [sourceRetry, setSourceRetry] = useState(0),
    [resolvedSourceKey, setResolvedSourceKey] = useState("");
  const seedFromResearch = useRef(initialResearchSources.length > 0);
  const [analysisScope, setAnalysisScope] = useState("");
  useEffect(() => { setAnalysisScope(crypto.randomUUID()); }, []);
  const sourceRequestKey = JSON.stringify(
    requirements.researchItemIds.map(
      (researchItemId) =>
        sourceSelections.find((source) => source.researchItemId === researchItemId) ?? {
          researchItemId,
        },
    ),
  );
  useEffect(() => {
    if (!creating) return;
    const controller = new AbortController();
    const selections = JSON.parse(sourceRequestKey) as ResearchSourceSelection[];
    setSourceLoading(selections.length > 0);
    setSourceError("");
    setResearchSources([]);
    if (!selections.length) {
      setResolvedSourceKey(sourceRequestKey);
      return;
    }
    void resolveSources(selections, controller.signal)
      .then((sources) => {
        setResearchSources(sources);
        setResolvedSourceKey(sourceRequestKey);
        if (seedFromResearch.current) {
          seedFromResearch.current = false;
          setName((value) => value || researchProjectName(sources));
          setPrompt((value) => value || researchProjectPrompt(sources));
          setRequirements((value) => fillResearchRequirements(value, sources));
        }
      })
      .catch((e: unknown) => {
        if (!controller.signal.aborted) setSourceError(message(e));
      })
      .finally(() => {
        if (!controller.signal.aborted) setSourceLoading(false);
      });
    return () => controller.abort();
  }, [creating, sourceRequestKey, sourceRetry]);
  const [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [rejectReason, setRejectReason] = useState(""),
    [registerVersion, setRegisterVersion] = useState(""),
    [sourceKind, setSourceKind] = useState("owned"),
    [sourceReference, setSourceReference] = useState("");
  const upload = useRef<HTMLInputElement>(null),
    requests = useRef(new Map<string, string>()),
    currentId = useRef(initialBriefId),
    generation = useRef(0);
  function requestId(value: unknown) {
    const key = JSON.stringify(value);
    const id = requests.current.get(key) ?? crypto.randomUUID();
    requests.current.set(key, id);
    return id;
  }
  function remember(id?: string) {
    currentId.current = id;
    const u = new URL(location.href);
    u.searchParams.delete("research");
    u.searchParams.delete("snapshot");
    u.searchParams.delete("study");
    if (id) u.searchParams.set("brief", id);
    else u.searchParams.delete("brief");
    history.replaceState(history.state, "", u);
  }
  const load = useCallback(async (id?: string) => {
    const serial = ++generation.current;
    const [list, opts, b, r] = await Promise.all([
      canvasApi("briefs"),
      developmentRequest<DevelopmentOptions>("options"),
      id ? canvasApi(`briefs/${id}`) : Promise.resolve(null),
      id ? canvasApi(`briefs/${id}/results`) : Promise.resolve(null),
    ]);
    if (serial !== generation.current) return;
    setRows(list as unknown as CanvasBriefRow[]);
    setOptions(opts);
    setBrief(b ? CanvasBriefSchema.parse(b) : null);
    setResults(r ? CanvasResultViewSchema.array().parse(r.items) : []);
  }, []);
  useEffect(() => {
    void load(currentId.current)
      .catch((e) => setError(message(e)))
      .finally(() => setLoading(false));
    return () => {
      generation.current++;
    };
  }, [load]);
  useEffect(() => {
    const guard = (e: BeforeUnloadEvent) => {
      if (creating && (name || prompt)) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [creating, name, prompt]);
  async function perform(fn: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await fn();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  async function open(id: string) {
    remember(id);
    setCreating(false);
    setSelected([]);
    setRegisterVersion("");
    setTab(0);
    await load(id);
  }
  function createNew(copy = false) {
    setAnalysisScope(crypto.randomUUID());
    seedFromResearch.current = false;
    remember();
    setCreating(true);
    setTab(0);
    setError("");
    setNotice("");
    setName(copy && brief ? `${brief.name} · 新需求` : "");
    setPrompt(copy ? (brief?.prompt ?? "") : "");
    setNegative(copy ? (brief?.negativePrompt ?? "") : "");
    setReferences(copy ? (brief?.referenceAssets.map((a) => a.id) ?? []) : []);
    setRequirements(copy ? (brief?.workflow?.requirements ?? blank()) : blank());
    setSourceSelections(
      copy
        ? (brief?.workflow?.researchReferences?.map(
            ({ researchItemId, snapshotId, studyRevisionId }) => ({
              researchItemId,
              snapshotId,
              studyRevisionId,
            }),
          ) ?? [])
        : [],
    );
    setBrief(null);
    setResults([]);
  }
  async function save() {
    if (
      requirements.researchItemIds.length &&
      (sourceLoading ||
        sourceError ||
        resolvedSourceKey !== sourceRequestKey ||
        researchSources.length !== requirements.researchItemIds.length)
    ) {
      setError("请先成功读取全部研究来源，确认采用的版本后再保存需求。");
      return;
    }
    const payload = {
      name,
      prompt,
      negativePrompt,
      referenceAssetIds: references,
      templateKey: "freeform",
      requirements,
      ...(analysisScope ? { analysisScopeId: analysisScope } : {}),
      researchSources: researchSources.map(({ researchItemId, snapshotId, studyRevisionId }) => ({
        researchItemId,
        snapshotId,
        studyRevisionId,
      })),
    };
    const parsed = CreateCanvasBriefInputSchema.safeParse({
      ...payload,
      requestId: requestId(payload),
    });
    if (!parsed.success) {
      setError(parsed.error.issues.map((i) => i.message).join("；"));
      return;
    }
    await perform(async () => {
      const b = CanvasBriefSchema.parse(await canvasApi("briefs", parsed.data));
      await open(b.id);
      setTab(1);
      setNotice("需求已保存。可以上传设计文件，或进入画布与生图工具开始制作。");
    });
  }
  async function submitFile(file: File) {
    if (!brief) return;
    if (!sourceReference.trim()) {
      setError("请填写设计文件的来源说明");
      return;
    }
    if (file.size > CANVAS_BRIDGE.maxImageBytes) {
      setError("设计方案最大 20 MiB；分层 PSD 在登记印花时作为源文件上传。");
      return;
    }
    await perform(async () => {
      const contentBase64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(",")[1]!);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      const payload = {
        title: file.name,
        contentBase64,
        sourceKind,
        sourceReference: sourceReference.trim(),
        rightsAttested: true,
        sourceNodeId: `upload:${file.name}`,
        protocolVersion: 1,
        pluginVersion: CANVAS_BRIDGE.pluginVersion,
        upstreamVersion: CANVAS_BRIDGE.upstreamVersion,
      };
      await canvasApi(`briefs/${brief.id}/results`, {
        ...payload,
        submissionId: requestId(payload),
      });
      await load(brief.id);
      setTab(3);
      setNotice("设计方案已上传，等待审核。");
    });
    if (upload.current) upload.current.value = "";
  }
  const selectedResults = canvasResultSelection(results, selected);
  async function review(decision: "approve" | "reject") {
    if (!brief) return;
    await perform(async () => {
      const r = await canvasApi(`briefs/${brief.id}/review`, {
        versionIds: selectedResults.pending.map((r) => r.versionId),
        decision,
        ...(decision === "reject" ? { rejectionReason: rejectReason } : {}),
      });
      const outcomes = r.outcomes as Array<{ ok: boolean }>;
      await load(brief.id);
      setNotice(
        `已${decision === "approve" ? "批准" : "退回"} ${outcomes.filter((o) => o.ok).length} 个方案。`,
      );
    });
  }
  const allProjects = recentCanvasProjects(rows);
  const filtered = allProjects.filter(
    (p) =>
      p.name.toLowerCase().includes(search.toLowerCase()) &&
      (modeFilter === "all" || (p.latest.workflow?.requirements?.mode ?? "fixed") === modeFilter) &&
      (status === "all" ||
        (status === "review"
          ? p.latest.status === "awaiting_review"
          : status === "approved"
            ? p.latest.status === "completed"
            : p.latest.status === "running")),
  );
  const req = creating ? requirements : brief?.workflow?.requirements;
  const approved = results.filter((r) => r.status === "approved"),
    registered =
      options?.artworks.filter((a) => approved.some((r) => r.versionId === a.creativeVersionId)) ??
      [];
  const selectedPreview =
    results.find((r) => r.versionId === selected[0])?.previewPath ?? results[0]?.previewPath;
  const active = creating || !!brief;
  return (
    <main className="canvas-erp-workspace creative-project-workspace" aria-busy={busy || loading}>
      <header className="canvas-erp-header">
        <div>
          <h1>创意项目</h1>
          <p>开发印花与定制模板，审核后交付印花库，供商品开发和订单设计复用。</p>
        </div>
        <div className="canvas-actions">
          <button disabled={busy} onClick={() => void perform(() => load(currentId.current))}>
            <RefreshCw size={15} />
            刷新
          </button>
          <button className="primary" disabled={busy} onClick={() => createNew()}>
            <Plus size={15} />
            新建创意项目
          </button>
        </div>
      </header>
      {error && (
        <p role="alert" className="canvas-notice error">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="canvas-notice">
          {notice}
        </p>
      )}
      {!active ? (
        <section className="art-project-list">
          <div className="art-list-filters">
            <label>
              搜索项目
              <input
                placeholder="项目名称"
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setPage(0);
                }}
              />
            </label>
            <label>
              定制类型
              <select
                value={modeFilter}
                onChange={(e) => {
                  setModeFilter(e.target.value);
                  setPage(0);
                }}
              >
                <option value="all">全部类型</option>
                {Object.entries(modes).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
            </label>
            <label>
              项目状态
              <select
                value={status}
                onChange={(e) => {
                  setStatus(e.target.value);
                  setPage(0);
                }}
              >
                <option value="all">全部状态</option>
                <option value="design">设计中</option>
                <option value="review">待审核</option>
                <option value="approved">已完成审核</option>
              </select>
            </label>
          </div>
          {loading ? (
            <p role="status">正在读取项目…</p>
          ) : !filtered.length ? (
            <div className="canvas-empty">暂无匹配项目。点击“新建创意项目”，从需求单开始。</div>
          ) : (
            <div className="art-project-table">
              {filtered.slice(page * 15, page * 15 + 15).map((p) => (
                <button
                  key={p.rootId}
                  className="art-project-row"
                  onClick={() => void perform(() => open(p.latest.id))}
                >
                  <span className="art-project-thumb">
                    {p.latest.resultCount ? (
                      <Image
                        src={`/api/canvas-bridge/briefs/${p.latest.id}/thumbnail`}
                        alt=""
                        width={52}
                        height={52}
                        unoptimized
                      />
                    ) : (
                      <Plus size={22} />
                    )}
                  </span>
                  <span>
                    <strong>{p.name}</strong>
                    <small>
                      {modes[p.latest.workflow?.requirements?.mode ?? "fixed"]} ·{" "}
                      {new Date(p.latest.createdAt).toLocaleDateString("zh-CN")}
                    </small>
                  </span>
                  <span className="art-project-state">
                    {p.latest.status === "cancelled"
                      ? "已取消"
                      : p.latest.status === "completed"
                        ? "已完成审核"
                        : p.latest.resultCount
                          ? "待审核"
                          : "设计中"}
                    <small>
                      {p.latest.approvedCount ?? 0}/{p.latest.resultCount} 个方案已通过
                    </small>
                  </span>
                </button>
              ))}
            </div>
          )}
          {filtered.length > 15 && (
            <div className="canvas-actions">
              <button disabled={!page} onClick={() => setPage((p) => p - 1)}>
                上一页
              </button>
              <span>
                {page + 1} / {Math.ceil(filtered.length / 15)}
              </span>
              <button
                disabled={(page + 1) * 15 >= filtered.length}
                onClick={() => setPage((p) => p + 1)}
              >
                下一页
              </button>
            </div>
          )}
        </section>
      ) : (
        <>
          <div className="art-project-heading">
            <button
              disabled={busy}
              onClick={() => {
                if (creating && (name || prompt) && !confirm("尚未保存需求，确定返回？")) return;
                remember();
                setCreating(false);
                setBrief(null);
                setResults([]);
              }}
            >
              <ArrowLeft size={15} />
              返回项目列表
            </button>
            <div>
              <h2>{creating ? "新建创意项目" : brief?.name}</h2>
              <p className="canvas-help">
                {creating
                  ? "先说明要交付什么，再配置素材与定制要求。"
                  : `${req ? modes[req.mode] : "历史创意需求"} · ${registered.length ? `已登记 ${registered.length} 个印花 SKU` : approved.length ? "已审核，可登记印花" : "设计与审核中"}`}
              </p>
            </div>
            {!creating && (
              <button disabled={busy} onClick={() => createNew(true)}>
                复制为新需求
              </button>
            )}
          </div>
          <nav className="art-project-tabs" aria-label="创意项目环节">
            {tabs.map((t, i) => (
              <button
                key={t}
                type="button"
                aria-current={tab === i ? "page" : undefined}
                onClick={() => setTab(i)}
              >
                {t}
              </button>
            ))}
          </nav>
          <section className="art-project-panel">
            {tab === 0 && (
              <>
                <div className="art-requirements-form">
                  <label>
                    项目名称
                    <input
                      value={creating ? name : (brief?.name ?? "")}
                      disabled={!creating || busy}
                      maxLength={160}
                      onChange={(e) => setName(e.target.value)}
                    />
                  </label>
                  <label>
                    定制类型
                    <select
                      value={req?.mode ?? "fixed"}
                      aria-label="定制类型"
                      disabled={!creating || busy}
                      onChange={(e) => {
                        const mode = e.target.value as CreativeRequirements["mode"];
                        setRequirements((v) => ({
                          ...v,
                          mode,
                          ...(mode === "fixed"
                            ? { customization: { version: 1, fields: [] }, layout: [] }
                            : {}),
                        }));
                      }}
                    >
                      {Object.entries(modes).map(([k, v]) => (
                        <option key={k} value={k}>
                          {v}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="art-wide">
                    创意方向与制作要求
                    <textarea
                      rows={4}
                      value={creating ? prompt : (brief?.prompt ?? "")}
                      aria-label="创意方向与制作要求"
                      disabled={!creating || busy}
                      maxLength={8000}
                      placeholder="例如：复古花卉宠物纪念主题，主体居中，为名字与纪念日期留出位置"
                      onChange={(e) => setPrompt(e.target.value)}
                    />
                  </label>
                  {req &&
                    (
                      [
                        ["audience", "目标人群"],
                        ["occasion", "使用场景"],
                        ["style", "风格与配色"],
                        ["fixedElements", "固定图案与元素"],
                        ["imageInstructions", "图片处理要求"],
                        ["acceptance", "交付与验收要求"],
                      ] as const
                    ).map(([k, title]) => (
                      <label key={k}>
                        {title}
                        <textarea
                          rows={2}
                          disabled={!creating || busy}
                          value={req[k]}
                          aria-label={title}
                          maxLength={
                            k === "acceptance"
                              ? 3000
                              : k === "fixedElements" || k === "imageInstructions"
                                ? 2000
                                : k === "style"
                                  ? 1000
                                  : 500
                          }
                          onChange={(e) => setRequirements((v) => ({ ...v, [k]: e.target.value }))}
                        />
                      </label>
                    ))}
                  <label>
                    避免的内容
                    <textarea
                      rows={2}
                      disabled={!creating || busy}
                      value={creating ? negativePrompt : (brief?.negativePrompt ?? "")}
                      maxLength={4000}
                      onChange={(e) => setNegative(e.target.value)}
                    />
                  </label>
                  <label>
                    选品研究来源
                    <select
                      multiple
                      size={4}
                      disabled={!creating || busy}
                      value={req?.researchItemIds ?? []}
                      aria-label="选品研究来源"
                      onChange={(e) =>
                        setRequirements((v) => ({
                          ...v,
                          researchItemIds: Array.from(e.target.selectedOptions).map((o) => o.value),
                        }))
                      }
                    >
                      {[
                        ...(options?.researchItems ?? []),
                        ...researchSources
                          .filter(
                            (source) =>
                              !options?.researchItems.some(
                                (item) => item.id === source.researchItemId,
                              ),
                          )
                          .map((source) => ({ id: source.researchItemId, title: source.title })),
                      ].map((r) => (
                        <option key={r.id} value={r.id}>
                          {r.title}
                        </option>
                      ))}
                    </select>
                    <small>可多选；下方预览本次采用的快照与研究结论。</small>
                  </label>
                </div>
                {(creating ? analysisScope : brief?.workflow?.analysisScopeId ?? brief?.id) && req && <AssistPanel
                  kind="creative"
                  scope={`creative:${creating ? analysisScope : brief?.workflow?.analysisScopeId ?? brief?.id}`}
                  input={{ kind: "creative", scopeId: creating ? analysisScope : brief?.workflow?.analysisScopeId ?? brief!.id, prompt: creating ? prompt : brief!.prompt, requirements: req, sources: (creating ? researchSources : brief?.workflow?.researchReferences ?? []).map(({ researchItemId, snapshotId, studyRevisionId }) => ({ researchItemId, snapshotId, studyRevisionId })) }}
                  disabledReason={busy ? "请等待当前保存完成" : creating && (sourceLoading || !!sourceError) ? "请先完整读取所选研究来源" : !(creating ? researchSources : brief?.workflow?.researchReferences ?? []).length ? "请先在研究来源中选择至少一份竞品资料" : (creating ? researchSources : brief?.workflow?.researchReferences ?? []).length > 8 ? "每次最多分析 8 份研究资料，请减少来源" : undefined}
                  onDirection={creating ? (direction, fields) => {
                    try {
                      const next = adoptCreativeRequirements(requirements, direction, fields);
                      if (fields.includes("prompt")) setPrompt(direction.prompt);
                      if (fields.includes("negativePrompt")) setNegative(direction.negativePrompt);
                      setRequirements(next);
                      setNotice("AI 建议已填入勾选字段，请核对需求并保存项目。");
                      return true;
                    } catch (cause) { setError(message(cause)); return false; }
                  } : undefined}
                />}
                {!creating && <p className="canvas-help">需要采用新的 AI 方向时，使用“复制为新需求”保留当前项目版本。</p>}
                <ResearchSourcePanel
                  sources={creating ? researchSources : (brief?.workflow?.researchReferences ?? [])}
                  historicalIds={creating ? [] : (req?.researchItemIds ?? [])}
                  loading={creating && sourceLoading}
                  error={creating ? sourceError : undefined}
                  onRetry={creating ? () => setSourceRetry((v) => v + 1) : undefined}
                  onFill={
                    creating
                      ? () => {
                          setRequirements((value) =>
                            fillResearchRequirements(value, researchSources),
                          );
                          setPrompt((value) => value || researchProjectPrompt(researchSources));
                          setNotice("研究结论已填入空白需求项，请复核定制类型与制作要求。");
                        }
                      : undefined
                  }
                />
                <details className="art-spec-targets">
                  <summary>
                    计划适配的 SPU 与规格（可选） · {req?.specificationVersionIds.length ?? 0} 个
                  </summary>
                  <p className="canvas-help">
                    先设计后绑定销售 SKU。这里选择规格供设计参考，后续在产品开发中逐规格确认工艺。
                  </p>
                  {[...new Set(options?.specifications.map((s) => s.spuId) ?? [])].map((id) => (
                    <fieldset key={id} disabled={!creating || busy}>
                      <legend>{options?.spus.find((s) => s.id === id)?.name}</legend>
                      {options?.specifications
                        .filter((s) => s.spuId === id)
                        .map((s) => (
                          <label className="canvas-check" key={s.versionId}>
                            <input
                              type="checkbox"
                              checked={req?.specificationVersionIds.includes(s.versionId) ?? false}
                              onChange={(e) =>
                                setRequirements((v) => ({
                                  ...v,
                                  specificationVersionIds: e.target.checked
                                    ? [...v.specificationVersionIds, s.versionId]
                                    : v.specificationVersionIds.filter((id) => id !== s.versionId),
                                }))
                              }
                            />
                            {s.name} · {s.facts.dimensions} · {s.processName}
                          </label>
                        ))}
                    </fieldset>
                  ))}
                </details>
              </>
            )}
            {tab === 1 &&
              (creating ? (
                <>
                  <h2>授权参考素材</h2>
                  <p className="canvas-help">
                    支持上传参考图，也可以在保存需求后直接上传完成的设计方案。
                  </p>
                  <ArtworkAssetPicker
                    assets={options?.materialAssets ?? []}
                    selected={references}
                    onChange={setReferences}
                    limit={10}
                    imagesOnly
                    onRefresh={async () =>
                      setOptions(await developmentRequest<DevelopmentOptions>("options"))
                    }
                  />
                </>
              ) : brief ? (
                <>
                  <div className="canvas-actions">
                    <Link
                      className="art-tool-link"
                      href={`/creative-designs/studio/canvas?brief=${brief.id}`}
                    >
                      打开项目画布
                    </Link>
                    <Link
                      className="art-tool-link"
                      href={`/creative-designs/studio/image?brief=${brief.id}`}
                    >
                      AI 生图
                    </Link>
                    <Link
                      className="art-tool-link"
                      href={`/creative-designs/studio/assets?brief=${brief.id}`}
                    >
                      项目素材
                    </Link>
                  </div>
                  <h3>上传设计方案</h3>
                  <div className="art-upload">
                    <label>
                      方案来源
                      <select value={sourceKind} onChange={(e) => setSourceKind(e.target.value)}>
                        <option value="owned">自有设计</option>
                        <option value="licensed">授权设计</option>
                        <option value="ai_generated">AI 生成</option>
                      </select>
                    </label>
                    <label>
                      来源说明
                      <input
                        value={sourceReference}
                        maxLength={500}
                        onChange={(e) => setSourceReference(e.target.value)}
                        placeholder="作者、许可或生成记录"
                      />
                    </label>
                    <input
                      ref={upload}
                      aria-label="上传设计方案文件"
                      type="file"
                      hidden
                      accept="image/png,image/jpeg,image/webp"
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (f) void submitFile(f);
                      }}
                    />
                    <button
                      disabled={
                        busy ||
                        !sourceReference.trim() ||
                        brief.resultCount >= 4 ||
                        !!brief.nextBriefId ||
                        brief.status === "cancelled"
                      }
                      onClick={() => upload.current?.click()}
                    >
                      <Upload size={15} />
                      上传 PNG / JPG / WebP
                    </button>
                  </div>
                  <p className="canvas-help">
                    每个步骤最多 4 个方案。分层 PSD、字体与其他源文件在“审核与交付 →
                    登记印花”中绑定。
                  </p>
                  {!!results.length && (
                    <CanvasResults
                      results={results}
                      selected={selected}
                      onSelection={setSelected}
                      disabled={busy}
                    />
                  )}
                  <details>
                    <summary>本项目参考素材 · {brief.referenceAssets.length}</summary>
                    <div className="art-asset-grid">
                      {brief.referenceAssets.map((a) => (
                        <div key={a.id} className="art-asset-option">
                          <Image
                            src={`/api/product-development/assets/${a.id}/preview`}
                            alt=""
                            width={64}
                            height={64}
                            unoptimized
                          />
                          <span>{a.fileName}</span>
                        </div>
                      ))}
                    </div>
                  </details>
                </>
              ) : null)}
            {tab === 2 &&
              (req?.mode === "fixed" ? (
                <p className="canvas-empty">
                  固定印花直接复用审核后的图案。选择文字、图片或图文定制后，在这里配置买家字段。
                </p>
              ) : req ? (
                <ArtworkFieldsEditor
                  value={req.customization}
                  layout={req.layout}
                  disabled={!creating || busy}
                  onChange={(customization, layout) =>
                    setRequirements((v) => ({ ...v, customization, layout }))
                  }
                  previewPath={selectedPreview}
                />
              ) : (
                <p className="canvas-help">
                  此历史项目未配置定制需求。可复制为新需求，或在登记印花时补齐定制字段和区域。
                </p>
              ))}
            {tab === 3 &&
              (creating ? (
                <>
                  <h2>确认交付要求</h2>
                  <p>
                    将建立“{name || "未命名项目"}”，交付类型为{modes[requirements.mode]}，包含{" "}
                    {requirements.customization.fields.length} 个定制字段、{references.length}{" "}
                    项参考素材。
                  </p>
                  <p className="canvas-help">
                    设计方案审核通过后，登记印花 SKU 与素材包，供商品组合和订单设计使用。
                  </p>
                </>
              ) : brief ? (
                <>
                  <h2>方案审核</h2>
                  {results.length ? (
                    <>
                      <CanvasResults
                        results={results}
                        selected={selected}
                        onSelection={setSelected}
                        disabled={busy}
                      />
                      <div className="canvas-actions">
                        <button
                          className="primary"
                          disabled={busy || !selectedResults.pending.length}
                          onClick={() => void review("approve")}
                        >
                          批准选中方案
                        </button>
                        <label>
                          退回原因
                          <input
                            value={rejectReason}
                            maxLength={1000}
                            onChange={(e) => setRejectReason(e.target.value)}
                          />
                        </label>
                        <button
                          disabled={busy || !selectedResults.pending.length || !rejectReason.trim()}
                          onClick={() => void review("reject")}
                        >
                          退回选中方案
                        </button>
                      </div>
                    </>
                  ) : (
                    <p className="canvas-empty">
                      还没有设计方案。请先上传设计文件或在项目画布中提交。
                    </p>
                  )}
                  {!!brief.nextBriefId && (
                    <button onClick={() => void perform(() => open(brief.nextBriefId!))}>
                      打开已有下一步
                    </button>
                  )}
                  {!brief.nextBriefId &&
                    brief.workflow &&
                    brief.workflow.stepIndex + 1 < brief.workflow.template.steps.length && (
                      <button
                        disabled={
                          busy || !!selectedResults.unreviewed || !selectedResults.approved.length
                        }
                        onClick={() =>
                          void perform(async () => {
                            const b = CanvasBriefSchema.parse(
                              await canvasApi(`briefs/${brief.id}/continue`, {
                                versionIds: selectedResults.approved.map((r) => r.versionId),
                                prompt: nextCanvasPrompt(brief),
                              }),
                            );
                            await open(b.id);
                            setTab(1);
                          })
                        }
                      >
                        继续精修选中方案
                      </button>
                    )}
                  {!!registered.length && (
                    <div className="canvas-notice">
                      已登记：
                      {registered.map((a) => (
                        <span key={a.id}>
                          <Link href={`/print-library?artwork=${a.id}`}>{a.code} · V{a.version}</Link>
                          <Link href={`/product-development?compose=1&artworkVersionId=${a.versionId}`}>用 {a.code} 组合商品</Link>
                        </span>
                      ))}
                    </div>
                  )}
                  {!!approved.length && options && (
                    <section className="art-delivery">
                      <h2>登记印花与素材包</h2>
                      <p className="canvas-help">
                        选定审核过的方案，补齐源文件。订单绑定这个印花 SKU 后，美工和 Agent
                        会自动取得对应素材。
                      </p>
                      <label>
                        交付方案
                        <select
                          value={registerVersion}
                          onChange={(e) => setRegisterVersion(e.target.value)}
                        >
                          <option value="">请选择已通过方案</option>
                          {approved.map((r) => (
                            <option key={r.versionId} value={r.versionId}>
                              {r.name}
                            </option>
                          ))}
                        </select>
                      </label>
                      {registerVersion && (
                        <ArtworkForm
                          key={registerVersion}
                          options={{
                            ...options,
                            creativeVersions: options.creativeVersions.filter(
                              (v) => v.id === registerVersion,
                            ),
                          }}
                          value={null}
                          initialCreativeVersionId={registerVersion}
                          requirements={req}
                          busy={busy}
                          onSave={async (body) => {
                            let ok = false;
                            await perform(async () => {
                              await developmentRequest("artworks", {
                                ...body,
                                idempotencyKey: requestId(body),
                              });
                              await load(brief.id);
                              setRegisterVersion("");
                              setNotice("印花 SKU 与素材包已登记，可用于商品组合和订单匹配。");
                              ok = true;
                            });
                            return ok;
                          }}
                        />
                      )}
                    </section>
                  )}
                </>
              ) : null)}
            {creating && (
              <footer className="art-project-footer">
                <span>{tabs[tab]}</span>
                {tab > 0 && (
                  <button disabled={busy} onClick={() => setTab((t) => t - 1)}>
                    上一步
                  </button>
                )}
                {tab < 3 ? (
                  <button className="primary" onClick={() => setTab((t) => t + 1)}>
                    下一步
                  </button>
                ) : (
                  <button
                    className="primary"
                    disabled={busy || !options}
                    onClick={() => void save()}
                  >
                    保存需求并开始设计
                  </button>
                )}
              </footer>
            )}
          </section>
        </>
      )}
      <details className="canvas-setup">
        <summary>历史创作与工具</summary>
        <button onClick={onLegacy}>打开原创作工作台</button>
        <Link href="/order-artwork">订单设计任务</Link>
        <Link href="/pod-workbench/mockup-batches">商品套图与 PSD 模板</Link>
      </details>
    </main>
  );
}
