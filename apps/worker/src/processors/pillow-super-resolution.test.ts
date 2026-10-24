import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as OrderDesignModule from "@yummyai/order-design";
import { OrderDesignError, PILLOW_REALESRGAN_FILES, PILLOW_REALESRGAN_POLICY,
  resolvePillowSuperResolutionRuntime, verifyPillowRuntimeFiles } from "@yummyai/order-design";
import sharp from "sharp";
import { extendTransparentRgb, LocalPillowSuperResolutionGateway } from "./pillow-super-resolution.js";
import type { PillowUpscaleProcessInput } from "./pillow-super-resolution-process.js";

vi.mock("@yummyai/order-design", async importOriginal => ({
  ...await importOriginal<typeof OrderDesignModule>(),
  resolvePillowSuperResolutionRuntime: vi.fn(), verifyPillowRuntimeFiles: vi.fn(),
}));

describe("local pillow model gateway", () => {
  let root: string, runtime: string, jobs: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "pillow-adapter-test-"));
    runtime = join(root, "runtime"); jobs = join(root, "jobs");
    for (const file of PILLOW_REALESRGAN_FILES) {
      const path = join(runtime, file.name);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, "synthetic-runtime-fixture-never-executed");
    }
    vi.mocked(resolvePillowSuperResolutionRuntime).mockResolvedValue({ directory: runtime, policy: { ...PILLOW_REALESRGAN_POLICY } });
    vi.mocked(verifyPillowRuntimeFiles).mockResolvedValue();
  });
  afterEach(async () => {
    vi.clearAllMocks();
    const target = resolve(root), base = resolve(tmpdir());
    if (!target.startsWith(`${base}${sep}pillow-adapter-test-`)) throw new Error("Unexpected fixture cleanup target");
    await rm(target, { recursive: true, force: true });
  });
  async function source() {
    const rgba = Buffer.alloc(16 * 12 * 4);
    for (let y = 3; y < 9; y++) for (let x = 4; x < 12; x++) {
      const index = (y * 16 + x) * 4;
      rgba[index] = 240; rgba[index + 1] = 140; rgba[index + 2] = 90;
      rgba[index + 3] = x === 4 ? 96 : 255;
    }
    return sharp(rgba, { raw: { width: 16, height: 12, channels: 4 } }).png().toBuffer();
  }
  // Only a transport test fixture: production is verified separately with actual model inference.
  async function fixtureProcess(input: PillowUpscaleProcessInput) {
    const original = input.args[input.args.indexOf("-i") + 1], output = input.args[input.args.indexOf("-o") + 1];
    await sharp(await readFile(original)).resize(64, 48, { kernel: "nearest" }).png().toFile(output);
  }

  it("preserves originals and source alpha, extends hidden RGB, pins arguments and removes job files", async () => {
    const bytes = await source(), original = Buffer.from(bytes);
    const runProcess = vi.fn(async (input: PillowUpscaleProcessInput) => {
      expect(input.cwd).toMatch(/yummyai-pillow-/);
      expect(input.executable).toBe(join(input.cwd, "realesrgan-ncnn-vulkan.exe"));
      expect(input.args.slice(-10)).toEqual(["-n", "realesrgan-x4plus", "-s", "4", "-t", "256", "-j", "1:1:1", "-f", "png"]);
      const raw = await sharp(await readFile(input.args[1])).raw().toBuffer();
      for (let index = 0; index < raw.length; index += 3) expect([...raw.subarray(index, index + 3)]).toEqual([240, 140, 90]);
      await fixtureProcess(input);
    });
    const gateway = new LocalPillowSuperResolutionGateway({ tempRoot: jobs, runProcess });
    const output = await gateway.upscale({ bytes, policy: { ...PILLOW_REALESRGAN_POLICY } });
    expect(bytes.equals(original)).toBe(true);
    expect(output.evidence.output).toMatchObject({ width: 64, height: 48, hasAlpha: true });
    expect(JSON.stringify(output.evidence)).not.toContain(root);
    const actualAlpha = await sharp(output.bytes).extractChannel("alpha").raw().toBuffer();
    const expectedAlpha = await sharp(bytes).extractChannel("alpha").resize(64, 48, { kernel: "lanczos3", fit: "fill" }).toColourspace("b-w").raw().toBuffer();
    expect(actualAlpha.equals(expectedAlpha)).toBe(true);
    const rgb = await sharp(output.bytes).removeAlpha().raw().toBuffer();
    expect(rgb[0]).toBe(240);
    expect(await readdir(jobs)).toEqual([]);
    expect(verifyPillowRuntimeFiles).toHaveBeenCalledOnce();
  });

  it("fails before inference when snapshot checksums drift or a model name is outside the allowlist", async () => {
    const runProcess = vi.fn(fixtureProcess), bytes = await source();
    const gateway = new LocalPillowSuperResolutionGateway({ tempRoot: jobs, runProcess });
    await expect(gateway.validatePolicy({ ...PILLOW_REALESRGAN_POLICY, binarySha256: "a".repeat(64) }))
      .rejects.toMatchObject({ code: "agent_upscale_runtime_changed" });
    await expect(gateway.upscale({ bytes, policy: { ...PILLOW_REALESRGAN_POLICY, model: "../other" as never } }))
      .rejects.toMatchObject({ code: "agent_upscale_policy_unsupported" });
    expect(runProcess).not.toHaveBeenCalled();
  });

  it("rejects opaque input, excessive dimensions, empty alpha, and malformed outputs", async () => {
    const runProcess = vi.fn(fixtureProcess);
    const gateway = new LocalPillowSuperResolutionGateway({ tempRoot: jobs, runProcess });
    const policy = { ...PILLOW_REALESRGAN_POLICY };
    const opaque = await sharp({ create: { width: 16, height: 12, channels: 3, background: "white" } }).png().toBuffer();
    await expect(gateway.upscale({ bytes: opaque, policy })).rejects.toMatchObject({ code: "agent_upscale_input_invalid" });
    const wide = await sharp({ create: { width: 2049, height: 1, channels: 4, background: "transparent" } }).png().toBuffer();
    await expect(gateway.upscale({ bytes: wide, policy })).rejects.toMatchObject({ code: "agent_upscale_input_invalid" });
    const empty = await sharp({ create: { width: 16, height: 12, channels: 4, background: "transparent" } }).png().toBuffer();
    await expect(gateway.upscale({ bytes: empty, policy })).rejects.toMatchObject({ code: "agent_upscale_alpha_empty" });
    expect(runProcess).not.toHaveBeenCalled();
    const malformed = new LocalPillowSuperResolutionGateway({ tempRoot: jobs, runProcess: async input => {
      await sharp(opaque).png().toFile(input.args[input.args.indexOf("-o") + 1]);
    } });
    await expect(malformed.upscale({ bytes: await source(), policy })).rejects.toMatchObject({ code: "agent_upscale_output_invalid" });
    expect(await readdir(jobs)).toEqual([]);
  });

  it("cleans all private files and reports safe errors when the native tool fails", async () => {
    const gateway = new LocalPillowSuperResolutionGateway({ tempRoot: jobs, runProcess: async () => {
      throw new Error(`synthetic sensitive path ${root}`);
    } });
    await expect(gateway.upscale({ bytes: await source(), policy: { ...PILLOW_REALESRGAN_POLICY } }))
      .rejects.toEqual(new OrderDesignError("agent_upscale_execution_failed"));
    expect(await readdir(jobs)).toEqual([]);
  });

  it("shares one inference slot between instances and cancels queued jobs without starting them", async () => {
    let started!: () => void, unblock!: () => void;
    const entered = new Promise<void>(resolveStarted => { started = resolveStarted; });
    const pending = new Promise<void>(resolvePending => { unblock = resolvePending; });
    const firstRunner = vi.fn(async (input: PillowUpscaleProcessInput) => { started(); await pending; await fixtureProcess(input); });
    const nextRunner = vi.fn(fixtureProcess), bytes = await source(), policy = { ...PILLOW_REALESRGAN_POLICY };
    const first = new LocalPillowSuperResolutionGateway({ tempRoot: jobs, runProcess: firstRunner }).upscale({ bytes, policy });
    await entered;
    try {
      const controller = new AbortController();
      const second = new LocalPillowSuperResolutionGateway({ tempRoot: jobs, runProcess: nextRunner })
        .upscale({ bytes, policy, signal: controller.signal });
      controller.abort();
      await expect(second).rejects.toMatchObject({ code: "agent_upscale_cancelled" });
      expect(nextRunner).not.toHaveBeenCalled();
    } finally { unblock(); await first; }
    expect(await readdir(jobs)).toEqual([]);
  });
});

it("never edits alpha or visible RGB during deterministic hidden-color extension", () => {
  const source = Buffer.from([255, 0, 0, 255, 99, 99, 99, 0, 0, 0, 255, 128]);
  const original = Buffer.from(source), result = extendTransparentRgb(source, 3, 1);
  expect(source.equals(original)).toBe(true);
  expect([...result.alpha]).toEqual([255, 0, 128]);
  expect([...result.rgb]).toEqual([255, 0, 0, 255, 0, 0, 0, 0, 255]);
});
