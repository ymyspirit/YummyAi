import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { SHAPED_PILLOW_FACTORY_STANDARD, type ProductionEditorDocument, type ProductionEditorImageLayer, type ProductionProductType } from "@yummyai/contracts/pod/production-editor";
import { createDefaultProductionDocument } from "@yummyai/production-editor/products";
import { getProductionBodySize } from "@yummyai/production-editor/geometry";

export type SyntheticCenterOptions = { longestSideInches?: 10 | 12 };

/** New synthetic drafts only. Shared defaults pin the current factory identity. */
export function createSyntheticCenterDocument(kind: ProductionProductType, options: SyntheticCenterOptions = {}): ProductionEditorDocument {
  const document = createDefaultProductionDocument(kind);
  document.name = "Synthetic center process template";
  if (document.productType === "tire_cover") document.spec = { ...document.spec, diameterMm: 50, dpi: 150, safeInsetMm: 2 };
  else if (document.productType === "rectangular_print") document.spec = { ...document.spec, widthMm: 60, heightMm: 40, dpi: 150, safeInsetMm: 2 };
  else {
    const rule = SHAPED_PILLOW_FACTORY_STANDARD;
    const artworkInches = options.longestSideInches ?? 10, artworkPx = artworkInches * rule.dpi;
    const mm = (pixels: number) => pixels * 25.4 / rule.dpi;
    const edge = mm(artworkPx + 2 * rule.whiteBorderPx);
    document.spec = { ...document.spec, widthMm: edge, heightMm: edge, declaredLongestMm: artworkInches * 254 / 10,
      sizeBasis: "artwork", minimumNeckBasis: "cut_contour", sideMode: "single",
      barcodeTab: { ...document.spec.barcodeTab, centerXMm: mm(artworkPx / 2 + rule.whiteBorderPx) } };
    document.contour = [{ xMm: 0, yMm: 0, smooth: false }, { xMm: edge, yMm: 0, smooth: false },
      { xMm: edge, yMm: edge, smooth: false }, { xMm: 0, yMm: edge, smooth: false }];
  }
  return document;
}

/** Place the actual uploaded synthetic raster; this never invents alpha or DPI. */
export function placeSyntheticCenterImage(document: ProductionEditorDocument, image: { id: string; version?: number; name: string; width: number; height: number }): ProductionEditorImageLayer {
  if (![image.width, image.height].every(value => Number.isSafeInteger(value) && value > 0)) throw new Error("Synthetic center source dimensions are invalid");
  const common = { id: "synthetic-center-artwork", kind: "image" as const, name: image.name.slice(0, 160), assetId: image.id, assetVersion: image.version ?? 1,
    rotationDeg: 0, opacity: 1, visible: true, locked: false, flipX: false, flipY: false };
  if (document.productType === "shaped_pillow") {
    const rule = SHAPED_PILLOW_FACTORY_STANDARD, artworkMm = document.spec.declaredLongestMm;
    if (document.spec.factoryStandardId !== rule.id || document.spec.sizeBasis !== "artwork" || !artworkMm || image.width !== image.height)
      throw new Error("Synthetic center pillow placement requires the pinned factory document and known square artwork");
    const borderMm = rule.whiteBorderPx * 25.4 / rule.dpi;
    return { ...common, xMm: borderMm, yMm: borderMm, widthMm: artworkMm, heightMm: artworkMm, locked: true };
  }
  const size = getProductionBodySize(document), ratio = Math.min(size.width * 0.68 / image.width, size.height * 0.68 / image.height);
  return { ...common, xMm: (size.width - image.width * ratio) / 2, yMm: (size.height - image.height * ratio) / 2, widthMm: image.width * ratio, heightMm: image.height * ratio };
}

/** Public diagnostic categories only; never echo arbitrary upstream text or URLs. */
export function productionEditorFixtureFailureDiagnostic(path: string, status: number, payload: unknown): string {
  const route = path.split("?", 1)[0];
  const operation = route === "production-editor/projects" ? "production-editor/projects"
    : /^production-editor\/projects\/[0-9a-f-]{36}\/images$/i.test(route ?? "") ? "production-editor/projects/:id/images"
      : /^production-editor\/projects\/[0-9a-f-]{36}\/fonts$/i.test(route ?? "") ? "production-editor/projects/:id/fonts"
        : /^production-editor\/projects\/[0-9a-f-]{36}\/versions$/i.test(route ?? "") ? "production-editor/projects/:id/versions"
          : /^production-editor\/projects\/[0-9a-f-]{36}\/review$/i.test(route ?? "") ? "production-editor/projects/:id/review"
            : route === "order-centers/profiles" ? "order-centers/profiles" : "fixture API request";
  const reasons: Record<string, string> = {
    "安全扫描暂不可用，文件未保存": "scan_unavailable",
    "文件未通过安全扫描": "scan_rejected",
    "仅支持有效的单页 PNG/JPEG/TIFF，最多一亿像素": "image_decode_invalid",
    "仅支持有效的 TTF/OTF 字体": "font_decode_invalid",
    "图片最大 64 MiB": "upload_size_limit",
    "字体最大 10 MiB": "upload_size_limit",
    "文件编码无效": "base64_invalid",
  };
  const message = payload && typeof payload === "object" && !Array.isArray(payload) && "message" in payload && typeof payload.message === "string" ? payload.message : null;
  const reason = status === 422 && message && Object.hasOwn(reasons, message) ? reasons[message]
    : status === 401 ? "session_required" : status === 403 ? "permission_denied" : status === 409 ? "source_or_version_conflict"
      : status === 400 ? "request_rejected" : "unclassified_rejection";
  return `${operation}: HTTP ${status}; diagnostic=${reason}`;
}

export async function startProductionEditorWorker(options?: { fault?: "unknown_pillow_cutout"|"expire_order_before_response"; onModelCall?: () => void }): Promise<ChildProcess> {
  const processHandle = spawn(process.execPath, ["--import", "tsx", "e2e/production-editor-worker.mts"], { cwd: fileURLToPath(new URL("../../worker/", import.meta.url)),
    env: { ...process.env, ...(options?.fault ? { E2E_DESIGN_AGENT_FAULT: options.fault } : {}) }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let pendingOutput = "";
  processHandle.stdout?.on("data", (chunk: Buffer) => {
    pendingOutput += chunk.toString();
    const lines = pendingOutput.split("\n"); pendingOutput = lines.pop()!;
    for (const line of lines) if (line.trim() === "SYNTHETIC_DESIGN_MODEL_CALL") options?.onModelCall?.();
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { processHandle.kill(); reject(new Error("Production editor acceptance worker did not start")); }, 30_000);
    processHandle.once("error", () => { clearTimeout(timer); reject(new Error("Production editor acceptance worker failed to start")); });
    processHandle.once("exit", (code) => { clearTimeout(timer); reject(new Error(`Production editor acceptance worker exited (${code})`)); });
    processHandle.stdout?.on("data", (chunk: Buffer) => { if (chunk.toString().includes("PRODUCTION_EDITOR_WORKER_READY")) { clearTimeout(timer); resolve(); } });
  });
  return processHandle;
}

export async function stopProductionEditorWorker(worker?: ChildProcess) {
  if (!worker || worker.exitCode !== null || worker.signalCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Production acceptance worker did not exit")), 8000);
    worker.once("exit", () => { clearTimeout(timer); resolve(); });
    worker.kill();
  });
}

// Synthetic two-colour artwork: no customer production files enter test fixtures.
export function syntheticProductionPng(size = 512, shapedCutout = false): Buffer {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const at = y * (size * 4 + 1) + 1 + x * 4;
    raw[at] = x < size / 2 ? 225 : 25; raw[at + 1] = 90; raw[at + 2] = x < size / 2 ? 80 : 205; raw[at + 3] = 255;
    if (shapedCutout && ((x / size - 0.45) / 0.28) ** 2 + ((y / size - 0.5) / 0.36) ** 2 > 1) raw[at + 3] = 0;
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk("IHDR", ihdr), pngChunk("IDAT", deflateSync(raw)), pngChunk("IEND", Buffer.alloc(0))]);
}

export function pngResolution(bytes: Buffer) {
  let density = 0;
  for (let offset = 8; offset + 12 <= bytes.length;) {
    const length = bytes.readUInt32BE(offset), name = bytes.toString("ascii", offset + 4, offset + 8);
    if (name === "pHYs" && bytes[offset + 16] === 1) density = bytes.readUInt32BE(offset + 8) * 0.0254;
    offset += 12 + length;
  }
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), density };
}

function pngChunk(name: string, data: Buffer) {
  const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(name), data]);
  let checksum = 0xffffffff;
  for (const byte of body) { checksum ^= byte; for (let bit = 0; bit < 8; bit++) checksum = checksum & 1 ? 0xedb88320 ^ (checksum >>> 1) : checksum >>> 1; }
  const crc = Buffer.alloc(4); crc.writeUInt32BE((checksum ^ 0xffffffff) >>> 0);
  return Buffer.concat([length, body, crc]);
}
