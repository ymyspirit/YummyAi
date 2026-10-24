"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import {
  UsersRound,
  Plus,
  RefreshCw,
  Search,
  ChevronLeft,
  ChevronRight,
  Pencil,
  X,
} from "lucide-react";
import { Permission } from "@yummyai/authz/permissions";
import {
  TeamWorkspaceSchema,
  TeamCommandResultSchema,
  type TeamWorkspace as Workspace,
} from "@yummyai/contracts/identity/teams";
import { useErpAccess } from "../identity/erp-access";
import { useOwnedViewTransition } from "../navigation/use-owned-view-transition";
import "./teams.css";

type Edit = {
  id: string;
  name: string;
  status: "active" | "archived";
  expectedRevision: number;
  reason: string;
};
type MemberEdit = {
  teamId: string;
  membershipId: string;
  active: boolean;
  expectedRevision: number | null;
  reason: string;
};
const emptyMember: MemberEdit = {
  teamId: "",
  membershipId: "",
  active: true,
  expectedRevision: null,
  reason: "",
};
export function TeamWorkspace() {
  const { canTenant } = useErpAccess();
  return canTenant(Permission.MembershipManage) ? (
    <EditableTeams />
  ) : (
    <section className="teams-workspace">
      <h1>团队管理</h1>
      <p role="status">当前账户没有团队管理权限</p>
    </section>
  );
}
function EditableTeams() {
  const [data, setData] = useState<Workspace | null>(null),
    [query, setQuery] = useState({ q: "", memberQ: "", page: 1 }),
    [search, setSearch] = useState(""),
    [memberSearch, setMemberSearch] = useState("");
  const [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState(""),
    [denied, setDenied] = useState(false);
  const [name, setName] = useState(""),
    [reason, setReason] = useState(""),
    [edit, setEdit] = useState<Edit | null>(null),
    [member, setMember] = useState<MemberEdit>(emptyMember);
  const epoch = useRef(0),
    read = useRef<AbortController | null>(null),
    alive = useRef(true),
    writing = useRef(false);
  const { change, cancel } = useOwnedViewTransition();
  const clear = useCallback(() => {
    cancel();
    epoch.current++;
    read.current?.abort();
    setData(null);
    setEdit(null);
    setName("");
    setReason("");
    setMember(emptyMember);
    setSearch("");
    setMemberSearch("");
    setDenied(true);
    setLoading(false);
  }, [cancel]);
  const load = useCallback(async () => {
    const key = ++epoch.current;
    read.current?.abort();
    const controller = new AbortController();
    read.current = controller;
    setLoading(true);
    try {
      const response = await fetch(
        `/api/teams?${new URLSearchParams({ q: query.q, memberQ: query.memberQ, page: String(query.page), pageSize: "30" })}`,
        { cache: "no-store", signal: controller.signal },
      );
      if (!alive.current || key !== epoch.current) return;
      if ([401, 403, 404].includes(response.status)) {
        clear();
        setMessage("当前团队管理权限已失效");
        return;
      }
      if (!response.ok) throw Error("团队目录暂时无法读取 请重试");
      const value = TeamWorkspaceSchema.parse(await response.json());
      if (alive.current && key === epoch.current)
        change(() => {
          setData(value);
          setDenied(false);
        });
    } catch (error) {
      if (!controller.signal.aborted && alive.current && key === epoch.current) {
        setData(null);
        setMessage(error instanceof Error ? error.message : "团队目录暂时无法读取");
      }
    } finally {
      if (alive.current && key === epoch.current) setLoading(false);
    }
  }, [query, clear, change]);
  useEffect(() => {
    alive.current = true;
    void load();
    const timer = setInterval(() => void load(), 30000);
    const focus = () => void load();
    window.addEventListener("focus", focus);
    return () => {
      alive.current = false;
      epoch.current++;
      read.current?.abort();
      clearInterval(timer);
      window.removeEventListener("focus", focus);
      cancel();
    };
  }, [load, cancel]);
  const command = async (path: string, method: "POST" | "PATCH", body: Record<string, unknown>) => {
    if (writing.current || denied) return null;
    writing.current = true;
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch(`/api/teams${path}`, {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...body, requestId: crypto.randomUUID() }),
      });
      if (!alive.current) return null;
      if ([401, 403].includes(response.status)) {
        clear();
        setMessage("当前团队管理权限已失效");
        return null;
      }
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        setMessage(
          response.status >= 500
            ? "请求结果尚未确认 请刷新核对当前记录"
            : typeof payload?.message === "string"
              ? payload.message
              : "操作未完成 请核对当前记录",
        );
        await load();
        return null;
      }
      const result = TeamCommandResultSchema.parse(payload);
      await load();
      if (!alive.current) return null;
      setMessage("操作已记录 目录已重新读取");
      return result;
    } catch {
      if (alive.current) {
        setMessage("请求结果尚未确认 请刷新核对当前记录");
        await load();
      }
      return null;
    } finally {
      writing.current = false;
      if (alive.current) setBusy(false);
    }
  };
  const prevent = (event: FormEvent) => event.preventDefault();
  const chooseMember = (teamId: string, membershipId: string) => {
    const previous = data?.teams
      .find((team) => team.id === teamId)
      ?.members.find((item) => item.membershipId === membershipId);
    // Controlled selections must commit before the next input event.
    setMember({
      teamId,
      membershipId,
      active: !previous?.active,
      expectedRevision: previous?.revision ?? null,
      reason: "",
    });
  };
  const selected = data?.teams.find((team) => team.id === member.teamId),
    locked = busy || denied || loading || !data;
  return (
    <section className="teams-workspace" aria-busy={loading || busy}>
      <header className="teams-header">
        <div>
          <h1>
            <UsersRound size={22} aria-hidden="true" />
            团队管理
          </h1>
          <p>维护现有成员的团队关系 商品按实际归属共享</p>
        </div>
        <button type="button" onClick={() => void load()} disabled={busy || loading}>
          <RefreshCw size={15} aria-hidden="true" />
          刷新目录
        </button>
      </header>
      {message ? (
        <p className="teams-notice" role="status">
          {message}
        </p>
      ) : null}
      {denied ? (
        <p role="status">当前账户没有团队管理权限</p>
      ) : (
        <>
          <form
            className="teams-toolbar"
            onSubmit={(event) => {
              prevent(event);
              setQuery({ q: search, memberQ: memberSearch, page: 1 });
            }}
          >
            <label>
              <span>查找团队</span>
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                maxLength={120}
              />
            </label>
            <label>
              <span>查找可选成员</span>
              <input
                value={memberSearch}
                onChange={(event) => setMemberSearch(event.target.value)}
                maxLength={120}
              />
            </label>
            <button disabled={busy} type="submit">
              <Search size={15} aria-hidden="true" />
              筛选
            </button>
          </form>
          <div className="teams-body">
            <div className="teams-directory">
              {loading && !data ? (
                <p role="status">正在读取团队目录</p>
              ) : !data ? (
                <p role="status">目录读取失败 请刷新重试</p>
              ) : (
                <>
                  <p className="teams-count">共 {data.total} 个团队</p>
                  {!data.teams.length ? (
                    <p className="teams-empty">暂无符合条件的团队</p>
                  ) : (
                    <ul className="teams-list">
                      {data.teams.map((team) => (
                        <li key={team.id}>
                          <header>
                            <div>
                              <strong>{team.name}</strong>
                              <span className="teams-status">
                                {team.status === "active" ? "启用中" : "已归档"}
                              </span>
                            </div>
                            <button
                              type="button"
                              disabled={locked}
                              aria-label={`编辑 ${team.name}`}
                              onClick={() =>
                                change(() =>
                                  setEdit({
                                    id: team.id,
                                    name: team.name,
                                    status: team.status,
                                    expectedRevision: team.revision,
                                    reason: "",
                                  }),
                                )
                              }
                            >
                              <Pencil size={14} aria-hidden="true" />
                              编辑
                            </button>
                          </header>
                          <p>{team.members.filter((item) => item.active).length} 位已关联成员</p>
                          <ul className="teams-members">
                            {team.members.map((item) => (
                              <li key={item.membershipId}>
                                <span>{item.displayName}</span>
                                <span>{item.active ? "已关联" : "已移除"}</span>
                                <button
                                  type="button"
                                  disabled={locked || team.status !== "active"}
                                  onClick={() => chooseMember(team.id, item.membershipId)}
                                >
                                  管理关联
                                </button>
                              </li>
                            ))}
                          </ul>
                        </li>
                      ))}
                    </ul>
                  )}
                  <nav className="teams-pagination" aria-label="团队分页">
                    <button
                      type="button"
                      disabled={locked || query.page === 1}
                      onClick={() => setQuery({ ...query, page: query.page - 1 })}
                    >
                      <ChevronLeft size={15} aria-hidden="true" />
                      上一页
                    </button>
                    <span>第 {data.page} 页</span>
                    <button
                      type="button"
                      disabled={locked || data.page * data.pageSize >= data.total}
                      onClick={() => setQuery({ ...query, page: query.page + 1 })}
                    >
                      下一页
                      <ChevronRight size={15} aria-hidden="true" />
                    </button>
                  </nav>
                </>
              )}
            </div>
            <aside className="teams-forms">
              <form
                aria-label="新增团队"
                onSubmit={async (event) => {
                  prevent(event);
                  const result = await command("", "POST", { name, reason });
                  if (result) {
                    setName("");
                    setReason("");
                  }
                }}
              >
                <h2>新增团队</h2>
                <label>
                  <span>团队名称</span>
                  <input
                    required
                    maxLength={120}
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                  />
                </label>
                <label>
                  <span>建立原因</span>
                  <textarea
                    required
                    minLength={5}
                    maxLength={500}
                    value={reason}
                    onChange={(event) => setReason(event.target.value)}
                  />
                </label>
                <button disabled={locked} type="submit">
                  <Plus size={15} aria-hidden="true" />
                  创建团队
                </button>
              </form>
              {edit ? (
                <form
                  aria-label="编辑团队"
                  onSubmit={async (event) => {
                    prevent(event);
                    const { id, ...input } = edit;
                    if (await command(`/${id}`, "PATCH", input)) change(() => setEdit(null));
                  }}
                >
                  <h2>
                    编辑团队
                    <button
                      type="button"
                      aria-label="关闭团队编辑"
                      onClick={() => change(() => setEdit(null))}
                    >
                      <X size={15} />
                    </button>
                  </h2>
                  <label>
                    <span>团队名称</span>
                    <input
                      required
                      maxLength={120}
                      value={edit.name}
                      onChange={(event) => setEdit({ ...edit, name: event.target.value })}
                    />
                  </label>
                  <label>
                    <span>状态</span>
                    <select
                      value={edit.status}
                      onChange={(event) =>
                        setEdit({ ...edit, status: event.target.value as Edit["status"] })
                      }
                    >
                      <option value="active">启用</option>
                      <option value="archived">归档</option>
                    </select>
                  </label>
                  <label>
                    <span>修改原因</span>
                    <textarea
                      required
                      minLength={5}
                      maxLength={500}
                      value={edit.reason}
                      onChange={(event) => setEdit({ ...edit, reason: event.target.value })}
                    />
                  </label>
                  <small>归档后停止团队共享 旧任务需重新核对权限</small>
                  <button disabled={locked} type="submit">
                    保存团队
                  </button>
                </form>
              ) : null}
              <form
                aria-label="管理成员关联"
                onSubmit={async (event) => {
                  prevent(event);
                  const { teamId, ...input } = member;
                  if (await command(`/${teamId}/members`, "POST", input)) setMember(emptyMember);
                }}
              >
                <h2>管理成员关联</h2>
                <label>
                  <span>团队</span>
                  <select
                    required
                    aria-label="团队"
                    value={member.teamId}
                    onChange={(event) => chooseMember(event.target.value, "")}
                  >
                    <option value="">选择当前页的团队</option>
                    {data?.teams
                      .filter((team) => team.status === "active")
                      .map((team) => (
                        <option key={team.id} value={team.id}>
                          {team.name}
                        </option>
                      ))}
                  </select>
                </label>
                <label>
                  <span>成员</span>
                  <select
                    required
                    aria-label="成员"
                    value={member.membershipId}
                    onChange={(event) => chooseMember(member.teamId, event.target.value)}
                  >
                    <option value="">选择现有成员</option>
                    {data?.members.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.displayName}
                      </option>
                    ))}
                  </select>
                </label>
                {data?.membersTruncated ? <small>可选成员较多 请先按姓名筛选</small> : null}
                <label>
                  <span>关联调整原因</span>
                  <textarea
                    required
                    minLength={5}
                    maxLength={500}
                    value={member.reason}
                    onChange={(event) => setMember({ ...member, reason: event.target.value })}
                  />
                </label>
                <button
                  disabled={locked || selected?.status !== "active" || !member.membershipId}
                  type="submit"
                >
                  {member.active ? "关联到团队" : "移除成员关联"}
                </button>
              </form>
            </aside>
          </div>
        </>
      )}
    </section>
  );
}
