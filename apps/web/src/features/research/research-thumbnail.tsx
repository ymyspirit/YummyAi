"use client";

import { ImageOff, ImageIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

export function ResearchThumbnail({ src, alt }: { src?: string | null; alt: string }) {
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
