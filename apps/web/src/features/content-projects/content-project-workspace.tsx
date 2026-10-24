"use client";

import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import Image from "next/image";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, ArrowUpRight, Check, FileText, Plus, RefreshCw, Search } from "lucide-react";
import {
  ContentProjectListSchema,
  ContentProjectSchema,
  ContentStageKeySchema,
  type ContentProject,
  type ContentStage,
} from "@yummyai/contracts/catalog/content-project";
import { EntityIdSchema } from "@yummyai/contracts/common/ids";
import { useBreadcrumbDetail } from "../navigation/breadcrumb-details";
import { workflowHref } from "../navigation/workflow-href";
import "./content-projects.css";
import { PillowProjectWorkspace } from "./pillow-project-workspace";

type ProjectList = ReturnType<typeof ContentProjectListSchema.parse>;
const statusNames: Record<ContentStage["status"], string> = {
  not_started: "待开始",
  in_progress: "进行中",
  complete: "已完成",
  blocked: "待处理",
  unauthorized: "无权限",
  optional: "可选",
};
const designNames: Record<string, string> = {
  adapting: "适配中",
  pending_review: "待审核",
  approved: "已批准",
  rejected: "已退回",
};
const recipeNames: Record<string, string> = {
  pending_adaptation: "待制作",
  in_adaptation: "制作中",
  ready_for_customization: "定制方案已确认",
  approved: "制作已审核",
};
const mockupNames: Record<string, string> = {
  queued: "排队中",
  running: "制作中",
  awaiting_review: "待审核",
  partially_succeeded: "部分成功",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
};
const date = (value: string) => {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? "时间未提供"
    : parsed.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
};
async function read(path: string, signal: AbortSignal) {
  const response = await fetch(`/api/content-projects${path}`, { cache: "no-store", signal });
  const data = await response.json();
  if (!response.ok)
    throw new Error(typeof data.message === "string" ? data.message : "图文项目读取失败");
  return data;
}

export function ContentProjectWorkspace() {
  const params = useSearchParams();
  const pillow = params.get("view") === "pillow";
  return <>
    <nav className="cp-workspaces" aria-label="商品项目类型">
      <Link href="/content-projects" aria-current={!pillow ? "page" : undefined}>图文开发</Link>
      <Link href="/content-projects?view=pillow" aria-current={pillow ? "page" : undefined}>异形抱枕</Link>
    </nav>
    {pillow ? <PillowProjectWorkspace /> : <CreativeContentProjectWorkspace />}
  </>;
}

function CreativeContentProjectWorkspace() {
  const params = useSearchParams(),
    router = useRouter();
  const projectId = params.get("project"),
    q = params.get("q") ?? "";
  const page = Math.max(1, Math.min(10000, Number(params.get("page")) || 1));
  const parsedStage = ContentStageKeySchema.safeParse(params.get("stage"));
  const stageKey = parsedStage.success ? parsedStage.data : "research";
  const [search, setSearch] = useState(q),
    [retry, setRetry] = useState(0);
  const [list, setList] = useState<ProjectList | null>(null),
    [project, setProject] = useState<ContentProject | null>(null);
  const [loading, setLoading] = useState(true),
    [error, setError] = useState("");
  useBreadcrumbDetail(projectId ? `/content-projects:${projectId}` : null, project?.name);
  useEffect(() => {
    setSearch(q);
  }, [q]);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    setProject(null);
    setList(null);
    if (projectId && !EntityIdSchema.safeParse(projectId).success) {
      setError("图文项目编号无效，请返回项目列表选择");
      setLoading(false);
      return;
    }
    void (
      projectId
        ? read(`/${projectId}`, controller.signal)
        : read(`?${new URLSearchParams({ q, page: String(page) })}`, controller.signal)
    )
      .then((data) => {
        if (!controller.signal.aborted) {
          if (projectId) setProject(ContentProjectSchema.parse(data));
          else setList(ContentProjectListSchema.parse(data));
        }
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted)
          setError(cause instanceof Error ? cause.message : "图文项目读取失败");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [projectId, q, page, retry]);
  function href(values: Record<string, string | null>) {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(values))
      if (value === null) next.delete(key);
      else next.set(key, value);
    return `/content-projects${next.size ? `?${next}` : ""}`;
  }
  const current = href({});
  const link = (target: string) => workflowHref(target, current);
  const listHref = href({ project: null, stage: null });
  function searchProjects(event: FormEvent) {
    event.preventDefault();
    router.replace(href({ q: search.trim() || null, page: null }));
  }
  const stage = project?.stages.find((s) => s.key === stageKey);
  return (
    <main className="cp-page" aria-busy={loading}>
      <header className="cp-header">
        <div>
          {projectId && (
            <Link className="cp-back" href={listHref}>
              <ArrowLeft size={14} />
              返回图文项目
            </Link>
          )}
          <h1>{project?.name ?? "商品图文项目"}</h1>
          <p>
            {project
              ? `从创意需求到审核资料包 · 更新于 ${date(project.updatedAt)}`
              : "在一个项目中跟进研究、原创设计、商品套图与刊登资料。"}
          </p>
        </div>
        <div className="cp-actions">
          <button type="button" onClick={() => setRetry((n) => n + 1)} disabled={loading}>
            <RefreshCw size={15} />
            刷新进度
          </button>
          <Link
            className="cp-primary"
            href={workflowHref("/creative-designs/canvas?new=1", "/content-projects")}
          >
            <Plus size={15} />
            新建图文项目
          </Link>
        </div>
      </header>
      {error && (
        <div className="cp-message cp-error" role="alert">
          <span>{error}</span>
          <button onClick={() => setRetry((n) => n + 1)}>重新读取</button>
        </div>
      )}
      {loading && (
        <p className="cp-message" role="status">
          正在读取{projectId ? "项目资料与版本关系" : "图文项目列表"}…
        </p>
      )}
      {!projectId && !loading && !error && list && (
        <>
          <form className="cp-filters" onSubmit={searchProjects}>
            <label htmlFor="cp-search">项目名称</label>
            <div className="cp-search">
              <Search size={15} />
              <input
                id="cp-search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                maxLength={200}
                placeholder="搜索创意项目"
              />
            </div>
            <button type="submit">查询</button>
            <span>共 {list.total} 个项目</span>
          </form>
          {list.items.length ? (
            <div className="cp-table-wrap">
              <table className="cp-table">
                <thead>
                  <tr>
                    <th>项目</th>
                    <th>当前创作步骤</th>
                    <th>当前候选</th>
                    <th>已批准</th>
                    <th>最近更新</th>
                  </tr>
                </thead>
                <tbody>
                  {list.items.map((item) => (
                    <tr key={item.id}>
                      <td data-label="项目">
                        <Link href={href({ project: item.id, stage: "research" })}>
                          {item.name}
                          <ArrowUpRight size={13} />
                        </Link>
                      </td>
                      <td data-label="当前创作步骤">{item.stepName}</td>
                      <td data-label="当前候选">{item.resultCount}</td>
                      <td data-label="已批准">{item.approvedCount}</td>
                      <td data-label="最近更新">{date(item.updatedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="cp-empty">
              <FileText size={24} />
              <h2>{q ? "没有匹配的项目" : "开始第一个商品图文项目"}</h2>
              <p>
                {q
                  ? "调整项目名称后重新查询。"
                  : "从研究资料建立需求，或直接创建原创设计需求；选款批准后再关联商品与 SKU。"}
              </p>
              <Link href={link(q ? "/content-projects" : "/creative-designs/canvas?new=1")}>
                {q ? "查看全部项目" : "创建项目"}
              </Link>
            </div>
          )}
          {list.total > list.pageSize && (
            <nav className="cp-pagination" aria-label="图文项目分页">
              {page > 1 && <Link href={href({ page: String(page - 1) })}>上一页</Link>}
              <span>
                第 {page} / {Math.ceil(list.total / list.pageSize)} 页
              </span>
              {page * list.pageSize < list.total && (
                <Link href={href({ page: String(page + 1) })}>下一页</Link>
              )}
            </nav>
          )}
        </>
      )}
      {project && !loading && !error && (
        <>
          {!!project.diagnostics.length && (
            <div className="cp-message cp-warning" role="status">
              {project.diagnostics.join("；")}
            </div>
          )}
          <nav className="cp-stages" aria-label="商品图文流程">
            {project.stages.map((item, i) => (
              <Link
                key={item.key}
                href={href({ stage: item.key })}
                aria-current={stageKey === item.key ? "step" : undefined}
                data-status={item.status}
              >
                <span className="cp-step-number">
                  {item.status === "complete" ? <Check size={14} /> : i + 1}
                </span>
                <span>
                  <strong>{item.label}</strong>
                  <small>{statusNames[item.status]}</small>
                </span>
              </Link>
            ))}
          </nav>
          <div className="cp-detail-layout">
            <section className="cp-stage-panel" aria-labelledby="cp-stage-title">
              <header className="cp-section-header">
                <div>
                  <h2 id="cp-stage-title">{stage?.label}</h2>
                  <p>{stage?.detail}</p>
                </div>
                <span className="cp-status" data-status={stage?.status}>
                  {stage && statusNames[stage.status]}
                </span>
              </header>
              <StageContent project={project} stageKey={stageKey} link={link} />
            </section>
            <aside className="cp-context" aria-label="项目任务书">
              <h2>项目任务书</h2>
              <p className="cp-preserve">{project.prompt}</p>
              {project.requirements && (
                <dl>
                  {[
                    ["目标人群", project.requirements.audience],
                    ["使用场景", project.requirements.occasion],
                    ["风格", project.requirements.style],
                    ["保留元素", project.requirements.fixedElements],
                    ["验收要求", project.requirements.acceptance],
                  ]
                    .filter(([, value]) => value)
                    .map(([name, value]) => (
                      <div key={name}>
                        <dt>{name}</dt>
                        <dd>{value}</dd>
                      </div>
                    ))}
                </dl>
              )}
              <Link href={link(`/creative-designs/canvas?brief=${project.briefId}&edit=1`)}>
                编辑项目需求
                <ArrowUpRight size={13} />
              </Link>
            </aside>
          </div>
        </>
      )}
    </main>
  );
}

function StageContent({
  project: p,
  stageKey,
  link,
}: {
  project: ContentProject;
  stageKey: string;
  link: (target: string) => string;
}) {
  const creative = `/creative-designs/canvas?brief=${p.briefId}`;
  const actions = (items: Array<[string, string]>) => (
    <div className="cp-stage-actions">
      {items.map(([label, target]) => (
        <Link key={label} href={link(target)}>
          {label}
          <ArrowUpRight size={13} />
        </Link>
      ))}
    </div>
  );
  const empty = (text: string) => <p className="cp-stage-empty">{text}</p>;
  if (p.stages.find((s) => s.key === stageKey)?.status === "unauthorized")
    return empty("当前账号没有此环节的读取权限。其他有权限的项目资料仍可查看。");
  if (stageKey === "research")
    return (
      <>
        {actions([
          ["编辑项目需求", `${creative}&edit=1`],
          ["打开研究资料库", "/research"],
        ])}
        {p.researchSources.length ? (
          <ul className="cp-source-list">
            {p.researchSources.map((source) => (
              <li key={`${source.researchItemId}:${source.snapshotId}`}>
                <Link
                  href={link(
                    `/research?item=${source.researchItemId}&snapshot=${source.snapshotId}${source.studyRevisionId ? `&study=${source.studyRevisionId}` : ""}`,
                  )}
                >
                  {source.title}
                  <ArrowUpRight size={13} />
                </Link>
                <span>
                  {source.platform.toUpperCase()} · 快照 {date(source.capturedAt)} · 研究笔记{" "}
                  {source.studyRevisionId ? `V${source.studyVersion}` : "未固定"}
                </span>
                {source.content && <p>{source.content.differentiation || source.content.theme}</p>}
              </li>
            ))}
          </ul>
        ) : (
          empty(
            p.legacy
              ? "历史需求没有固定研究快照，保留原始需求即可继续。"
              : "尚未关联研究来源。可直接原创，或在研究库选择资料建立新需求。",
          )
        )}
        <p className="cp-note">研究资料提供方向与证据；设计和刊登图片使用自己的授权素材。</p>
      </>
    );
  if (stageKey === "design")
    return (
      <>
        {actions([
          ["打开项目画布", `/creative-designs/studio/canvas?brief=${p.briefId}`],
          ["设计审核与登记印花", `${creative}&tab=review`],
        ])}
        <nav className="cp-history" aria-label="创作步骤历史">
          {p.steps.map((step) => (
            <Link key={step.id} href={link(`/creative-designs/canvas?brief=${step.id}&tab=review`)}>
              {step.name} · {step.approvedCount}/{step.resultCount} 已批准
            </Link>
          ))}
        </nav>
        {p.results.length ? (
          <div className="cp-results">
            {p.results.map((result) => (
              <article key={result.versionId}>
                <div className="cp-result-image">
                  {p.access.assets ? (
                    <Image
                      src={result.previewPath}
                      alt={result.name}
                      fill
                      unoptimized
                      sizes="(max-width: 700px) 80vw, 240px"
                    />
                  ) : (
                    <span>没有素材预览权限</span>
                  )}
                </div>
                <h3>{result.name}</h3>
                <span>{designNames[result.status]}</span>
                {result.rejectionReason && <p>{result.rejectionReason}</p>}
              </article>
            ))}
          </div>
        ) : (
          empty("当前步骤还没有回传方案。打开画布完成创作，再回传候选供审核。")
        )}
      </>
    );
  if (stageKey === "sku")
    return (
      <>
        {actions([
          ["登记印花与确认定制", `${creative}&tab=review`],
          ["维护商品规格", "/product-specifications"],
        ])}
        {p.artworks.length ? (
          <ul className="cp-artworks">
            {p.artworks.map((a) => (
              <li key={a.versionId}>
                <div>
                  <strong>
                    {a.code} · V{a.version}
                  </strong>
                  <span>{a.name}</span>
                  {(!a.current || a.archived) && (
                    <small className="cp-warning-text">{a.archived ? "已归档" : "历史版本"}</small>
                  )}
                </div>
                <Link href={link(`/print-library?artwork=${a.id}`)}>查看印花</Link>
                {a.current && !a.archived && (
                  <Link
                    href={link(`/product-development?compose=1&artworkVersionId=${a.versionId}`)}
                  >
                    组合商品规格
                  </Link>
                )}
              </li>
            ))}
          </ul>
        ) : (
          empty("批准设计后，先在创意项目的审核与交付环节登记印花。")
        )}
        {p.skus.length > 0 && (
          <div className="cp-table-wrap">
            <table className="cp-table">
              <thead>
                <tr>
                  <th>销售 SKU</th>
                  <th>规格与事实</th>
                  <th>制作版本</th>
                  <th>状态</th>
                </tr>
              </thead>
              <tbody>
                {p.skus.map((s) => (
                  <tr key={s.id}>
                    <td data-label="销售 SKU">
                      <Link href={link(`/product-development?sku=${s.id}`)}>{s.code}</Link>
                      <small>{s.spuName}</small>
                    </td>
                    <td data-label="规格与事实">
                      <strong>{s.specificationName}</strong>
                      <small>
                        {s.material} · {s.dimensions}
                      </small>
                      <small>{s.packageContents}</small>
                      <small>{s.factsConfirmed ? "事实已确认" : "事实待确认"}</small>
                    </td>
                    <td data-label="制作版本">V{s.recipeVersion}</td>
                    <td data-label="状态">
                      {recipeNames[s.status]}
                      {(s.needsUpdate || !s.belongsToProject) && (
                        <small className="cp-warning-text">来源已有新版本</small>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </>
    );
  if (stageKey === "mockup")
    return (
      <>
        {actions([["打开商品套图与模板", "/pod-workbench/mockup-batches"]])}
        {!!p.skus.length && (
          <div className="cp-stage-actions">
            {p.skus
              .filter(
                (s) =>
                  s.status === "approved" &&
                  s.designVersionId &&
                  s.belongsToProject &&
                  !s.needsUpdate,
              )
              .map((s) => (
                <Link
                  key={s.id}
                  href={link(`/pod-workbench/mockup-batches?designVersionId=${s.designVersionId}`)}
                >
                  为 {s.code} 制作套图
                  <ArrowUpRight size={13} />
                </Link>
              ))}
          </div>
        )}
        {p.mockups.length ? (
          <div className="cp-table-wrap">
            <table className="cp-table">
              <thead>
                <tr>
                  <th>销售 SKU</th>
                  <th>必需图片审核</th>
                  <th>失败或退回</th>
                  <th>状态</th>
                </tr>
              </thead>
              <tbody>
                {p.mockups.map((m) => (
                  <tr key={m.itemId}>
                    <td data-label="销售 SKU">
                      <Link href={link(`/pod-workbench/mockup-batches?batch=${m.batchId}`)}>
                        {m.skuCode}
                      </Link>
                      <small>{m.current ? "当前制作版本" : "历史制作版本"}</small>
                    </td>
                    <td data-label="必需图片审核">
                      {m.approvedCount}/{m.requiredCount}
                    </td>
                    <td data-label="失败或退回">{m.failedCount}</td>
                    <td data-label="状态">{mockupNames[m.status] ?? m.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          empty("还没有关联套图批次。完成 SKU 制作审核后，选择批准的商品场景模板。")
        )}
        <p className="cp-note">
          当前受控 PSD 模板服务帆布画；模板适用范围与功能可用性在套图工作台确认。
        </p>
      </>
    );
  if (stageKey === "listing")
    return (
      <>
        {actions(
          p.skus.map(
            (s) =>
              [`从 ${s.code} 准备刊登`, `/product-development?sku=${s.id}`] as [string, string],
          ),
        )}
        {p.listings.length ? (
          <ul className="cp-listings">
            {p.listings.map((l) => (
              <li key={l.id}>
                <div>
                  <Link href={link(`/listings/${l.id}`)}>
                    {l.title || "未填写标题"}
                    <ArrowUpRight size={13} />
                  </Link>
                  <span>
                    {l.platform.toUpperCase()} · {l.locale} · V{l.version} ·{" "}
                    {l.status === "approved" ? "已审核" : "草稿"}
                  </span>
                  <p>
                    {l.blockers.length
                      ? l.blockers.join("；")
                      : "进入内容页签，使用 SKU 资料包助手编辑标题、描述与图片说明。"}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          empty(
            "还没有关联 Listing。从产品开发的销售 SKU 详情创建刊登，商品事实和制作版本会随草稿关联。",
          )
        )}
      </>
    );
  return (
    <>
      {actions(
        p.skus.map(
          (s) => [`核对并封存 ${s.code}`, `/product-development?sku=${s.id}`] as [string, string],
        ),
      )}
      {p.packages.length ? (
        <div className="cp-table-wrap">
          <table className="cp-table">
            <thead>
              <tr>
                <th>销售 SKU</th>
                <th>刊登渠道</th>
                <th>资料包</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {p.packages.map((pack) => (
                <tr key={pack.id}>
                  <td data-label="销售 SKU">{pack.skuCode}</td>
                  <td data-label="刊登渠道">
                    {pack.platform.toUpperCase()} · {pack.locale}
                  </td>
                  <td data-label="资料包">
                    V{pack.version}
                    <small>{pack.current ? "当前版本已封存" : "历史包，当前来源需核对"}</small>
                    <small>{date(pack.createdAt)}</small>
                  </td>
                  <td data-label="操作">
                    {pack.current && p.access.assets ? (
                      <a href={`/api/product-development/packages/${pack.id}/export`}>
                        下载审核资料包
                      </a>
                    ) : (
                      <Link href={link(`/product-development?sku=${pack.skuId}`)}>
                        {p.access.assets ? "查看版本与资料包" : "进入详情核对权限"}
                      </Link>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        empty("尚未封存资料包。审核当前 Listing，核对真实图片证据后在产品开发中封存。")
      )}
      <p className="cp-note">
        交付以固定版本资料包为准。平台发布与实际生产放行分别执行各自的审核流程。
      </p>
    </>
  );
}
