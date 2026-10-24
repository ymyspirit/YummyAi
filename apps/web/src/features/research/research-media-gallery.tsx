"use client";
import {
  captureMediaFailureMessage,
  type CaptureMediaPreview,
} from "@yummyai/contracts/capture/media-preview";
import {
  ChevronLeft,
  ChevronRight,
  Clock3,
  FileCheck2,
  ImageIcon,
  ImageOff,
  LockKeyhole,
  Play,
  RefreshCw,
  X,
  ZoomIn,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { observeViewTransition } from "../navigation/view-transition";
import { captureMediaHref, useCaptureMedia } from "./capture-media-client";
import "./research-media.css";

export function ResearchMediaGallery({ snapshotId, title }: { snapshotId: string; title: string }) {
  const state = useCaptureMedia(snapshotId),
    value = state.value;
  const [selectedId, setSelectedId] = useState<string>(),
    [failed, setFailed] = useState<string[]>([]),
    [failedThumbnails, setFailedThumbnails] = useState<string[]>([]),
    [revisions, setRevisions] = useState<Record<string, number>>({});
  const [phase, setPhase] = useState<"closed" | "open" | "closing">("closed");
  const dialog = useRef<HTMLDialogElement>(null),
    closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const entries = value?.media ?? [],
    active =
      entries.find((item) => item.id === selectedId) ??
      entries.find((item) => item.kind === "image" && item.status !== "excluded") ??
      entries[0];
  const ordinal = (item: CaptureMediaPreview) =>
    item.sourceIndex === null
      ? `历史项 ${entries.findIndex((entry) => entry.id === item.id) + 1}`
      : String(item.sourceIndex + 1);
  useEffect(() => {
    if (!selectedId && active) setSelectedId(active.id);
  }, [active, selectedId]);
  useEffect(() => () => clearTimeout(closeTimer.current), []);
  useEffect(() => {
    if (!value?.canReadArchive) {
      clearTimeout(closeTimer.current);
      dialog.current?.close();
      setPhase("closed");
    }
  }, [value?.canReadArchive]);
  const failure = (id: string) => {
    setFailed((previous) => [...new Set([...previous, id])]);
    void state.refresh();
  };
  const retry = (id: string) => {
    setFailed((previous) => previous.filter((value) => value !== id));
    setFailedThumbnails((previous) => previous.filter((value) => value !== id));
    setRevisions((previous) => ({ ...previous, [id]: (previous[id] ?? 0) + 1 }));
    void state.refresh();
  };
  const open = () => {
    clearTimeout(closeTimer.current);
    dialog.current?.showModal();
    setPhase("open");
  };
  const close = () => {
    setPhase("closing");
    clearTimeout(closeTimer.current);
    const finish = () => {
      dialog.current?.close();
      setPhase("closed");
    };
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) finish();
    else closeTimer.current = setTimeout(finish, 180);
  };
  const images = entries.filter((item) => item.kind === "image" && item.status === "archived");
  const select = (id: string) => {
    const change = () => setSelectedId(id);
    if (
      typeof document.startViewTransition === "function" &&
      !window.matchMedia("(prefers-reduced-motion: reduce)").matches
    )
      observeViewTransition(document.startViewTransition(() => flushSync(change)));
    else change();
  };
  const move = (direction: number) => {
    const index = images.findIndex((item) => item.id === active?.id);
    const next = images[(index + direction + images.length) % images.length];
    if (next) select(next.id);
  };
  const render = (item: CaptureMediaPreview | undefined, large = false) => {
    if (!value)
      return (
        <div className="dossier-media-empty">
          {state.busy ? <Clock3 size={24} /> : <ImageOff size={24} />}
          <span>{state.error ?? "正在读取媒体归档状态"}</span>
        </div>
      );
    if (!value.canReadArchive)
      return (
        <div className="dossier-media-empty">
          <LockKeyhole size={24} />
          <span>
            {value.archivedItem ? "资料已归档 不再签发媒体访问" : "当前成员没有查看私有媒体的权限"}
          </span>
        </div>
      );
    if (!item)
      return (
        <div className="dossier-media-empty">
          <ImageIcon size={24} />
          <span>本次快照没有媒体记录</span>
        </div>
      );
    if (item.status !== "archived")
      return (
        <div className="dossier-media-empty">
          <ImageOff size={24} />
          <strong>{mediaStatus(item.status)}</strong>
          <span>
            {captureMediaFailureMessage(item.failureReason) ??
              (item.status === "excluded"
                ? "采集时未选择此媒体进行归档"
                : "后台归档完成后可在这里查看")}
          </span>
          {item.status === "failed" ? (
            <small>请核对原商品页后重新采集 新采集会保留为新快照</small>
          ) : null}
        </div>
      );
    if (failed.includes(item.id))
      return (
        <div className="dossier-media-empty">
          <ImageOff size={24} />
          <span>
            {item.kind === "video"
              ? "视频暂时无法播放 请刷新读取或核对浏览器格式支持"
              : "私有图片暂时无法加载"}
          </span>
          <button type="button" onClick={() => retry(item.id)}>
            重新读取私有媒体
          </button>
        </div>
      );
    const href = captureMediaHref(snapshotId, item.id, revisions[item.id] ?? 0);
    return item.kind === "image" ? (
      <img
        key={`${item.id}:${revisions[item.id] ?? 0}`}
        src={href}
        alt={`${title} · 研究图片 ${ordinal(item)}${large ? " 大图" : ""}`}
        onError={() => failure(item.id)}
      />
    ) : (
      <video
        key={`${item.id}:${revisions[item.id] ?? 0}`}
        src={href}
        controls
        controlsList="nodownload noremoteplayback"
        preload="metadata"
        aria-label="研究视频"
        onError={() => failure(item.id)}
      />
    );
  };
  return (
    <figure
      className="dossier-media research-gallery research-private-gallery"
      aria-label="竞品媒体浏览"
    >
      <header className="research-media-toolbar">
        <span>
          <LockKeyhole size={14} />
          私有研究副本
        </span>
        <button
          type="button"
          disabled={state.busy}
          onClick={() => void state.refresh()}
          aria-label="刷新媒体归档状态"
        >
          <RefreshCw size={14} className={state.busy ? "media-spin" : undefined} />
          刷新
        </button>
      </header>
      <div className="research-gallery-stage">{render(active)}</div>
      <figcaption>
        <span>
          {value ? `${value.kinds.image} 张图片 · ${value.kinds.video} 个视频` : "媒体状态读取中"}
        </span>
        {active?.kind === "image" && active.status === "archived" && value?.canReadArchive ? (
          <button
            type="button"
            onClick={open}
            aria-label="放大当前图片"
            disabled={failed.includes(active.id)}
          >
            <ZoomIn size={16} />
          </button>
        ) : null}
      </figcaption>
      {value ? (
        <div className="research-media-summary" role="status">
          <span>
            <FileCheck2 size={13} />
            字段：
            {value.fieldCaptureStatus ? captureStatus(value.fieldCaptureStatus) : "原记录未注明"}
          </span>
          <span>
            已归档 {value.counts.archived}/{value.total}
          </span>
          {value.counts.queued + value.counts.processing ? (
            <span>待处理 {value.counts.queued + value.counts.processing}</span>
          ) : null}
          {value.counts.failed ? (
            <span className="media-failed">归档失败 {value.counts.failed}</span>
          ) : null}
          {value.counts.excluded ? <span>未选入 {value.counts.excluded}</span> : null}
        </div>
      ) : null}
      {state.error && value ? (
        <p className="research-media-notice" role="alert">
          {state.error} 显示上次读取的状态
        </p>
      ) : null}
      {entries.some((item) => item.sourceIndex === null) ? (
        <p className="research-media-notice">历史媒体未固定原始顺序 请结合原始快照核对编号</p>
      ) : null}
      <div className="research-gallery-thumbs" aria-label="选择图片或视频">
        {entries.map((item) => (
          <button
            key={item.id}
            type="button"
            aria-label={`查看${item.kind === "image" ? "图片" : "视频"} ${ordinal(item)} ${mediaStatus(item.status)}`}
            aria-pressed={item.id === active?.id}
            onClick={() => select(item.id)}
          >
            {item.kind === "image" &&
            item.status === "archived" &&
            value?.canReadArchive &&
            !failedThumbnails.includes(item.id) ? (
              <img
                src={captureMediaHref(snapshotId, item.id, revisions[item.id] ?? 0)}
                alt=""
                loading="lazy"
                onError={() =>
                  setFailedThumbnails((previous) => [...new Set([...previous, item.id])])
                }
              />
            ) : item.kind === "video" ? (
              <Play size={19} />
            ) : (
              <ImageOff size={18} />
            )}
            <span>{ordinal(item)}</span>
            <i className={`media-dot ${item.status}`} title={mediaStatus(item.status)} />
          </button>
        ))}
      </div>
      {value?.nextCursor ? (
        <button
          type="button"
          className="research-media-load"
          disabled={state.busy}
          onClick={() => void state.loadMore()}
        >
          载入更多媒体 · 已读取 {entries.length}/{value.total}
        </button>
      ) : null}
      {active ? (
        <p className="research-media-evidence">
          {mediaStatus(active.status)} · 已尝试 {active.attemptCount} 次
          {active.byteSize ? ` · ${formatBytes(active.byteSize)}` : ""}
          {active.checksumSha256 ? (
            <code title={active.checksumSha256}>SHA-256 {active.checksumSha256.slice(0, 12)}…</code>
          ) : null}
        </p>
      ) : null}
      <p className="research-media-boundary">仅用于研究参考 不进入原创素材或发布生产流程</p>
      <dialog
        ref={dialog}
        className="research-image-dialog research-private-dialog"
        aria-label="竞品图片大图"
        data-phase={phase}
        onCancel={(event) => {
          event.preventDefault();
          close();
        }}
        onClick={(event) => {
          if (event.target === dialog.current) close();
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowLeft") {
            event.preventDefault();
            move(-1);
          }
          if (event.key === "ArrowRight") {
            event.preventDefault();
            move(1);
          }
        }}
      >
        <div className="research-lightbox-tools">
          <button
            type="button"
            aria-label="上一张研究图片"
            onClick={() => move(-1)}
            disabled={images.length < 2}
          >
            <ChevronLeft size={20} />
          </button>
          <button
            type="button"
            aria-label="下一张研究图片"
            onClick={() => move(1)}
            disabled={images.length < 2}
          >
            <ChevronRight size={20} />
          </button>
          <button type="button" aria-label="关闭大图" onClick={close}>
            <X size={20} />
          </button>
        </div>
        {phase !== "closed" && value?.canReadArchive ? render(active, true) : null}
        <p>
          研究参考 · {active ? ordinal(active) : "未选择"} · 共 {value?.total ?? 0} 项
        </p>
      </dialog>
    </figure>
  );
}
function captureStatus(value: string) {
  return (
    (
      {
        complete: "采集完成",
        partial: "部分采集",
        failed: "采集未完成",
        normalizing: "整理中",
      } as Record<string, string>
    )[value] ?? "状态待核对"
  );
}
export function mediaStatus(value: string) {
  return (
    (
      {
        queued: "等待归档",
        processing: "归档中",
        archived: "已归档",
        failed: "归档失败",
        excluded: "未选入归档",
      } as Record<string, string>
    )[value] ?? "状态待核对"
  );
}
function formatBytes(value: number) {
  if (value < 1024) return `${value} B`;
  return value < 1024 * 1024
    ? `${Math.round(value / 1024)} KiB`
    : `${(value / 1024 / 1024).toFixed(1)} MiB`;
}
