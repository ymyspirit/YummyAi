import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SegmentProductionImageResultSchema, type SegmentProductionImageInput } from "@yummyai/contracts/pod/production-cutout";

const root = new URL("../../../../", import.meta.url);
const python = () => process.env.PRODUCTION_SEGMENTATION_PYTHON || fileURLToPath(new URL("output/segmentation/venv/Scripts/python.exe", root));
const checkpoint = () => process.env.PRODUCTION_SEGMENTATION_CHECKPOINT || fileURLToPath(new URL("output/segmentation/sam2.1_hiera_tiny.pt", root));
let running = false;
export const localSegmentationAvailable = () => existsSync(python()) && existsSync(checkpoint()) && existsSync(checkpoint().replace(/\.pt$/i, ".ready"));

/** No shell, external HTTP, source files, credentials or customer data in logs. */
export async function runLocalSegmentation(bytes: Uint8Array, input: SegmentProductionImageInput) {
  if (!localSegmentationAvailable()) throw new Error("segmenter_unavailable");
  if (running) throw new Error("segmenter_busy");
  running = true;
  try {
    const output = await new Promise<string>((resolve, reject) => {
      const child = spawn(python(), [fileURLToPath(new URL("tools/segmentation/predict.py", root)), checkpoint()], {
        windowsHide: true, stdio: ["pipe", "pipe", "ignore"],
        env: { SYSTEMROOT: process.env.SYSTEMROOT, WINDIR: process.env.WINDIR, PATH: process.env.PATH, PYTHONIOENCODING: "utf-8", PYTHONUNBUFFERED: "1" },
      });
      let result = "";
      const timer = setTimeout(() => { child.kill(); reject(new Error("segmenter_timeout")); }, 95_000);
      child.once("error", () => { clearTimeout(timer); reject(new Error("segmenter_unavailable")); });
      child.stdout.on("data", (chunk: Buffer) => { result += chunk.toString("utf8"); if (result.length > 2_100_000) { child.kill(); reject(new Error("segmenter_output_limit")); } });
      child.stdin.on("error", () => { /* Exit handler reports an actionable, non-sensitive failure. */ });
      child.once("close", (code) => { clearTimeout(timer); if (code === 0) resolve(result); else reject(new Error("segmenter_failed")); });
      child.stdin.end(JSON.stringify({ imageBase64: Buffer.from(bytes).toString("base64"), box: input.box, points: input.points }));
    });
    return SegmentProductionImageResultSchema.parse(JSON.parse(output));
  } finally { running = false; }
}
