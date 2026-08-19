import { spawn } from "node:child_process";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";

const mode = process.argv[2];
if (!["dev", "start"].includes(mode)) {
  process.stderr.write("Usage: start-web.mjs <dev|start> [...next arguments]\n");
  process.exit(1);
}

const nextCli = fileURLToPath(
  new URL("../../apps/web/node_modules/next/dist/bin/next", import.meta.url),
);
const webRoot = fileURLToPath(new URL("../../apps/web/", import.meta.url));
const child = spawn(process.execPath, [nextCli, mode, ...process.argv.slice(3)], {
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
  if (signal) {
    process.stderr.write(`Next.js exited after receiving ${signal}.\n`);
    process.exitCode = 1;
    return;
  }
  process.exitCode = code ?? 1;
});
