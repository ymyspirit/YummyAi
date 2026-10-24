import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { LangChainTracer } from "@langchain/core/tracers/tracer_langchain";
import { Client } from "langsmith/client";
import { RunTree } from "langsmith/run_trees";
import { withRunTree } from "langsmith/traceable";
import type { ShapedPillowDocument } from "@yummyai/contracts/pod/production-editor";
import {
  createPillowAutomationGeometry, recomputePillowAutomationGeometry,
  type PillowAutomationGeometryOptions, type PillowAutomationGeometryResult,
} from "@yummyai/production-editor/pillow-automation-geometry";
import type { PillowSubjectRaster } from "@yummyai/production-editor/pillow-subject";

// Only non-sensitive control state enters LangGraph. Pixels, documents, asset
// identifiers and manufacturing results remain in this invocation's closure.
const ControlState = Annotation.Root({ attemptIndex: Annotation<number>(), passed: Annotation<boolean>() });
const roundingSequence = [20, 25, 30] as const;
export type PillowContourAttempt = { roundingPx: number; qa: PillowAutomationGeometryResult["qa"] };

/** A bounded, deterministic subroutine of one existing durable order step.
 * No checkpointer, interrupt, tools, model calls, writes or graph retry policy.
 * The owning processor still handles claims, cancellation and durable recovery.
 */
export async function runPillowContourWorkflow(input: {
  document: ShapedPillowDocument;
  raster: PillowSubjectRaster;
  options: Pick<PillowAutomationGeometryOptions, "artworkLayerId" | "longestSideInches">;
  assertActive: () => Promise<void>;
  signal?: AbortSignal;
}): Promise<{ result: PillowAutomationGeometryResult; attempts: PillowContourAttempt[] }> {
  let result: PillowAutomationGeometryResult | undefined;
  const attempts: PillowContourAttempt[] = [];
  const assertActive = async () => {
    input.signal?.throwIfAborted();
    await input.assertActive();
    input.signal?.throwIfAborted();
  };
  const graph = new StateGraph(ControlState)
    .addNode("calculate_contour", async (state) => {
      await assertActive();
      const roundingPx = roundingSequence[state.attemptIndex];
      if (roundingPx === undefined) throw new Error("agent_contour_attempt_invalid");
      result = state.attemptIndex === 0
        ? createPillowAutomationGeometry(input.document, input.raster, { ...input.options, roundingPx })
        : recomputePillowAutomationGeometry(result!.document, input.raster, { ...input.options, roundingPx });
      attempts.push({ roundingPx, qa: result.qa });
      return {};
    })
    .addNode("check_contour", () => ({ passed: result!.qa.technicalPassed }))
    .addNode("select_correction", state => ({ attemptIndex: state.attemptIndex + 1 }))
    .addEdge(START, "calculate_contour")
    .addEdge("calculate_contour", "check_contour")
    .addConditionalEdges("check_contour", state => state.passed || state.attemptIndex === roundingSequence.length - 1 ? END : "select_correction")
    .addEdge("select_correction", "calculate_contour")
    .compile();
  // Core 1.2.11's stream wrapper drops a tracingEnabled:false placeholder.
  // An explicit zero-sampling client survives that callback handoff and drops
  // every event before serialization, batching or network/OTEL export. A fresh
  // root prevents inheriting another workload's client, without changing env.
  const localClient = new Client({ tracingSamplingRate: 0, tracingMode: "langsmith", debug: false });
  const localRoot = new RunTree({ name: "pillow-contour-local", client: localClient, tracingEnabled: true });
  await withRunTree(localRoot, () => graph.invoke({ attemptIndex: 0, passed: false },
    { signal: input.signal, recursionLimit: 12, callbacks: [new LangChainTracer({ client: localClient })] }));
  await assertActive();
  if (!result) throw new Error("agent_contour_result_missing");
  return { result, attempts };
}
