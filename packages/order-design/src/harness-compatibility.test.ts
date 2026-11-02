import { describe, expect, it } from "vitest";
import { harnessChecksum } from "@yummyai/ai-core";
import { createEntityId } from "@yummyai/contracts";
import {
  OrderDesignMethodSnapshotSchema,
  OrderDesignPinnedPlanHarnessInputV1Schema,
} from "@yummyai/contracts/order/design-harness";
import {
  createPillowPipeline,
  DesignAutomationRecipeSchema,
} from "@yummyai/contracts/pod/design-automation";
import { buildDesignAutomationPlan } from "@yummyai/production-editor/design-automation";
import { orderDesignHarness, orderDesignHarnessForMethod } from "./harness.js";
import { buildOrderDesignRevisionPlan } from "./revision-plan.js";
import type { OrderDesignSnapshot } from "./types.js";

// Captured by importing the actual adopted schema-193 snapshot at commit
// 13e4fed366e62bd5d2f8053f64aee36b8bfc6625. Its contracts and ai-core imports
// were verified to resolve inside that snapshot. Do not regenerate these pins
// from the implementation under test or depend on a local snapshot at test time.
const inputChecksum = "b022648f90f869ad37f22a9b9817cb6a0894c800f5b84f0a1600940da193e823";
const outputChecksum = "70dd96721f41222931f1c1622494e3f61e7317c3c53359ce8ec7b0f5c91f52a3";
const originalMethods = [
  {
    workflow: "template", interpreted: false,
    skillChecksum: "cb79198d0178c0b5c4e02df5b0d7b4ff9026d7e3fd1a9badbafd641a9c6484ef",
    toolChecksum: "7acdfead2f0889877328869aea4a2cce8a10dc31744377c32c571f7ff7ad4f5e",
    checksum: "c031ef2c89790b15d93d6fc5a59071dda54dec7acbed55ab3745baf2194be4b6",
  },
  {
    workflow: "template", interpreted: true,
    skillChecksum: "3e305b4ebcd562b79ace6bdb8413ec0b06ef00bc8ec4fdc5982769f1287d08ca",
    toolChecksum: "a0fe0b542982e1b8c9d8cb431e97ae45f317eff5f97ffea2feb2f9478d212026",
    checksum: "283430785db44087a9ab3cd4b2f607390e298764da4e2830845abe51b487bfca",
  },
  {
    workflow: "pillow_photo", interpreted: false,
    skillChecksum: "c3a2270ebfa3136da7b68edc0232b3bae94eb6d90a4ba82f701933a263acbeb6",
    toolChecksum: "254da2f743a9629cdfb444f2b6f022234ead542e3074d8ed6790fba65139a889",
    checksum: "9af17d6067cc28bc8318070c258e417016d977daee35e0662b8cb00834bcdf63",
  },
  {
    workflow: "pillow_photo", interpreted: true,
    skillChecksum: "b493633c70afa527677b7f885c297ad492bce5d4e081ab744d47ffa6083838cb",
    toolChecksum: "ac242a2df97a898630dbb855e2d2d92fc432423c3acf948e3fd2a40f97e40a15",
    checksum: "82bbd13bdab9cfe42734798e4a0e849e705fff9f3eaf520a91b74d131102e3e4",
  },
] as const;

function originalContract(method: typeof originalMethods[number]) {
  const version = method.interpreted
    ? "order-design-method-2026-10-27-v2" : "order-design-method-2026-10-18-v1";
  return {
    contractVersion: "native-harness-v1" as const,
    executorKey: "order_design",
    skill: { key: `order.design.${method.workflow}`, version, checksum: method.skillChecksum },
    tools: [{ key: `order_design.${method.workflow}`, version, checksum: method.toolChecksum }],
    checksum: method.checksum,
  };
}

function originalInput(workflow: "template" | "pillow_photo") {
  const recipe = DesignAutomationRecipeSchema.parse({
    schemaVersion: 1, workflow, imagePolicy: "preserve", modelRouteId: null,
    allowOrderImageTransfer: false, modelCallLimit: 0,
    estimatedCostPerCallUsd: null, maxEstimatedCostUsd: null,
  });
  return {
    workItemId: createEntityId(), workRevisionId: createEntityId(), sourceVersionId: null,
    templateVersionId: createEntityId(), templateChecksum: "a".repeat(64),
    businessSnapshotChecksum: "b".repeat(64), workflow, recipe,
    plan: buildDesignAutomationPlan({ recipe, imageIds: [createEntityId()],
      ...(workflow === "pillow_photo" ? { pillowSubject: "head" as const } : {}),
    }),
  };
}

function revisionInput(mode: "image_edit" | "contour_only") {
  const input = originalInput("pillow_photo"), hash = "c".repeat(64);
  const recipe = DesignAutomationRecipeSchema.parse({
    schemaVersion: 1, workflow: "pillow_photo", imagePolicy: "faithful_enhancement",
    modelRouteId: createEntityId(), allowOrderImageTransfer: true, modelCallLimit: 2,
    estimatedCostPerCallUsd: 0.04, maxEstimatedCostUsd: 0.2,
    pillowPipeline: createPillowPipeline({
      engine: "realesrgan-ncnn-vulkan", release: "20220424", model: "realesrgan-x4plus",
      scale: 4, tileSize: 256, threads: "1:1:1",
      alphaStrategy: "source-alpha-lanczos3-rgb-nearest-fill-v1",
      binarySha256: hash, modelBinSha256: hash, modelParamSha256: hash,
    }),
  });
  const snapshot = { recipe, plan: { budget: { estimatedCostPerCallUsd: 0.04 } } } as OrderDesignSnapshot;
  return { ...input, recipe, plan: buildOrderDesignRevisionPlan(snapshot, createEntityId(), mode) };
}

describe("adopted schema-193 order-design execution compatibility", () => {
  it.each(originalMethods)("preserves $workflow interpreted=$interpreted original pins and input boundary", method => {
    const expected = originalContract(method);
    const bundle = orderDesignHarness(method.workflow, method.interpreted);
    const descriptor = bundle.registry.describeSkill(bundle.skill);
    expect(descriptor.executionContract).toEqual(expected);
    expect(descriptor.tools[0]!.inputSchemaChecksum).toBe(inputChecksum);
    expect(descriptor.tools[0]!.outputSchemaChecksum).toBe(outputChecksum);
    expect(bundle.registry.assertCurrent(expected, bundle.skill)).toEqual(expected);

    const input = originalInput(method.workflow);
    expect(() => bundle.registry.checkInput(expected, bundle.skill, bundle.toolKey, input)).not.toThrow();
    expect(() => bundle.registry.checkInput(expected, bundle.skill, bundle.toolKey, {
      ...input, plan: { ...input.plan, kind: "candidate_revision" },
    })).toThrow("harness_tool_input_invalid");

    const snapshot = { recipe: input.recipe, plan: input.plan } as OrderDesignSnapshot;
    const pinnedMethod = OrderDesignMethodSnapshotSchema.parse({
      schemaVersion: "order-design-method-snapshot-v1", executionContract: expected,
      methodSelection: { schemaVersion: "agent-method-selection-v1", mode: "builtin",
        methodKey: expected.skill.key, contractChecksum: expected.checksum, withdrawalGeneration: 0 },
    });
    expect(orderDesignHarnessForMethod(snapshot, pinnedMethod).skill).toEqual(bundle.skill);
  });

  it("keeps the complete frozen input JSON schema at its actual schema-193 checksum", () => {
    expect(harnessChecksum(OrderDesignPinnedPlanHarnessInputV1Schema.toJSONSchema())).toBe(inputChecksum);
  });

  it.each(["image_edit", "contour_only"] as const)("admits %s only through the separate revision identity", mode => {
    const input = revisionInput(mode), revision = orderDesignHarness("pillow_photo", true, true);
    const contract = revision.registry.pin(revision.skill);
    expect(input.plan.status).toBe("ready");
    expect(() => revision.registry.checkInput(contract, revision.skill, revision.toolKey, input)).not.toThrow();
    expect(OrderDesignPinnedPlanHarnessInputV1Schema.safeParse(input).success).toBe(false);
    const withoutKind = { ...input.plan };
    delete withoutKind.kind;
    for (const method of originalMethods.filter(value => value.workflow === "pillow_photo")) {
      const bundle = orderDesignHarness(method.workflow, method.interpreted), expected = originalContract(method);
      expect(() => bundle.registry.checkInput(expected, bundle.skill, bundle.toolKey, input)).toThrow("harness_tool_input_invalid");
      expect(() => bundle.registry.checkInput(expected, bundle.skill, bundle.toolKey, { ...input, plan: withoutKind }))
        .toThrow("harness_tool_input_invalid");
      expect(() => bundle.registry.assertCurrent(contract, bundle.skill)).toThrow("harness_contract_changed");
    }
  });

  it("continues rejecting changed historical contracts instead of relaxing assertCurrent", () => {
    for (const method of originalMethods) {
      const bundle = orderDesignHarness(method.workflow, method.interpreted), expected = originalContract(method);
      expect(() => bundle.registry.assertCurrent({ ...expected, checksum: "0".repeat(64) }, bundle.skill))
        .toThrow("harness_contract_changed");
    }
  });
});
