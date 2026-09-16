"use client";
import type { CaptureDraft } from "@yummyai/contracts/capture";
import { ImageIcon, ImageOff, ZoomIn, X, Play } from "lucide-react";
import { useRef, useState } from "react";

export function ResearchMediaGallery({
  media,
  title,
}: {
  media: CaptureDraft["media"];
  title: string;
}) {
  const entries = media.map((item, index) => ({ ...item, index })).filter((item) => item.included);
  const [selected, setSelected] = useState(0);
  const [failed, setFailed] = useState<number[]>([]);
  const [failedThumbnails, setFailedThumbnails] = useState<number[]>([]);
  const dialog = useRef<HTMLDialogElement>(null);
  const active = entries[selected];
  const failure = () => active && setFailed((current) => [...new Set([...current, active.index])]);
  const retry = () => {
    if (!active) return;
    setFailed((current) => current.filter((index) => index !== active.index));
    setFailedThumbnails((current) => current.filter((index) => index !== active.index));
  };
  const preview =
    active && !failed.includes(active.index) ? (
      active.kind === "image" ? (
        <img
          key={active.sourceUrl}
          src={active.sourceUrl}
          alt={active.alt || `${title} · 图片 ${active.index + 1}`}
          referrerPolicy="no-referrer"
          onError={failure}
        />
      ) : (
        <video
          key={active.sourceUrl}
          src={active.sourceUrl}
          controls
          preload="metadata"
          onError={failure}
          aria-label={`视频 ${active.index + 1}`}
        />
      )
    ) : (
      <div className="dossier-media-empty">
        <ImageIcon size={24} />
        <span>{active ? "媒体链接暂时无法加载" : "本次快照未包含图片或视频"}</span>
        {active && (
          <button type="button" onClick={retry}>
            重新加载媒体
          </button>
        )}
        {active && (
          <a href={active.sourceUrl} target="_blank" rel="noreferrer">
            查看原始媒体
          </a>
        )}
      </div>
    );
  return (
    <figure className="dossier-media research-gallery" aria-label="竞品媒体浏览">
      <div className="research-gallery-stage">{preview}</div>
      <figcaption>
        <span>
          {entries.filter((m) => m.kind === "image").length} 张图片 ·{" "}
          {entries.filter((m) => m.kind === "video").length} 个视频
        </span>
        {active?.kind === "image" && (
          <button
            type="button"
            onClick={() => dialog.current?.showModal()}
            aria-label="放大当前图片"
            disabled={failed.includes(active.index)}
          >
            <ZoomIn size={16} />
          </button>
        )}
      </figcaption>
      <div className="research-gallery-thumbs" aria-label="选择图片或视频">
        {entries.map((item, index) => (
          <button
            key={item.index}
            type="button"
            onClick={() => setSelected(index)}
            aria-label={`查看${item.kind === "image" ? "图片" : "视频"} ${item.index + 1}`}
            aria-pressed={index === selected}
          >
            {item.kind === "image" ? (
              failedThumbnails.includes(item.index) ? (
                <ImageOff size={18} aria-hidden="true" />
              ) : (
                <img
                  src={item.sourceUrl}
                  alt=""
                  loading="lazy"
                  referrerPolicy="no-referrer"
                  onError={() =>
                    setFailedThumbnails((current) => [...new Set([...current, item.index])])
                  }
                />
              )
            ) : (
              <Play size={20} />
            )}
            <span>{item.index + 1}</span>
          </button>
        ))}
      </div>
      <dialog ref={dialog} className="research-image-dialog" aria-label="竞品图片大图">
        <button
          type="button"
          className="research-image-close"
          onClick={() => dialog.current?.close()}
          aria-label="关闭大图"
        >
          <X size={20} />
        </button>
        {active?.kind === "image" &&
          (failed.includes(active.index) ? (
            <div className="dossier-media-empty">
              <span>图片暂时无法加载</span>
              <button type="button" onClick={retry}>
                重新加载媒体
              </button>
            </div>
          ) : (
            <img
              key={active.sourceUrl}
              src={active.sourceUrl}
              alt={active.alt || title}
              referrerPolicy="no-referrer"
              onError={failure}
            />
          ))}
        <p>媒体 {active ? active.index + 1 : 0} · 研究参考</p>
      </dialog>
    </figure>
  );
}
