import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import process from "node:process";

import JSZip from "jszip";

const file = process.argv[2];
if (!file) throw new Error("Usage: node tools/scripts/verify-export.mjs <export.zip>");

const zip = await JSZip.loadAsync(await readFile(file));
const manifestEntry = zip.file("manifest.json");
if (!manifestEntry) throw new Error("manifest.json is missing");
const manifest = JSON.parse(await manifestEntry.async("string"));
assertManifest(manifest);

for (const expected of manifest.files) {
  const entry = zip.file(expected.path);
  if (!entry) throw new Error(`missing file: ${expected.path}`);
  const actual = createHash("sha256").update(await entry.async("uint8array")).digest("hex");
  if (actual !== expected.sha256) throw new Error(`checksum mismatch: ${expected.path}`);
}

process.stdout.write("manifest valid; all checksums match\n");

function assertManifest(value) {
  if (!value || typeof value !== "object") throw new Error("manifest must be an object");
  for (const key of ["exportId", "tenantId", "platform", "listingId", "listingVersionId", "ruleVersion", "createdBy", "createdAt"]) {
    if (typeof value[key] !== "string" || !value[key]) throw new Error(`invalid manifest field: ${key}`);
  }
  if (!Array.isArray(value.files)) throw new Error("manifest files must be an array");
  for (const entry of value.files) {
    if (typeof entry.path !== "string" || entry.path.startsWith("/") || entry.path.includes("..")) throw new Error("unsafe manifest path");
    if (!/^[a-f0-9]{64}$/.test(entry.sha256)) throw new Error(`invalid checksum: ${entry.path}`);
    if (typeof entry.assetId !== "string" || !Number.isInteger(entry.assetVersion) || entry.assetVersion < 1) throw new Error(`invalid asset pin: ${entry.path}`);
  }
}
