import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { expect, it } from "vitest";
import { inspectPillowSuperResolutionRuntime } from "./super-resolution-runtime.js";

it("does not expose host paths when runtime configuration is absent or files are invalid", async () => {
  expect(await inspectPillowSuperResolutionRuntime({ environment: { NODE_ENV: "production" }, platform: "win32" }))
    .toEqual({ available: false, upscale: null, reason: "agent_upscale_runtime_unconfigured" });
  expect(await inspectPillowSuperResolutionRuntime({ environment: {}, platform: "linux" }))
    .toEqual({ available: false, upscale: null, reason: "agent_upscale_platform_unsupported" });
  const directory = await mkdtemp(join(tmpdir(), "pillow-runtime-test-"));
  try {
    await writeFile(join(directory, "realesrgan-ncnn-vulkan.exe"), "untrusted-runtime-never-executed");
    const capability = await inspectPillowSuperResolutionRuntime({ directory, platform: "win32" });
    expect(capability).toEqual({ available: false, upscale: null, reason: "agent_upscale_runtime_integrity_failed" });
    expect(JSON.stringify(capability)).not.toContain(directory);
  } finally {
    assert(resolve(directory).startsWith(`${resolve(tmpdir())}${sep}pillow-runtime-test-`), "Unexpected cleanup target");
    await rm(directory, { recursive: true, force: true });
  }
});
import assert from "node:assert/strict";
