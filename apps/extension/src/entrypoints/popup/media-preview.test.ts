import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { MediaPreview } from "./media-preview.js";

describe("MediaPreview", () => {
  it("renders a captured video as video media instead of a broken image", () => {
    const html = renderToStaticMarkup(
      createElement(MediaPreview, {
        item: {
          id: "video-10",
          kind: "video",
          sourceUrl: "https://v.etsystatic.com/video/upload/example.mp4",
          included: true,
        },
        index: 9,
      }),
    );

    expect(html).toContain("<video");
    expect(html).toContain('preload="metadata"');
    expect(html).toContain('aria-label="商品视频 10"');
    expect(html).toContain("视频");
    expect(html).not.toContain("<img");
  });

  it("keeps captured images as image previews", () => {
    const html = renderToStaticMarkup(
      createElement(MediaPreview, {
        item: {
          id: "image-1",
          kind: "image",
          sourceUrl: "https://i.etsystatic.com/example.jpg",
          included: true,
        },
        index: 0,
      }),
    );

    expect(html).toContain("<img");
    expect(html).toContain('alt="商品图片 1"');
    expect(html).not.toContain("<video");
  });
});
