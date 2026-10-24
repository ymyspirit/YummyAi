import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";
import { startCanvasRuntime } from "./serve-canvas-runtime.mjs";
import { parseWebCandidateArgs, verifyLocalWebCandidate } from "./local-web-candidate.mjs";

const mode = process.argv[2];
if (!["dev", "start"].includes(mode)) {
  process.stderr.write("Usage: start-web.mjs <dev|start> [...next arguments]\n");
  process.exit(1);
}

const nextCli = fileURLToPath(
  new URL("../../apps/web/node_modules/next/dist/bin/next", import.meta.url),
);
const workspace = fileURLToPath(new URL("../../", import.meta.url));
let webRoot = fileURLToPath(new URL("../../apps/web/", import.meta.url));
const { id: candidateId, nextArgs } = parseWebCandidateArgs(process.argv.slice(3));
if (candidateId && mode !== "start") throw Error("A built candidate requires production start mode");
const hosts = nextArgs.flatMap((value, index) =>
    ["-H", "--hostname"].includes(value)
      ? [nextArgs[index + 1]]
      : value.startsWith("--hostname=")
        ? [value.slice("--hostname=".length)]
        : [],
  );
const localIdentity =
  process.env.FACTORY_PORTAL_ONLY !== "1" && process.env.WEB_AUTH_MODE === "local-service";
if (mode === "start" && localIdentity) throw Error("Production requires personal authentication");
if (mode === "start") {
  const preflight = spawnSync(process.execPath, [fileURLToPath(new URL("./check-web-env.mjs", import.meta.url)), "--production"], {
    cwd: workspace, env: process.env, stdio: "inherit", windowsHide: true,
  });
  if (preflight.status !== 0) throw Error("Web production preflight failed");
}
if (candidateId) webRoot = (await verifyLocalWebCandidate(workspace, candidateId)).web;
if (mode === "dev" && hosts.length === 0) nextArgs.push("--hostname", "127.0.0.1");
if (
  mode === "dev" &&
  localIdentity &&
  hosts.some((host) => !["localhost", "127.0.0.1", "::1"].includes(host))
)
  throw Error("Local service identity must bind to loopback");
const studioServer = mode === "dev" ? await startCanvasRuntime() : null;
const child = spawn(process.execPath, [nextCli, mode, ...nextArgs], {
  cwd: webRoot,
  env: process.env,
  stdio: "inherit",
  windowsHide: true,
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    if (!child.killed) child.kill(signal);
  });
}

child.once("error", (error) => {
  process.stderr.write(`Could not start Next.js: ${error.message}\n`);
  process.exitCode = 1;
});

child.once("exit", (code, signal) => {
  studioServer?.close();
  if (signal) {
    process.stderr.write(`Next.js exited after receiving ${signal}.\n`);
    process.exitCode = 1;
    return;
  }
  process.exitCode = code ?? 1;
});
