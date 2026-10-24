import { createHash } from "node:crypto";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Client } from "langsmith/client";
import { RunTree } from "langsmith/run_trees";
import { withRunTree } from "langsmith/traceable";
import type { ShapedPillowDocument } from "@yummyai/contracts/pod/production-editor";
import { createDefaultProductionDocument } from "@yummyai/production-editor/products";
import * as geometry from "@yummyai/production-editor/pillow-automation-geometry";
import type { PillowSubjectRaster } from "@yummyai/production-editor/pillow-subject";
import { runPillowContourWorkflow } from "./pillow-contour-workflow.js";

const options = { artworkLayerId: "photo", longestSideInches: 10 };
const createGeometry = geometry.createPillowAutomationGeometry;
const recomputeGeometry = geometry.recomputePillowAutomationGeometry;
type GeometryResult = geometry.PillowAutomationGeometryResult;

function document(): ShapedPillowDocument {
  const value = createDefaultProductionDocument("shaped_pillow") as ShapedPillowDocument;
  value.layers = [{ kind: "image", id: "photo", name: "Synthetic regression fixture", assetId: "019f0000-0000-7000-8000-000000000001", assetVersion: 3, xMm: 30, yMm: 30, widthMm: 220, heightMm: 220, rotationDeg: 0, flipX: false, flipY: false, opacity: 1, visible: true, locked: false }];
  return value;
}

// Fixed synthetic subjects, never real customer pictures. The thin extension
// exercises a full-body detail while the alpha31 residue must remain untouched.
function raster(kind: "cat" | "person" | "thin", size = 1800) {
  const alpha = new Uint8Array(size * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const u = x / size, v = y / size;
    const ellipse = (cx: number, cy: number, rx: number, ry: number) => ((u - cx) / rx) ** 2 + ((v - cy) / ry) ** 2 <= 1;
    const body = kind === "cat"
      ? ellipse(0.5, 0.55, 0.4, 0.36) || (v > 0.09 && v < 0.42 && Math.abs(u - 0.22) < (v - 0.09) * 0.55) || (v > 0.09 && v < 0.42 && Math.abs(u - 0.78) < (v - 0.09) * 0.55)
      : ellipse(0.5, 0.18, 0.15, 0.14) || ellipse(0.5, 0.48, 0.19, 0.24) || ellipse(0.32, 0.5, 0.1, 0.21) || ellipse(0.68, 0.5, 0.1, 0.21) || ellipse(0.4, 0.79, 0.095, 0.17) || ellipse(0.6, 0.79, 0.095, 0.17);
    if (body || (kind === "thin" && v > 0.4 && v < 0.44 && u > 0.12 && u < 0.32)) alpha[y * size + x] = 255;
  }
  alpha[0] = 31;
  return { width: size, height: size, alpha };
}

function hash(value: string | Uint8Array) { return createHash("sha256").update(value).digest("hex"); }

// Frozen reference of the executor's pre-graph loop. Keep literal rounding
// values here so changing the graph's sequence cannot silently change this oracle.
function legacyLoop(value: ShapedPillowDocument, pixels: PillowSubjectRaster) {
  let result = createGeometry(value, pixels, { ...options, roundingPx: 20 });
  const attempts = [{ roundingPx: 20, qa: result.qa }];
  for (const roundingPx of [25, 30]) {
    if (result.qa.technicalPassed) break;
    result = recomputeGeometry(result.document, pixels, { ...options, roundingPx });
    attempts.push({ roundingPx, qa: result.qa });
  }
  return { result, attempts };
}

let seed: GeometryResult;
beforeAll(() => { seed = createGeometry(document(), raster("cat"), options); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

function controlledResult(roundingPx: number, passed: boolean): GeometryResult {
  const result = structuredClone(seed);
  result.qa.technicalPassed = passed;
  result.qa.geometry.roundingPx = roundingPx;
  result.qa.checks = [{ code: "synthetic_contour_check", status: passed ? "passed" : "failed" }, { code: "pillow_visual_review", status: "manual" }];
  result.diagnostics = passed ? ["pillow_visual_review_required"] : ["synthetic_contour_check_failed", "pillow_visual_review_required"];
  return result;
}

describe("bounded pillow contour LangGraph subroutine", () => {
  it.each(["cat", "person", "thin"] as const)("matches the legacy %s result and preserves the original document and pixel hashes", async kind => {
    const value = document(), pixels = raster(kind);
    const documentHash = hash(JSON.stringify(value)), pixelHash = hash(pixels.alpha);
    const expected = legacyLoop(value, pixels);
    const actual = await runPillowContourWorkflow({ document: value, raster: pixels, options, assertActive: async () => {} });
    expect(actual).toEqual(expected);
    expect(actual.result.qa.technicalPassed).toBe(true);
    expect(actual.result.qa.manualReviewRequired).toBe(true);
    expect(actual.result.document.confirmations).toEqual({ physicalSize: false, whiteBorderRule: false, narrowParts: false, barcodeTab: false, backText: false, visualReview: false });
    expect(actual.result.document.layers[0]).toMatchObject({ assetId: value.layers[0]!.kind === "image" && value.layers[0]!.assetId, assetVersion: 3, locked: true });
    expect(hash(JSON.stringify(value))).toBe(documentHash);
    expect(hash(pixels.alpha)).toBe(pixelHash);
  }, 15_000);

  it("retains actual resolution failure after all allowed corrections without granting approval", async () => {
    const value = document(), pixels = raster("person", 800);
    const documentHash = hash(JSON.stringify(value)), pixelHash = hash(pixels.alpha);
    const actual = await runPillowContourWorkflow({ document: value, raster: pixels, options, assertActive: async () => {} });
    expect(actual).toEqual(legacyLoop(value, pixels));
    expect(actual.attempts.map(attempt => attempt.roundingPx)).toEqual([20, 25, 30]);
    expect(actual.attempts.every(attempt => !attempt.qa.technicalPassed)).toBe(true);
    expect(actual.result.qa.checks).toContainEqual({ code: "pillow_actual_subject_resolution", status: "failed" });
    expect(actual.result.document.confirmations.visualReview).toBe(false);
    expect(hash(JSON.stringify(value))).toBe(documentHash);
    expect(hash(pixels.alpha)).toBe(pixelHash);
  }, 15_000);

  it.each([20, 25, 30] as const)("stops as soon as the %s px attempt passes and reuses the preceding locked document", async passingRound => {
    const results = [20, 25, 30].map(round => controlledResult(round, round === passingRound));
    const create = vi.spyOn(geometry, "createPillowAutomationGeometry").mockReturnValue(results[0]!);
    const recompute = vi.spyOn(geometry, "recomputePillowAutomationGeometry")
      .mockReturnValueOnce(results[1]!).mockReturnValueOnce(results[2]!);
    const value = document(), pixels = raster("cat", 8);
    const actual = await runPillowContourWorkflow({ document: value, raster: pixels, options, assertActive: async () => {} });
    const attemptCount = [20, 25, 30].indexOf(passingRound) + 1;
    expect(create).toHaveBeenCalledExactlyOnceWith(value, pixels, { ...options, roundingPx: 20 });
    expect(recompute).toHaveBeenCalledTimes(attemptCount - 1);
    if (attemptCount > 1) expect(recompute).toHaveBeenNthCalledWith(1, results[0]!.document, pixels, { ...options, roundingPx: 25 });
    if (attemptCount > 2) expect(recompute).toHaveBeenNthCalledWith(2, results[1]!.document, pixels, { ...options, roundingPx: 30 });
    expect(actual.attempts).toEqual(results.slice(0, attemptCount).map(result => ({ roundingPx: result.qa.geometry.roundingPx, qa: result.qa })));
    expect(actual.result).toEqual(results[attemptCount - 1]);
  });

  it("does not start geometry for a pre-aborted task", async () => {
    const create = vi.spyOn(geometry, "createPillowAutomationGeometry"), recompute = vi.spyOn(geometry, "recomputePillowAutomationGeometry");
    const controller = new AbortController();
    controller.abort(new Error("synthetic cancellation"));
    await expect(runPillowContourWorkflow({ document: document(), raster: raster("cat", 8), options, assertActive: async () => {}, signal: controller.signal })).rejects.toThrow();
    expect(create).not.toHaveBeenCalled();
    expect(recompute).not.toHaveBeenCalled();
  });

  it("stops before another correction when cancellation arrives after the first calculation", async () => {
    const controller = new AbortController();
    const create = vi.spyOn(geometry, "createPillowAutomationGeometry").mockImplementation(() => { controller.abort(new Error("synthetic cancellation")); return controlledResult(20, false); });
    const recompute = vi.spyOn(geometry, "recomputePillowAutomationGeometry");
    await expect(runPillowContourWorkflow({ document: document(), raster: raster("cat", 8), options, assertActive: async () => {}, signal: controller.signal })).rejects.toThrow();
    expect(create).toHaveBeenCalledOnce();
    expect(recompute).not.toHaveBeenCalled();
  });

  it("does not calculate or retry when the initial ownership check fails", async () => {
    const create = vi.spyOn(geometry, "createPillowAutomationGeometry"), recompute = vi.spyOn(geometry, "recomputePillowAutomationGeometry");
    const ownershipLost = new Error("synthetic ownership lost");
    const assertActive = vi.fn(async () => { throw ownershipLost; });
    await expect(runPillowContourWorkflow({ document: document(), raster: raster("cat", 8), options, assertActive })).rejects.toThrow("synthetic ownership lost");
    expect(assertActive).toHaveBeenCalledOnce();
    expect(create).not.toHaveBeenCalled();
    expect(recompute).not.toHaveBeenCalled();
  });

  it.each([false, true])("rejects a stale owner after calculation even when technicalPassed is %s", async passed => {
    let active = true;
    const create = vi.spyOn(geometry, "createPillowAutomationGeometry").mockImplementation(() => { active = false; return controlledResult(20, passed); });
    const recompute = vi.spyOn(geometry, "recomputePillowAutomationGeometry");
    const assertActive = async () => { if (!active) throw new Error("synthetic ownership lost"); };
    await expect(runPillowContourWorkflow({ document: document(), raster: raster("cat", 8), options, assertActive })).rejects.toThrow("synthetic ownership lost");
    expect(create).toHaveBeenCalledOnce();
    expect(recompute).not.toHaveBeenCalled();
  });

  it("does not retry an unexpected calculation error", async () => {
    const create = vi.spyOn(geometry, "createPillowAutomationGeometry").mockImplementation(() => { throw new Error("synthetic geometry error"); });
    const recompute = vi.spyOn(geometry, "recomputePillowAutomationGeometry");
    await expect(runPillowContourWorkflow({ document: document(), raster: raster("cat", 8), options, assertActive: async () => {} })).rejects.toThrow("synthetic geometry error");
    expect(create).toHaveBeenCalledOnce();
    expect(recompute).not.toHaveBeenCalled();
  });

  it.each([false, true])("does not emit external tracing with host tracing enabled and an ambient parent: %s", async ambientParent => {
    vi.stubEnv("LANGSMITH_TRACING", "true");
    vi.stubEnv("LANGCHAIN_TRACING_V2", "true");
    vi.stubEnv("LANGCHAIN_TRACING", "true");
    vi.stubEnv("LANGSMITH_TRACING_SAMPLING_RATE", "1");
    vi.stubEnv("LANGSMITH_TRACING_MODE", "otel");
    vi.stubEnv("LANGCHAIN_CALLBACKS_BACKGROUND", "false");
    vi.stubEnv("LANGSMITH_API_KEY", "synthetic-tracing-key");
    // Prevent egress even if this regression fails. Preparation/queue assertions
    // detect a trace that would be sent later, while real sampling still runs.
    const fetch = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    // The pinned client's preparation and queue methods are private in its TS
    // declarations. Observe them only in this egress regression test.
    const clientInternals = Client.prototype as unknown as {
      prepareRunCreateOrUpdateInputs: (...args: unknown[]) => Promise<unknown>;
      processRunOperation: (...args: unknown[]) => Promise<void>;
    };
    const prepare = vi.spyOn(clientInternals, "prepareRunCreateOrUpdateInputs");
    const queue = vi.spyOn(clientInternals, "processRunOperation").mockResolvedValue(undefined);
    const batch = vi.spyOn(Client.prototype, "batchIngestRuns").mockResolvedValue(undefined);
    vi.spyOn(geometry, "createPillowAutomationGeometry").mockReturnValue(controlledResult(20, true));
    const invoke = () => runPillowContourWorkflow({ document: document(), raster: raster("cat", 8), options, assertActive: async () => {} });
    const parentClient = new Client({ tracingSamplingRate: 1, tracingMode: "langsmith" });
    const parentCreate = vi.spyOn(parentClient, "createRun").mockResolvedValue(undefined);
    const parentUpdate = vi.spyOn(parentClient, "updateRun").mockResolvedValue(undefined);
    const result = await (ambientParent ? withRunTree(new RunTree({ name: "unrelated-parent", client: parentClient, tracingEnabled: true }), invoke) : invoke());
    expect(result.result.qa.technicalPassed).toBe(true);
    expect(prepare).not.toHaveBeenCalled();
    expect(queue).not.toHaveBeenCalled();
    expect(batch).not.toHaveBeenCalled();
    expect(parentCreate).not.toHaveBeenCalled();
    expect(parentUpdate).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(process.env.LANGSMITH_TRACING).toBe("true");
    expect(process.env.LANGCHAIN_TRACING_V2).toBe("true");
    expect(process.env.LANGCHAIN_TRACING).toBe("true");
  });
});
