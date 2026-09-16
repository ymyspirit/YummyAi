import type { PillowAlphaMask } from "./pillow-outline";
import type { ShapedPillowDocument } from "@yummyai/contracts/pod/production-editor";
import { optimizePillowContour, smoothExistingPillowContour, type PillowContourSettings } from "./pillow-contour-optimizer";

self.onmessage = (event: MessageEvent<{ settings: PillowContourSettings } & ({ mode: "current"; document: ShapedPillowDocument } | { mode: "subject"; mask: PillowAlphaMask; whiteBorderMm: number })>) => {
  try {
    const input = event.data;
    self.postMessage({ points: input.mode === "current" ? smoothExistingPillowContour(input.document, input.settings.roundingPx) : optimizePillowContour(input.mask, input.whiteBorderMm, input.settings) });
  } catch (cause) {
    self.postMessage({ error: cause instanceof Error ? cause.message : "轮廓优化未完成，请重试。" });
  }
};
