import { describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { readResearchImage } from "./ai-assist.processor.js";
describe("research image input boundary", () => {
  it.each([
    "http://i.etsystatic.com/a.jpg",
    "https://127.0.0.1/a.png",
    "https://i.etsystatic.com.evil.test/a.jpg",
    "https://user:password@i.etsystatic.com/a.jpg",
    "https://i.etsystatic.com:444/a.jpg",
  ])("rejects an unsafe source before fetching: %s", async (url) => {
    const request = vi.fn();
    await expect(readResearchImage(url, request)).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });
  it("passes actual bounded images as data URLs and rejects oversized responses", async () => {
    const bytes = await sharp({
      create: { width: 10, height: 10, channels: 3, background: "white" },
    })
      .png()
      .toBuffer();
    const request = vi.fn(
      async () => new Response(bytes, { headers: { "content-type": "image/png" } }),
    );
    expect(await readResearchImage("https://i.etsystatic.com/synthetic.png", request)).toMatch(
      /^data:image\/jpeg;base64,/,
    );
    expect(request).toHaveBeenCalledWith(
      expect.any(URL),
      expect.objectContaining({ redirect: "error" }),
    );
    await expect(
      readResearchImage(
        "https://i.etsystatic.com/large.png",
        async () =>
          new Response(new Uint8Array(4 * 1024 * 1024 + 1), {
            headers: { "content-type": "image/png" },
          }),
      ),
    ).rejects.toThrow("image_too_large");
  });
});
