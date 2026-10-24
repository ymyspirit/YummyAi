import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { URL } from "node:url";
import { CANVAS_BRIDGE } from "../../packages/contracts/src/pod/canvas-bridge.ts";

await import("../../packages/infinite-canvas-plugin/build.mjs");
const destination = new URL("../../apps/web/public/plugins/", import.meta.url);
await mkdir(destination, { recursive: true });
const source = new URL(`../../packages/infinite-canvas-plugin/dist/${CANVAS_BRIDGE.pluginFile}`, import.meta.url);
const prefix = CANVAS_BRIDGE.pluginFile.replace(/\.js$/, "");
await copyFile(source, new URL(CANVAS_BRIDGE.pluginFile, destination));
await copyFile(new URL("../../packages/infinite-canvas-plugin/vendor/LICENSE", import.meta.url), new URL(`${prefix}.LICENSE.txt`, destination));
const sha256 = createHash("sha256").update(await readFile(source)).digest("hex");
await writeFile(new URL(`${prefix}.manifest.json`, destination), JSON.stringify({ ...CANVAS_BRIDGE, sha256 }, null, 2) + "\n");
