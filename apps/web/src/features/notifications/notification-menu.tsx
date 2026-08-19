"use client";

import { Bell, BellRing, CheckCheck, CircleAlert, FileCheck2, X } from "lucide-react";
import { useState } from "react";

export interface NotificationView { id: string; kind: "job_completed" | "job_failed" | "review_requested" | "review_decided" | "design_overdue" | "system"; title: string; body: string; readAt?: string; createdAt: string }

export function NotificationMenu({ initialNotifications }: { initialNotifications: readonly NotificationView[] }) {
  const [open, setOpen] = useState(false); const [items, setItems] = useState(() => initialNotifications.map((item) => ({ ...item })));
  const unread = items.filter((item) => !item.readAt).length;
  function markAllRead() { const readAt = new Date().toISOString(); setItems((current) => current.map((item) => item.readAt ? item : { ...item, readAt })); }
  return <div className="notification-menu"><button type="button" className="notification-trigger" aria-expanded={open} onClick={() => setOpen((value) => !value)}>{unread ? <BellRing size={17} /> : <Bell size={17} />}<span>通知</span>{unread > 0 && <b>{unread}</b>}</button>{open && <section className="notification-popover" aria-label="通知中心"><header><div><p>NOTIFICATION INBOX</p><h2>运营通知</h2></div><button type="button" aria-label="关闭通知" onClick={() => setOpen(false)}><X size={17} /></button></header><div className="notification-actions"><span>{unread} 条未读</span><button type="button" onClick={markAllRead} disabled={!unread}><CheckCheck size={14} />全部已读</button></div>{items.length ? <ol>{items.map((item) => <li key={item.id} className={item.readAt ? "notification-read" : ""}><span>{item.kind === "job_failed" || item.kind === "design_overdue" ? <CircleAlert size={16} /> : <FileCheck2 size={16} />}</span><div><strong>{item.title}</strong><p>{item.body}</p><time>{formatRelative(item.createdAt)}</time></div>{!item.readAt && <i aria-label="未读" />}</li>)}</ol> : <p className="notification-empty">暂无通知，新的审核与任务状态会出现在这里。</p>}</section>}</div>;
}

function formatRelative(value: string) { return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value)); }
