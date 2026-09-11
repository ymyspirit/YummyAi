import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

export async function startProductionEditorWorker(): Promise<ChildProcess> {
  const processHandle = spawn(process.execPath, ["--import", "tsx", "e2e/production-editor-worker.mts"], { cwd: fileURLToPath(new URL("../../worker/", import.meta.url)), env: process.env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { processHandle.kill(); reject(new Error("Production editor acceptance worker did not start")); }, 30_000);
    processHandle.once("error", () => { clearTimeout(timer); reject(new Error("Production editor acceptance worker failed to start")); });
    processHandle.once("exit", (code) => { clearTimeout(timer); reject(new Error(`Production editor acceptance worker exited (${code})`)); });
    processHandle.stdout?.on("data", (chunk: Buffer) => { if (chunk.toString().includes("PRODUCTION_EDITOR_WORKER_READY")) { clearTimeout(timer); resolve(); } });
  });
  return processHandle;
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
