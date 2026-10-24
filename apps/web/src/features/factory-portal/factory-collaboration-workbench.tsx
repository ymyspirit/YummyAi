"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Factory, RefreshCw, UserPlus, X } from "lucide-react";
import {
  FactoryAssignmentListSchema,
  FactoryCollaborationWorkspaceSchema,
} from "@yummyai/contracts/suppliers/factory-portal";
import { ProductionDeliveryWorkspaceSchema } from "@yummyai/contracts/order/production-delivery";
import { useFactoryViewTransition } from "./factory-view-transition";
import "./factory-portal.css";

type Workspace = ReturnType<typeof FactoryCollaborationWorkspaceSchema.parse>;
type Assignments = ReturnType<typeof FactoryAssignmentListSchema.parse>;
type Deliveries = ReturnType<typeof ProductionDeliveryWorkspaceSchema.parse>;
type Command = { path: string; body: Record<string, unknown> };
class CollaborationError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
async function read(path: string, signal?: AbortSignal) {
  const response = await fetch(`/api/${path}`, { cache: "no-store", signal });
  if (!response.ok)
    throw new CollaborationError(response.status, "当前协作资料无法读取 请核对权限后重试");
  return response.json();
}
const date = (value: string) => new Date(value).toLocaleString("zh-CN", { hour12: false });
const status = { active: "有效", expired: "已到期", revoked: "已撤销" };

export function FactoryCollaborationWorkbench({initialFactoryId}:{initialFactoryId?:string}) {
  const [workspace, setWorkspace] = useState<Workspace | null>(null),
    [selected, setSelected] = useState<string | null>(null),
    [assignments, setAssignments] = useState<Assignments | null>(null),
    [deliveries, setDeliveries] = useState<Deliveries | null>(null);
  const [trail, setTrail] = useState<(string | undefined)[]>([undefined]),
    [taskTrail, setTaskTrail] = useState<(string | undefined)[]>([undefined]),
    [query, setQuery] = useState(""),
    [reload, setReload] = useState(0),
    [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const generation = useRef(0),
    scope = useRef(0),
    active = useRef<AbortController | null>(null),
    pending = useRef<Command | null>(null),
    { change, cancel } = useFactoryViewTransition();
  const clear = useCallback(() => {
    cancel();
    scope.current++;
    pending.current = null;
    setWorkspace(null);
    setSelected(null);
    setAssignments(null);
    setDeliveries(null);
    setNotice("");
  }, [cancel]);
  const refresh = useCallback(async () => {
    const version = ++generation.current;
    active.current?.abort();
    const abort = new AbortController();
    active.current = abort;
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams({ limit: "25" });
      if(initialFactoryId)params.set("factoryId",initialFactoryId);
      if (query) params.set("q", query);
      if (trail.at(-1)) params.set("cursor", trail.at(-1)!);
      const data = FactoryCollaborationWorkspaceSchema.parse(
        await read(`factory-collaboration/workspace?${params}`, abort.signal),
      );
      const grant = data.grants.find((row) => row.id === selected);
      let tasks: Assignments | null = null,
        files: Deliveries | null = null;
      if (grant) {
        const p = new URLSearchParams({ limit: "25" });
        if (taskTrail.at(-1)) p.set("cursor", taskTrail.at(-1)!);
        tasks = FactoryAssignmentListSchema.parse(
          await read(`factory-collaboration/grants/${grant.id}/work-items?${p}`, abort.signal),
        );
        // File selection stays under the original order/PII/assets read boundary.
        if (grant.available) {
          try {
            files = ProductionDeliveryWorkspaceSchema.parse(
              await read(`order-centers/deliveries?factory=${grant.factoryId}`, abort.signal),
            );
          } catch (reason) {
            if (reason instanceof CollaborationError && reason.status === 403) {
              files = null;
            } else throw reason;
          }
        }
      }
      if (version !== generation.current) return;
      setWorkspace(data);
      setAssignments(tasks);
      setDeliveries(files);
      if (!grant) setSelected(null);
    } catch (reason) {
      if (abort.signal.aborted || version !== generation.current) return;
      clear();
      setError(reason instanceof Error ? reason.message : "当前资料无法核对");
    } finally {
      if (version === generation.current) setLoading(false);
    }
  }, [clear, initialFactoryId, query, selected, taskTrail, trail]);
  useEffect(() => {
    void refresh();
    const check = () => {
      if (document.visibilityState !== "hidden") void refresh();
    };
    const timer = window.setInterval(check, 30000);
    window.addEventListener("focus", check);
    document.addEventListener("visibilitychange", check);
    return () => {
      generation.current++;
      active.current?.abort();
      window.clearInterval(timer);
      window.removeEventListener("focus", check);
      document.removeEventListener("visibilitychange", check);
    };
  }, [refresh, reload]);
  async function execute(command: Command) {
    if (busy) return;
    const epoch = scope.current;
    pending.current = command;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch(`/api/factory-collaboration/${command.path}`, {
        method: "POST",
        cache: "no-store",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(command.body),
      });
      if (!response.ok) {
        const value = await response.json().catch(() => null);
        throw new CollaborationError(
          response.status,
          typeof value?.message === "string" ? value.message : "请求结果暂时无法确认 请重试原请求",
        );
      }
      if (epoch !== scope.current) return;
      pending.current = null;
      setNotice("已保存 请核对当前授权和任务记录");
      setReload((value) => value + 1);
    } catch (reason) {
      if (epoch !== scope.current) return;
      if (reason instanceof CollaborationError && [401, 403, 404].includes(reason.status)) {
        generation.current++;
        active.current?.abort();
        clear();
      } else if (reason instanceof CollaborationError && [400, 409].includes(reason.status))
        pending.current = null;
      setError(reason instanceof Error ? reason.message : "请求结果暂时无法确认 请重试原请求");
    } finally {
      setBusy(false);
    }
  }
  function submit(event: React.FormEvent<HTMLFormElement>, build: (data: FormData) => Command) {
    event.preventDefault();
    try {
      void execute(build(new FormData(event.currentTarget)));
    } catch {
      setError("请核对有效期和所选资料");
    }
  }
  function choose(id: string) {
    change(() => {
      setSelected(id);
      setTaskTrail([undefined]);
      setAssignments(null);
      setDeliveries(null);
      setNotice("");
    });
  }
  const grant = workspace?.grants.find((row) => row.id === selected),
    locked = busy || pending.current !== null;
  const files =
    deliveries?.packages.flatMap((packet) =>
      packet.items
        .filter(
          (item) =>
            item.snapshot &&
            item.blockers.length === 0 &&
            item.status !== "rejected" &&
            packet.factory?.factoryId === grant?.factoryId,
        )
        .map((item) => ({ packet, item })),
    ) ?? [];
  return (
    <main className="fp-shell fc-shell">
      <header className="fp-header">
        <div className="fp-brand">
          <Factory size={23} />
          <div>
            <h1>工厂协作授权</h1>
            <p>关联已开通成员 分配原制作文件</p>
          </div>
        </div>
        <button
          type="button"
          disabled={loading || busy}
          onClick={() => setReload((value) => value + 1)}
        >
          <RefreshCw size={16} />
          刷新
        </button>
      </header>
      <p className="fp-note">先由身份管理员开通协作账户 再在这里关联工厂并逐项分配文件</p>
      {error && (
        <p role="alert" className="fp-alert">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="fc-notice">
          {notice}
        </p>
      )}
      {pending.current && !busy && (
        <div className="fc-retry">
          <p>上次请求结果尚未确认 输入已保留 重试将使用原请求编号</p>
          <button type="button" onClick={() => void execute(pending.current!)}>
            重试原请求
          </button>
        </div>
      )}
      <form
        className="fp-filters"
        onSubmit={(event) => {
          event.preventDefault();
          setQuery(String(new FormData(event.currentTarget).get("q") ?? "").trim());
          setTrail([undefined]);
          setSelected(null);
          setTaskTrail([undefined]);
          setReload((value) => value + 1);
        }}
      >
        <label>
          查找成员或授权
          <input name="q" maxLength={100} placeholder="姓名 邮箱或工厂名称" />
        </label>
        <button disabled={busy || locked}>查询</button>
      </form>
      {loading && !workspace && (
        <p role="status" className="fp-empty-text">
          正在核对当前协作管理权限
        </p>
      )}
      {workspace && (
        <>
          <form
            className="fc-create"
            aria-label="建立工厂授权"
            onSubmit={(event) =>
              submit(event, (data) => ({
                path: "grants",
                body: {
                  factoryId: String(data.get("factory")),
                  membershipId: String(data.get("member")),
                  canRespond: data.get("respond") === "on",
                  expiresAt: new Date(String(data.get("expires"))).toISOString(),
                  idempotencyKey: crypto.randomUUID(),
                },
              }))
            }
          >
            <h2>
              <UserPlus size={17} />
              建立工厂授权
            </h2>
            <fieldset disabled={locked}>
              <label>
                工厂
                <select name="factory" aria-label="工厂" required defaultValue={initialFactoryId??""}>
                  <option value="" disabled>
                    选择有效工厂
                  </option>
                  {workspace.factories
                    .filter((f) => f.status === "active")
                    .map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.name}
                      </option>
                    ))}
                </select>
              </label>
              <label>
                已开通成员
                <select name="member" required defaultValue="">
                  <option value="" disabled>
                    选择当前有效成员
                  </option>
                  {workspace.members.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.displayName} · {m.email}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                授权有效至
                <input name="expires" type="datetime-local" required />
              </label>
              <label className="fp-confirm">
                <input name="respond" type="checkbox" />
                允许提交接收 接受或拒收回执
              </label>
              <button className="fp-primary">建立授权</button>
            </fieldset>
            {workspace.choicesTruncated && (
              <p className="fp-note">候选最多显示 100 项 请搜索成员或在供应商档案核对工厂</p>
            )}
          </form>
          <div className={`fp-workspace${grant ? " has-detail" : ""}`}>
            <section className="fp-list" aria-label="工厂授权列表">
              <div className="fp-list-head">
                <h2>成员授权</h2>
                <span>本页 {workspace.grants.length} 项</span>
              </div>
              {workspace.grants.length ? (
                <ul>
                  {workspace.grants.map((row) => (
                    <li key={row.id}>
                      <button
                        type="button"
                        disabled={locked}
                        className={`fp-task${selected === row.id ? " selected" : ""}`}
                        onClick={() => choose(row.id)}
                      >
                        <div>
                          <strong>{row.factoryName}</strong>
                          <span>{status[row.status]}</span>
                        </div>
                        <p>
                          {row.memberName} · {row.memberEmail}
                        </p>
                        <p>
                          {row.canRespond ? "可读取与回复" : "仅可读取"} · 至 {date(row.expiresAt)}
                        </p>
                        {row.blockers.length > 0 && <small>{row.blockers.join("；")}</small>}
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="fp-empty-text">当前没有匹配的工厂授权</p>
              )}
              <div className="fp-pagination">
                <button
                  disabled={loading || locked || trail.length < 2}
                  onClick={() => {
                    setSelected(null);
                    setTrail((value) => value.slice(0, -1));
                  }}
                >
                  上一页
                </button>
                <button
                  disabled={loading || locked || !workspace.nextCursor}
                  onClick={() => {
                    setSelected(null);
                    setTrail((value) => [...value, workspace.nextCursor!]);
                  }}
                >
                  下一页
                </button>
              </div>
            </section>
            {grant && (
              <section className="fp-detail" aria-label="授权与文件分配">
                <header>
                  <div>
                    <h2>{grant.factoryName}</h2>
                    <p>
                      {grant.memberName} · {grant.memberEmail}
                    </p>
                  </div>
                  <button
                    aria-label="关闭授权详情"
                    disabled={locked}
                    onClick={() => change(() => setSelected(null))}
                  >
                    <X size={16} />
                  </button>
                </header>
                {grant.blockers.length > 0 && (
                  <p role="status" className="fp-alert">
                    {grant.blockers.join("；")}
                  </p>
                )}
                {grant.status !== "revoked" && (
                  <RevokeForm
                    label="撤销整个工厂授权"
                    disabled={locked}
                    onSubmit={(reason) =>
                      execute({
                        path: `grants/${grant.id}/revoke`,
                        body: { reason, idempotencyKey: crypto.randomUUID() },
                      })
                    }
                  />
                )}
                {grant.available && (
                  <form
                    className="fc-assign"
                    aria-label="分配原制作文件"
                    onSubmit={(event) =>
                      submit(event, (data) => {
                        const chosen = files.find((row) => row.item.id === data.get("file"));
                        if (!chosen?.item.snapshot) throw Error();
                        return {
                          path: `grants/${grant.id}/work-items`,
                          body: {
                            deliveryItemId: chosen.item.id,
                            fileChecksum: chosen.item.snapshot.file.checksum,
                            packageChecksum: chosen.packet.checksum,
                            expiresAt: new Date(String(data.get("expires"))).toISOString(),
                            idempotencyKey: crypto.randomUUID(),
                          },
                        };
                      })
                    }
                  >
                    <h3>分配原制作文件</h3>
                    <fieldset disabled={locked || !files.length}>
                      <label>
                        已生成的原交付文件
                        <select name="file" required defaultValue="">
                          <option value="" disabled>
                            选择原文件及版本
                          </option>
                          {files.map(({ item }) => (
                            <option key={item.id} value={item.id}>
                              {item.snapshot!.orderNumber} · {item.snapshot!.quantity} 件 ·{" "}
                              {item.snapshot!.file.checksum.slice(0, 12)}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label>
                        任务有效至
                        <input
                          name="expires"
                          required
                          type="datetime-local"
                          max={localDate(grant.expiresAt)}
                        />
                      </label>
                      <button className="fp-primary">分配该文件</button>
                    </fieldset>
                    {!files.length && (
                      <p className="fp-note">
                        没有当前可分配文件 或当前账户缺少原生产资料读取权限 请在生产中心核对交付包
                      </p>
                    )}
                    {deliveries?.truncated && (
                      <p className="fp-note">原交付列表已截断 请在生产中心按订单筛选核对</p>
                    )}
                  </form>
                )}
                <section className="fp-receipts" aria-label="已分配文件">
                  <h3>已分配文件</h3>
                  {assignments?.items.length ? (
                    assignments.items.map((item) => (
                      <article key={item.id}>
                        <p>
                          <strong>{item.id}</strong> · {status[item.status]}
                        </p>
                        <p className="fp-checksum">{item.fileChecksum}</p>
                        <p>有效至 {date(item.expiresAt)}</p>
                        {item.blockers.length > 0 && <p>{item.blockers.join("；")}</p>}
                        {item.status !== "revoked" && (
                          <RevokeForm
                            label="撤销本文件分配"
                            disabled={locked}
                            onSubmit={(reason) =>
                              execute({
                                path: `assignments/${item.id}/revoke`,
                                body: { reason, idempotencyKey: crypto.randomUUID() },
                              })
                            }
                          />
                        )}
                      </article>
                    ))
                  ) : (
                    <p className="fp-note">尚未分配文件</p>
                  )}
                  <div className="fp-pagination">
                    <button
                      disabled={loading || locked || taskTrail.length < 2}
                      onClick={() => setTaskTrail((value) => value.slice(0, -1))}
                    >
                      上一页文件
                    </button>
                    <button
                      disabled={loading || locked || !assignments?.nextCursor}
                      onClick={() => setTaskTrail((value) => [...value, assignments!.nextCursor!])}
                    >
                      下一页文件
                    </button>
                  </div>
                </section>
              </section>
            )}
          </div>
        </>
      )}
    </main>
  );
}
function RevokeForm({
  label,
  disabled,
  onSubmit,
}: {
  label: string;
  disabled: boolean;
  onSubmit: (reason: string) => void;
}) {
  return (
    <form
      className="fc-revoke"
      aria-label={label}
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit(String(new FormData(event.currentTarget).get("reason")));
      }}
    >
      <label>
        撤销原因
        <input name="reason" required minLength={5} maxLength={500} disabled={disabled} />
      </label>
      <button disabled={disabled}>{label}</button>
    </form>
  );
}
function localDate(value: string) {
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}
