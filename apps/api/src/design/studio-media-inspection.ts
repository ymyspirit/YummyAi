import { Worker } from "node:worker_threads";
import sharp from "sharp";
import { STUDIO_ORIGINAL_MEDIA_LIMIT, StudioTechnicalInfoSchema, type StudioTechnicalInfo } from "@yummyai/contracts/pod/studio-original";

const supportedImages = new Set(["image/png", "image/jpeg", "image/webp"]);
const supportedContainers = new Set(["video/mp4", "video/webm", "audio/mpeg", "audio/wav"]);
const failure = (code: Extract<StudioTechnicalInfo, { code: string }>["code"]): StudioTechnicalInfo => ({ status: "failed", code });
let mediaWorkers = 0;

/** Facts about the exact original bytes. No thumbnail, orientation transform or
 * client document is used as the source, and no output file is produced. */
export async function inspectStudioOriginalBytes(bytes: Uint8Array, mediaType: string): Promise<StudioTechnicalInfo> {
  if (!bytes.byteLength) return failure("invalid_media");
  if (bytes.byteLength > STUDIO_ORIGINAL_MEDIA_LIMIT) return failure("size_limit");
  if (supportedImages.has(mediaType)) {
    try {
      const image = sharp(bytes, { limitInputPixels: 64_000_000, failOn: "error" }).timeout({ seconds: 3 });
      const metadata = await image.metadata();
      if (`image/${metadata.format}` !== mediaType) return failure("media_type_mismatch");
      if (!metadata.width || !metadata.height || (metadata.pages ?? 1) !== 1) return failure("invalid_media");
      await image.stats();
      const orientation = metadata.orientation ?? 1, swapped = orientation >= 5;
      return StudioTechnicalInfoSchema.parse({ status: "verified", kind: "image", validation: "full_static_decode",
        encodedWidth: metadata.width, encodedHeight: metadata.height,
        displayWidth: swapped ? metadata.height : metadata.width, displayHeight: swapped ? metadata.width : metadata.height, orientation });
    } catch { return failure("invalid_media"); }
  }
  if (!supportedContainers.has(mediaType)) return { status: "unsupported", code: "unsupported_media" };
  // Avoid an unbounded queue of copies of private 20 MiB originals. The caller
  // can explicitly retry this read; a busy process does not invent verification.
  if (mediaWorkers >= 2) return { status: "unknown", code: "unavailable" };
  mediaWorkers++;
  try {
    return await new Promise<StudioTechnicalInfo>(resolve => {
      let settled = false;
      const worker = new Worker(new URL("./studio-media-inspection-worker.mjs", import.meta.url), {
        workerData: { bytes: Uint8Array.from(bytes), mediaType },
        resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 32, stackSizeMb: 4 },
        // This is plain ESM. Do not inherit tsx hooks, debugger listeners or
        // environment credentials into an otherwise memory-only parser.
        execArgv: [], env: {}, stdout: true, stderr: true,
      });
      worker.stdout.resume(); worker.stderr.resume();
      const finish = (result: StudioTechnicalInfo) => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        // Resolve only after the parser has actually stopped, including timeout.
        void worker.terminate().then(() => resolve(result), () => resolve(failure("invalid_media")));
      };
      const timer = setTimeout(() => finish(failure("inspection_timeout")), 5_000);
      worker.once("message", value => {
        const parsed = StudioTechnicalInfoSchema.safeParse(value);
        finish(parsed.success ? parsed.data : failure("invalid_media"));
      });
      worker.once("error", () => finish(failure("invalid_media")));
      worker.once("exit", () => { if (!settled) finish(failure("invalid_media")); });
    });
  } finally { mediaWorkers--; }
}
