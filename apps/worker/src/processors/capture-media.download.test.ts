import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import { CaptureMediaDownloader, captureMediaUrl, inspectCaptureMedia, type MediaDownloadTransport } from "./capture-media.download.js";

describe("public research media download boundary", () => {
  it.each([
    "http://m.media-amazon.com/a.jpg", "https://127.0.0.1/a.jpg", "https://m.media-amazon.com:8443/a.jpg",
    "https://user:password@m.media-amazon.com/a.jpg", "https://m.media-amazon.com/a.jpg?token=secret",
    "https://m.media-amazon.com.attacker.example/a.jpg", "https://i.etsystatic.com/a.jpg",
  ])("rejects an unsafe or wrong-platform URL before DNS: %s", async (url) => {
    const resolve = vi.fn();
    await expect(new CaptureMediaDownloader({ resolve, read: vi.fn() }).download(url, "amazon", "image")).rejects.toThrow(/^MEDIA_/);
    expect(resolve).not.toHaveBeenCalled();
  });
  it.each(["127.0.0.1", "10.0.0.1", "169.254.169.254", "100.64.0.1", "::1", "::ffff:127.0.0.1", "fc00::1"]) (
    "rejects a mixed public/private DNS answer including %s", async (address) => {
      const read = vi.fn();
      await expect(new CaptureMediaDownloader({ resolve: async () => [{ address: "93.184.216.34", family: 4 }, { address, family: address.includes(":") ? 6 : 4 }], read })
        .download("https://m.media-amazon.com/a.jpg", "amazon", "image")).rejects.toThrow("MEDIA_ADDRESS_UNSAFE");
      expect(read).not.toHaveBeenCalled();
    },
  );
  it("validates every redirect and passes only the validated address to transport", async () => {
    const read = vi.fn<MediaDownloadTransport["read"]>().mockResolvedValueOnce({ status: 302, location: "https://i.etsystatic.com/a.jpg", body: new Uint8Array(), mediaType: "" });
    const downloader = new CaptureMediaDownloader({ resolve: async () => [{ address: "93.184.216.34", family: 4 }], read });
    await expect(downloader.download("https://m.media-amazon.com/a.jpg", "amazon", "image")).rejects.toThrow("MEDIA_CDN_UNSUPPORTED");
    expect(read).toHaveBeenCalledTimes(1);
    expect(read.mock.calls[0]?.[1]).toEqual({ address: "93.184.216.34", family: 4 });
  });
  it("re-resolves a permitted redirect and prevents DNS rebinding", async () => {
    const resolve = vi.fn<MediaDownloadTransport["resolve"]>()
      .mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 }]).mockResolvedValueOnce([{ address: "127.0.0.1", family: 4 }]);
    const read = vi.fn<MediaDownloadTransport["read"]>().mockResolvedValue({ status: 302, location: "/other.jpg", body: new Uint8Array(), mediaType: "" });
    await expect(new CaptureMediaDownloader({ resolve, read }).download("https://m.media-amazon.com/a.jpg", "amazon", "image")).rejects.toThrow("MEDIA_ADDRESS_UNSAFE");
    expect(read).toHaveBeenCalledTimes(1);
  });
  it("bounds successful bodies and reports retryable throttling without leaking URLs", async () => {
    const read = vi.fn<MediaDownloadTransport["read"]>().mockResolvedValueOnce({ status: 429, mediaType: "", body: new Uint8Array() })
      .mockResolvedValueOnce({ status: 200, mediaType: "image/jpeg", body: new Uint8Array(12 * 1024 * 1024 + 1) });
    const downloader = new CaptureMediaDownloader({ resolve: async () => [{ address: "93.184.216.34", family: 4 }], read });
    await expect(downloader.download("https://m.media-amazon.com/a.jpg", "amazon", "image")).rejects.toMatchObject({ code: "MEDIA_HTTP_FAILED", retryable: true });
    await expect(downloader.download("https://m.media-amazon.com/a.jpg", "amazon", "image")).rejects.toMatchObject({ code: "MEDIA_SIZE_INVALID", retryable: false });
    expect(captureMediaUrl("https://v.etsystatic.com/video/upload/a.mp4", "etsy").hostname).toBe("v.etsystatic.com");
  });
  it("decodes real images and rejects MIME mismatch, HTML and truncated image bytes", async () => {
    const png = await sharp({ create: { width: 40, height: 30, channels: 3, background: "blue" } }).png().toBuffer();
    const jpeg = await sharp(png).jpeg().toBuffer();
    await expect(inspectCaptureMedia(png, "image/png", "image")).resolves.toEqual({ type: "image/png", extension: "png" });
    await expect(inspectCaptureMedia(png, "image/jpeg", "image")).rejects.toThrow("MEDIA_TYPE_INVALID");
    await expect(inspectCaptureMedia(Buffer.from("<html>error</html>"), "image/png", "image")).rejects.toThrow("MEDIA_IMAGE_INVALID");
    await expect(inspectCaptureMedia(jpeg.subarray(0, jpeg.length - 30), "image/jpeg", "image")).rejects.toThrow("MEDIA_IMAGE_INVALID");
  });
  it("keeps video containers distinct and rejects a JPEG relabelled as video", async () => {
    const mp4 = Buffer.alloc(40); mp4.writeUInt32BE(24, 0); mp4.write("ftypisom", 4);
    await expect(inspectCaptureMedia(mp4, "video/mp4", "video")).resolves.toEqual({ type: "video/mp4", extension: "mp4" });
    await expect(inspectCaptureMedia(mp4, "image/png", "image")).rejects.toThrow("MEDIA_IMAGE_INVALID");
    await expect(inspectCaptureMedia(Buffer.from([0xff, 0xd8, 0xff, ...Array<number>(40).fill(0)]), "video/mp4", "video")).rejects.toThrow("MEDIA_TYPE_INVALID");
  });
});
