"use client";

import { ImageOff, ImageIcon, LockKeyhole, Clock3 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { captureMediaHref, useCaptureMedia } from "./capture-media-client";
import "./research-media.css";

export function ResearchThumbnail({
  src,
  alt,
  snapshotId,
  privateArchive = false,
}: {
  src?: string | null;
  alt: string;
  snapshotId?: string;
  privateArchive?: boolean;
}) {
  return privateArchive ? (
    <PrivateThumbnail key={snapshotId ?? "missing"} snapshotId={snapshotId} alt={alt} />
  ) : (
    <PublicThumbnail src={src} alt={alt} />
  );
}
function PrivateThumbnail({ snapshotId, alt }: { snapshotId?: string; alt: string }) {
  const root = useRef<HTMLSpanElement>(null),
    [visible, setVisible] = useState(false),
    [failed, setFailed] = useState(false),
    [revision, setRevision] = useState(0);
  const state = useCaptureMedia(snapshotId, visible);
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => setVisible(Boolean(entries[0]?.isIntersecting)),
      { rootMargin: "150px" },
    );
    if (root.current) observer.observe(root.current);
    return () => observer.disconnect();
  }, []);
  const image = state.value?.media.find(
    (item) => item.kind === "image" && item.status === "archived",
  );
  const allowed = state.value?.canReadArchive;
  const message =
    state.error ??
    (state.value?.archivedItem
      ? "资料已归档"
      : state.value && !allowed
        ? "无素材权限"
        : failed
          ? "图片读取失败"
          : image
            ? undefined
            : state.value?.counts.queued || state.value?.counts.processing
              ? "归档中"
              : state.value
                ? "暂无私有图片"
                : "读取中");
  return (
    <span
      ref={root}
      className="research-private-thumb"
      aria-label={message ? `${alt}：${message}` : undefined}
    >
      {allowed && image && !failed ? (
        <img
          src={captureMediaHref(snapshotId!, image.id, revision)}
          alt={alt}
          loading="lazy"
          onError={() => {
            setFailed(true);
            void state.refresh();
          }}
        />
      ) : (
        <span className="research-thumb-placeholder" title={message}>
          {state.value && !allowed ? (
            <LockKeyhole size={16} />
          ) : state.busy || state.value?.counts.queued || state.value?.counts.processing ? (
            <Clock3 size={16} />
          ) : (
            <ImageOff size={16} />
          )}
          <small>{message}</small>
        </span>
      )}
      {failed || state.error ? (
        <button
          type="button"
          aria-label={`重新读取私有图片：${alt}`}
          className="research-thumb-retry"
          disabled={state.busy}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            setFailed(false);
            setRevision((value) => value + 1);
            void state.refresh();
          }}
        >
          重试
        </button>
      ) : null}
    </span>
  );
}
function PublicThumbnail({ src, alt }: { src?: string | null; alt: string }) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const image = useRef<HTMLImageElement>(null);
  useEffect(() => {
    // A cached failure can finish before React hydrates the server-rendered image.
    if (src && image.current?.complete && image.current.naturalWidth === 0) setFailedUrl(src);
  }, [src]);
  if (!src)
    return (
      <span className="research-thumb-placeholder" role="img" aria-label="暂无图片">
        <ImageIcon size={18} aria-hidden="true" />
        <span>暂无图</span>
      </span>
    );
  if (failedUrl === src)
    return (
      <button
        type="button"
        className="research-thumb-placeholder"
        title="图片加载失败，点击重试"
        aria-label={`重新加载图片：${alt}`}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setFailedUrl(null);
        }}
      >
        <ImageOff size={18} aria-hidden="true" />
        <span>重试</span>
      </button>
    );
  return (
    <img
      ref={image}
      key={src}
      src={src}
      alt={alt}
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setFailedUrl(src)}
    />
  );
}
