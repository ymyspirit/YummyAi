"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { Plus, RefreshCw, Search } from "lucide-react";
import { PrintProfileViewSchema, type PrintProfileView } from "@yummyai/contracts/order/workspace";
import { getProductionProductDefinition } from "@yummyai/production-editor/products";
import {
  ProductionEditorWorkspaceViewSchema,
  ProductionEditorDetailViewSchema,
  type ProductionEditorProjectView,
  type ProductionEditorDetailView,
} from "@yummyai/contracts/pod/production-editor-api";
import { centerRequest, dateTime } from "./order-center-model";
import "./order-centers.css";
import { useWorkflowReturn } from "../navigation/use-workflow-return";
import { workflowHref } from "../navigation/workflow-href";
export function PrintLibraryWorkspace() {
  const workflow = useWorkflowReturn();
  const [profiles, setProfiles] = useState<PrintProfileView[]>([]),
    [projects, setProjects] = useState<ProductionEditorProjectView[]>([]),
    [selected, setSelected] = useState<ProductionEditorDetailView | null>(null);
  const [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [refresh, setRefresh] = useState(0);
  const [search, setSearch] = useState(""),
    [editing, setEditing] = useState(false),
    [code, setCode] = useState(""),
    [name, setName] = useState(""),
    [projectId, setProjectId] = useState(""),
    [versionId, setVersionId] = useState(""),
    [instructions, setInstructions] = useState("");
  const retry = useRef(new Map<string, string>());
  useEffect(() => {
    const abort = new AbortController();
    setLoading(true);
    setError("");
    void Promise.all([
      centerRequest("profiles", undefined, abort.signal),
      fetch("/api/production-editor/projects?scope=templates", { cache: "no-store", signal: abort.signal }).then(
        async (response) => {
          if (!response.ok) throw new Error("无法读取底稿，请检查设计权限");
          return response.json();
        },
      ),
    ])
      .then(([rows, templates]) => {
        if (!abort.signal.aborted) {
          setProfiles(PrintProfileViewSchema.array().parse(rows));
          setProjects(
            ProductionEditorWorkspaceViewSchema.parse(templates).projects.filter(
              (project) => !project.source && !project.workSource && !project.catalogSource,
            ),
          );
        }
      })
      .catch((cause) => {
        if (!abort.signal.aborted) setError(cause instanceof Error ? cause.message : "读取失败");
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false);
      });
    return () => abort.abort();
  }, [refresh]);
  useEffect(() => {
    if (!projectId) {
      setSelected(null);
      return;
    }
    const abort = new AbortController();
    setSelected(null);
    void fetch(`/api/production-editor/projects/${projectId}`, {
      signal: abort.signal,
      cache: "no-store",
    })
      .then(async (response) => {
        if (!response.ok) throw new Error("底稿读取失败");
        return ProductionEditorDetailViewSchema.parse(await response.json());
      })
      .then((detail) => {
        if (!abort.signal.aborted) {
          setSelected(detail);
          setVersionId(detail.version.id);
        }
      })
      .catch((cause) => {
        if (!abort.signal.aborted)
          setError(cause instanceof Error ? cause.message : "底稿读取失败");
      });
    return () => abort.abort();
  }, [projectId]);
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const current = profiles.find(
      (profile) => profile.code.toLowerCase() === code.trim().toLowerCase(),
    );
    const payload = {
      code: code.trim(),
      name: name.trim(),
      projectId,
      versionId,
      instructions,
      expectedVersion: current?.versionNumber ?? 0,
    };
    const signature = JSON.stringify(payload),
      key = retry.current.get(signature) ?? crypto.randomUUID();
    retry.current.set(signature, key);
    try {
      setProfiles(
        PrintProfileViewSchema.array().parse(
          await centerRequest("profiles", { ...payload, idempotencyKey: key }),
        ),
      );
      setNotice("印花与工艺版本已保存，运营可以在订单中选择。已有订单继续使用其原先确认的版本。");
      setEditing(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "保存失败");
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="oc-page" aria-busy={loading || busy}>
      {workflow.back && <Link className="oc-button" href={workflow.back}>返回原任务</Link>}
      <header className="oc-header">
        <div>
          <h1>工艺底稿库</h1>
          <p>用工艺编号 管理源底稿和生产规格，订单推送时固定所选版本。</p>
        </div>
        <div className="oc-actions">
          <Link className="oc-button" href={workflowHref("/pod-workbench/production-editor", workflow.current)}>
            新建 / 编辑底稿
          </Link>
          <button
            className="oc-button primary"
            onClick={() => {
              setEditing(true);
              setCode("");
              setName("");
              setProjectId("");
              setInstructions("");
            }}
          >
            <Plus size={16} />
            登记印花版本
          </button>
          <button
            className="oc-button"
            disabled={loading}
            onClick={() => setRefresh((value) => value + 1)}
          >
            <RefreshCw size={16} />
            刷新
          </button>
        </div>
      </header>
      {error && (
        <p className="oc-error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="oc-notice" role="status">
          {notice}
        </p>
      )}
      {editing && (
        <form className="oc-library-form" onSubmit={(event) => void save(event)}>
          <label>
            工艺编号
            <input
              required
              maxLength={100}
              value={code}
              onChange={(event) => setCode(event.target.value)}
              placeholder="例如：PET-HEAD-01"
            />
          </label>
          <label>
            名称
            <input
              required
              maxLength={160}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <label>
            通用底稿
            <select
              required
              value={projectId}
              onChange={(event) => setProjectId(event.target.value)}
            >
              <option value="">选择已确认的底稿</option>
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name} · V{project.versionNumber}
                </option>
              ))}
            </select>
          </label>
          <label>
            已审核版本
            <select
              required
              value={versionId}
              onChange={(event) => setVersionId(event.target.value)}
            >
              <option value="">选择版本</option>
              {selected?.versions
                .filter((version) => version.reviewed)
                .map((version) => (
                  <option key={version.id} value={version.id}>
                    V{version.versionNumber} · 已审核
                  </option>
                ))}
            </select>
          </label>
          <label className="oc-full-field">
            工艺说明
            <textarea
              value={instructions}
              onChange={(event) => setInstructions(event.target.value)}
              rows={3}
              maxLength={3000}
              placeholder="适用规格、印刷要求及工厂注意事项"
            />
          </label>
          <p className="oc-hint">底稿需先确认物理尺寸并审核。使用相同工艺编号 保存会追加版本。</p>
          <div className="oc-actions">
            <button
              className="oc-button primary"
              disabled={
                busy ||
                !selected?.versions.some((version) => version.id === versionId && version.reviewed)
              }
            >
              保存版本
            </button>
            <button
              className="oc-button"
              type="button"
              disabled={busy}
              onClick={() => setEditing(false)}
            >
              取消
            </button>
          </div>
        </form>
      )}
      <label className="oc-search">
        搜索印花
        <div>
          <Search size={16} />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="工艺编号 / 名称 / 工艺说明"
          />
        </div>
      </label>
      <div className="oc-list-summary">
        {loading ? "正在读取…" : `${profiles.length} 套印花与工艺资料`}
      </div>
      <div className="oc-table-wrap">
        <table className="oc-table">
          <thead>
            <tr>
              <th>工艺编号</th>
              <th>名称 / 工艺说明</th>
              <th>商品类型</th>
              <th>版本</th>
              <th>更新时间</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {profiles
              .filter((profile) =>
                `${profile.code} ${profile.name} ${profile.instructions}`
                  .toLowerCase()
                  .includes(search.toLowerCase()),
              )
              .map((profile) => (
                <tr key={profile.id}>
                  <td data-label="工艺编号">
                    <strong>{profile.code}</strong>
                  </td>
                  <td data-label="名称 / 工艺说明">
                    {profile.name}
                    <small>{profile.instructions}</small>
                  </td>
                  <td data-label="商品类型">
                    {getProductionProductDefinition(profile.productType).label}
                  </td>
                  <td data-label="版本">V{profile.versionNumber}</td>
                  <td data-label="更新时间">{dateTime(profile.createdAt)}</td>
                  <td>
                    <Link
                      className="oc-button"
                      href={workflowHref(`/pod-workbench/production-editor?projectId=${profile.projectId}&versionId=${profile.sourceVersionId}`, workflow.current)}
                    >
                      查看底稿
                    </Link>
                    <button
                      className="oc-text-button"
                      onClick={() => {
                        setCode(profile.code);
                        setName(profile.name);
                        setProjectId(profile.projectId);
                        setInstructions(profile.instructions);
                        setEditing(true);
                      }}
                    >
                      追加版本
                    </button>
                  </td>
                </tr>
              ))}
            {!loading && !profiles.length && (
              <tr>
                <td colSpan={6} className="oc-empty">
                  还没有印花与工艺资料。先准备通用底稿，再登记它的工艺编号 和版本。
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </main>
  );
}
