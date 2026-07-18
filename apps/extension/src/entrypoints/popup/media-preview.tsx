import type { CaptureDraft } from "@yummyai/contracts";
import { Play } from "lucide-react";

type CaptureMedia = CaptureDraft["media"][number];

export function MediaPreview({ item, index }: { item: CaptureMedia; index: number }) {
  if (item.kind === "video") {
    return (
      <>
        <video
          className="media-preview"
          src={item.sourceUrl}
          aria-label={item.alt ?? `商品视频 ${index + 1}`}
          muted
          playsInline
          preload="metadata"
        />
        <span className="media-kind-badge" aria-hidden="true">
          <Play size={11} fill="currentColor" />
          视频
        </span>
      </>
    );
  }

  return (
    <img
      className="media-preview"
      src={item.sourceUrl}
      alt={item.alt ?? `商品图片 ${index + 1}`}
      width="72"
      height="72"
      loading="lazy"
    />
  );
}
