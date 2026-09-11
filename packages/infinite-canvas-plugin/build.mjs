import { build } from "esbuild";
import { fileURLToPath, URL } from "node:url";
import { CANVAS_BRIDGE } from "@yummyai/contracts/pod/canvas-bridge";

await build({
  entryPoints: [fileURLToPath(new URL("src/index.tsx", import.meta.url))],
  outfile: fileURLToPath(new URL(`dist/${CANVAS_BRIDGE.pluginFile}`, import.meta.url)),
  bundle: true, format: "esm", platform: "browser", target: "es2022", jsx: "transform",
  minify: true, legalComments: "inline",
  banner: { js: `/*! YummyAI Canvas Bridge ${CANVAS_BRIDGE.pluginVersion} | Infinite Canvas public SDK types: MIT, basketikun. See THIRD_PARTY_LICENSES.md. */` },
});
