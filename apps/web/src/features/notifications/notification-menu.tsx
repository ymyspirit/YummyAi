"use client";

import {
  Bell,
  BellRing,
  Check,
  CheckCheck,
  CircleAlert,
  FileCheck2,
  RefreshCw,
  X,
} from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { NotificationInboxSchema } from "@yummyai/contracts/operations/notification";
import { notificationHref } from "./notification-href";
import "./notification-menu.css";

export interface NotificationView {
  id: string;
  kind:
    | "job_completed"
    | "job_failed"
    | "review_requested"
    | "review_decided"
    | "design_overdue"
    | "system";
  title: string;
  body: string;
  readAt?: string;
  createdAt: string;
  resourceType?: string;
  resourceId?: string;
  metadata?: Record<string, unknown>;
}
export function NotificationMenu({
  initialNotifications,
  live = true,
}: {
  initialNotifications: readonly NotificationView[];
  live?: boolean;
}) {
  const [mounted, setMounted] = useState(false),
    [open, setOpen] = useState(false),
    [items, setItems] = useState([...initialNotifications]),
    [unread, setUnread] = useState(initialNotifications.filter((item) => !item.readAt).length),
    [total, setTotal] = useState(initialNotifications.length),
    [cursor, setCursor] = useState<string | null>(null),
    [unreadOnly, setUnreadOnly] = useState(false),
    [loading, setLoading] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string>(),
    [synced, setSynced] = useState(!live);
  const dialog = useRef<HTMLDialogElement>(null),
    request = useRef<AbortController | null>(null),
    dialogId = useId();
  const load = useCallback(
    async (after?: string) => {
      if (!live) return;
      request.current?.abort();
      const controller = new AbortController();
      request.current = controller;
      setLoading(true);
      setError(undefined);
      try {
        const query = new URLSearchParams({ unreadOnly: String(unreadOnly), limit: "30" });
        if (after) query.set("after", after);
        const response = await fetch(`/api/notifications?${query}`, {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) {
          if ([401, 403, 404].includes(response.status)) {
            setItems([]);
            setUnread(0);
            setTotal(0);
            setCursor(null);
            setSynced(false);
          }
          const failure = await response.json().catch(() => null);
          throw new Error(
            typeof failure?.message === "string" ? failure.message : "通知读取未完成 请重试",
          );
        }
        const result = NotificationInboxSchema.parse(await response.json());
        if (controller.signal.aborted) return;
        setItems((current) =>
          after
            ? [...new Map([...current, ...result.items].map((item) => [item.id, item])).values()]
            : result.items,
        );
        setUnread(result.unread);
        setTotal(result.total);
        setCursor(result.nextCursor);
        setSynced(true);
      } catch (cause) {
        if (!controller.signal.aborted)
          setError(cause instanceof Error ? cause.message : "通知读取未完成 请重试");
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    },
    [live, unreadOnly],
  );
  useEffect(() => {
    setMounted(true);
  }, []);
  useEffect(() => {
    void load();
    const visible = () => {
      if (document.visibilityState === "visible") void load();
    };
    window.addEventListener("focus", visible);
    return () => {
      request.current?.abort();
      window.removeEventListener("focus", visible);
    };
  }, [load]);
  useEffect(() => {
    if (open && !dialog.current?.open) {
      dialog.current?.showModal();
      void load();
    } else if (!open && dialog.current?.open) dialog.current.close();
  }, [open, load, mounted]);
  async function markRead(id?: string) {
    if (!live || busy || loading) return;
    setBusy(true);
    setError(undefined);
    try {
      const response = await fetch(
        `/api/notifications/${id ? `${encodeURIComponent(id)}/read` : "read-all"}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: "{}",
        },
      );
      if (!response.ok) {
        if ([401, 403, 404].includes(response.status)) {
          setItems([]);
          setUnread(0);
          setTotal(0);
          setCursor(null);
          setSynced(false);
        }
        const failure = await response.json().catch(() => null);
        throw new Error(
          typeof failure?.message === "string" ? failure.message : "已读状态保存未完成 请刷新核对",
        );
      }
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "已读状态保存未完成 请刷新核对");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="notice-inbox">
      <button
        type="button"
        className="notice-trigger"
        aria-controls={dialogId}
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        {synced && unread ? <BellRing size={17} /> : <Bell size={17} />}
        <span>通知</span>
        {synced && unread > 0 ? <b>{unread}</b> : null}
      </button>
      {mounted
        ? createPortal(
            <dialog
              id={dialogId}
              ref={dialog}
              className="notice-dialog"
              aria-label="通知中心"
              onClose={() => setOpen(false)}
              onCancel={() => setOpen(false)}
              onClick={(event) => {
                if (event.target === event.currentTarget) {
                  const bounds = event.currentTarget.getBoundingClientRect();
                  if (
                    event.clientX < bounds.left ||
                    event.clientX > bounds.right ||
                    event.clientY < bounds.top ||
                    event.clientY > bounds.bottom
                  )
                    setOpen(false);
                }
              }}
            >
              <header>
                <h2>运营通知</h2>
                <div>
                  <button
                    type="button"
                    aria-label="刷新通知"
                    disabled={busy || loading || !live}
                    onClick={() => void load()}
                  >
                    <RefreshCw size={16} />
                  </button>
                  <button type="button" aria-label="关闭通知" onClick={() => setOpen(false)}>
                    <X size={17} />
                  </button>
                </div>
              </header>
              <div className="notice-actions">
                <span>
                  {synced ? `${unread} 条未读` : "未读数量待同步"}
                  {!live ? " · 示例" : ""}
                </span>
                <button
                  type="button"
                  onClick={() => void markRead()}
                  disabled={!live || !synced || !unread || busy || loading}
                >
                  <CheckCheck size={14} />
                  全部已读
                </button>
              </div>
              <label className="notice-filter">
                <input
                  type="checkbox"
                  checked={unreadOnly}
                  disabled={!live || busy || loading}
                  onChange={(event) => {
                    setItems([]);
                    setCursor(null);
                    setUnreadOnly(event.target.checked);
                  }}
                />
                只看未读
              </label>
              {error ? (
                <p role="alert" className="notice-message">
                  {error}
                </p>
              ) : null}
              {loading ? (
                <p role="status" className="notice-message">
                  正在同步通知
                </p>
              ) : null}
              {items.length ? (
                <ol>
                  {items.map((item) => {
                    const href = notificationHref(item);
                    return (
                      <li key={item.id} data-read={Boolean(item.readAt)}>
                        <span aria-hidden="true">
                          {item.kind === "job_failed" || item.kind === "design_overdue" ? (
                            <CircleAlert size={16} />
                          ) : (
                            <FileCheck2 size={16} />
                          )}
                        </span>
                        <div>
                          <strong>{item.title}</strong>
                          <p>{item.body}</p>
                          <time dateTime={item.createdAt}>{formatDate(item.createdAt)}</time>
                          <div className="notice-item-actions">
                            {href ? <a href={href}>查看任务</a> : null}
                            {!item.readAt ? (
                              <button
                                type="button"
                                disabled={!live || busy || loading}
                                aria-label={`标为已读 ${item.title}`}
                                onClick={() => void markRead(item.id)}
                              >
                                <Check size={13} />
                                标为已读
                              </button>
                            ) : (
                              <span>已读</span>
                            )}
                          </div>
                        </div>
                      </li>
                    );
                  })}
                </ol>
              ) : !loading && !error ? (
                <p className="notice-message">{unreadOnly ? "当前没有未读通知" : "当前没有通知"}</p>
              ) : null}
              <footer>
                <span>
                  已显示 {items.length} / {total}
                </span>
                {cursor ? (
                  <button
                    type="button"
                    disabled={busy || loading}
                    onClick={() => void load(cursor)}
                  >
                    加载更多
                  </button>
                ) : null}
              </footer>
            </dialog>,
            document.body,
          )
        : null}
    </div>
  );
}
function formatDate(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(value));
}
