import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";

import { adaptArtwork } from "./pod-batch-workflow.processor.js";

const spec = {
  aspectWidth: 1,
  aspectHeight: 1,
  safeZoneMm: "20",
  physicalSizes: [{ key: "300x300", label: "300 × 300 mm", widthMm: 300, heightMm: 300 }],
};

async function raster(width: number, height: number, color = "#397d9a") {
  return new Uint8Array(await sharp({ create: { width, height, channels: 4, background: color } }).png().toBuffer());
}

describe("creative canvas adaptation", () => {
  it("uses a deterministic focal crop without stretching when the safe zone survives", async () => {
    const outpaint = vi.fn();
    const result = await adaptArtwork(await raster(400, 300), { xPermille: 500, yPermille: 500 }, spec, outpaint);
    const metadata = await sharp(result.bytes).metadata();

    expect(result.mode).toBe("crop");
    expect(metadata.width).toBe(300);
    expect(metadata.height).toBe(300);
    expect(outpaint).not.toHaveBeenCalled();
    expect(result.qualitySnapshot).toMatchObject({ safeZonePreserved: true, crop: { left: 50, top: 0, width: 300, height: 300 } });
  });

  it("switches to AI outpaint and records generated regions when a focal crop breaks the safe zone", async () => {
    const outpaint = vi.fn(async () => ({
      bytes: await raster(420, 320, "#92507e"),
      generatedRegions: [{ x: 0, y: 0, width: 40, height: 320 }],
      qualitySnapshot: { provider: "fixture" },
    }));
    const result = await adaptArtwork(await raster(400, 300), { xPermille: 0, yPermille: 500 }, spec, outpaint);
    const metadata = await sharp(result.bytes).metadata();

    expect(result.mode).toBe("ai_outpaint");
    expect(result.generatedRegions).toEqual([{ x: 0, y: 0, width: 40, height: 320 }]);
    expect(metadata.width).toBe(metadata.height);
    expect(outpaint).toHaveBeenCalledOnce();
  });
});
