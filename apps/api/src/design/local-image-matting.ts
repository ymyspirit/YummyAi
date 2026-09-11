import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { RefineProductionImageResultSchema, type RefineProductionImageInput } from "@yummyai/contracts/pod/production-cutout";

const root = new URL("../../../../", import.meta.url);
const python = () => process.env.PRODUCTION_SEGMENTATION_PYTHON || fileURLToPath(new URL("output/segmentation/venv/Scripts/python.exe", root));
const model = fileURLToPath(new URL("output/segmentation/vitmatte-small/", root));
let running = false;
export const localMattingAvailable = () => existsSync(python()) && existsSync(`${model}/model.safetensors`) && existsSync(`${model}/.ready`);

/** Bounded offline subprocess. No credentials, source files, remote code or runtime downloads. */
export async function runLocalMatting(pixels: { image: Uint8Array; mask: Uint8Array; width: number; height: number }, input: RefineProductionImageInput) {
  if (!localMattingAvailable()) throw new Error("matting_unavailable");
  if (running) throw new Error("matting_busy");
  running = true;
  try {
    const output = await new Promise<string>((resolve, reject) => {
      const child = spawn(python(), [fileURLToPath(new URL("tools/segmentation/matting.py", root)), model], {
        windowsHide: true, stdio: ["pipe", "pipe", "ignore"],
        env: { SYSTEMROOT: process.env.SYSTEMROOT, WINDIR: process.env.WINDIR, PATH: process.env.PATH, PYTHONIOENCODING: "utf-8", PYTHONUNBUFFERED: "1", HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1", HF_HUB_DISABLE_TELEMETRY: "1" },
      });
      let result = "";
      let failure: string | undefined;
      const timer = setTimeout(() => { failure = "matting_timeout"; child.kill(); }, 95_000);
      child.once("error", () => { clearTimeout(timer); reject(new Error("matting_unavailable")); });
      child.stdout.on("data", (chunk: Buffer) => { result += chunk.toString("utf8"); if (result.length > 2_100_000) { failure = "matting_output_limit"; child.kill(); } });
      child.stdin.on("error", () => { /* The close handler reports a non-sensitive error. */ });
      child.once("close", (code) => { clearTimeout(timer); if (code === 0 && !failure) resolve(result); else reject(new Error(failure ?? "matting_failed")); });
      child.stdin.end(JSON.stringify({ imageBase64: Buffer.from(pixels.image).toString("base64"), maskPngBase64: Buffer.from(pixels.mask).toString("base64"), radius: input.radius, strokes: input.strokes }));
    });
    const result = RefineProductionImageResultSchema.parse(JSON.parse(output));
    if (result.width !== pixels.width || result.height !== pixels.height) throw new Error("matting_dimension_mismatch");
    return result;
  } finally { running = false; }
}
