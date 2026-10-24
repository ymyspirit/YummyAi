import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { URL } from "node:url";

test("AGENTS.md mirrors the canonical CLAUDE.md", async () => {
  const root = new URL("../../", import.meta.url);
  const [claude, agents] = await Promise.all([
    readFile(new URL("CLAUDE.md", root), "utf8"),
    readFile(new URL("AGENTS.md", root), "utf8"),
  ]);

  assert.equal(agents, claude);
});

test("Turbo passes required server-side variables to development tasks", async () => {
  const root = new URL("../../", import.meta.url);
  const turbo = JSON.parse(await readFile(new URL("turbo.json", root), "utf8"));
  const devEnv = new Set(turbo.tasks?.dev?.env ?? []);

  for (const variable of [
    "API_ACCESS_TOKEN",
    "API_BASE_URL",
    "KNOWLEDGE_EVIDENCE_ENCRYPTION_KEY",
    "FINANCE_COMMAND_ENCRYPTION_KEY",
    "ADVERTISING_COMMAND_ENCRYPTION_KEY",
    "LOCALAPPDATA",
    "LOCAL_OIDC_CLIENT_ID",
    "LOCAL_OIDC_CLIENT_SECRET",
    "NODE_ENV",
    "OIDC_ISSUER",
    "OIDC_WEB_CLIENT_ID",
    "OIDC_WEB_REDIRECT_URI",
    "PILLOW_REALESRGAN_DIR",
  ]) {
    assert.equal(devEnv.has(variable), true, `${variable} must be available to development tasks`);
  }
  const globalEnv = new Set(turbo.globalPassThroughEnv ?? []);
  for (const variable of ["WORKER_QUEUES", "WORKER_SCHEDULERS"])
    assert.equal(globalEnv.has(variable), true, `${variable} must reach the selected Worker process`);
});

test("low-memory infrastructure override does not change the default stack", async () => {
  const root = new URL("../../", import.meta.url);
  const compose = await readFile(new URL("infra/docker-compose.yml", root), "utf8");
  const lowMemoryCompose = await readFile(new URL("infra/docker-compose.low-memory.yml", root), "utf8");

  assert.doesNotMatch(compose, /profiles:\s*\["(?:file-scanning|observability)"\]/);
  assert.match(lowMemoryCompose, /clamav:\s*[\s\S]*?profiles:\s*\["file-scanning"\]/);
  assert.match(lowMemoryCompose, /otel-collector:\s*[\s\S]*?profiles:\s*\["observability"\]/);
});
