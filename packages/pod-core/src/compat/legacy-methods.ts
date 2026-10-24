import { harnessChecksum, HarnessContractError } from "@yummyai/ai-core";
import { CreatePodArtworkTaskInputSchema, PodExecutableToolKeySchema, type PodExecutableToolKey } from "@yummyai/contracts";
import { RegisteredAgentMethodSchema } from "@yummyai/contracts/harness/methods";
import type { HarnessExecutionContract } from "@yummyai/contracts/harness";
import { z } from "zod";
import archive from "./pod-methods-v1.json" with { type: "json" };

if (harnessChecksum(archive) !== "a963cfab68636988c417a6d5e4200b10d32dc875189e75a8c62995d680cff1d3")
  throw new Error("Archived POD method definitions changed; compatibility requires review");
const methods = RegisteredAgentMethodSchema.array().parse(archive.methods);
for (const method of methods) {
  const tool = PodExecutableToolKeySchema.parse(method.methodKey.replace("pod.artwork.", ""));
  const descriptor = method.tools[0]!, contract = method.executionContract;
  const body = { contractVersion: contract.contractVersion, executorKey: contract.executorKey, skill: contract.skill, tools: contract.tools };
  if (method.tools.length !== 1 || contract.tools.length !== 1 || contract.skill.version !== "pod-method-2026-10-18-v1"
    || harnessChecksum(body) !== contract.checksum || harnessChecksum(descriptor) !== contract.tools[0]!.checksum
    || harnessChecksum(archive.inputSchemas[tool]) !== descriptor.inputSchemaChecksum
    || harnessChecksum(archive.outputSchema) !== descriptor.outputSchemaChecksum
    || harnessChecksum({ key: method.methodKey, version: contract.skill.version, label: method.label, instructions: method.instructions, steps: method.steps, tools: contract.tools }) !== contract.skill.checksum)
    throw new Error("Archived POD method audit metadata is invalid");
}
/** Trusted compatibility metadata only; historical UI schemas never become current processing schemas. */
export function registeredLegacyPodMethods() {
  return structuredClone(methods.filter(method => {
    const tool = PodExecutableToolKeySchema.parse(method.methodKey.replace("pod.artwork.", ""));
    return harnessChecksum(z.toJSONSchema(CreatePodArtworkTaskInputSchema.safeExtend({ toolKey: z.literal(tool) }))) === method.tools[0]!.inputSchemaChecksum;
  }));
}
export function legacyPodMethod(tool: PodExecutableToolKey, contract: HarnessExecutionContract) {
  const method = registeredLegacyPodMethods().find(value => value.methodKey === `pod.artwork.${tool}` && harnessChecksum(value.executionContract) === harnessChecksum(contract));
  if (!method) throw new HarnessContractError("harness_contract_changed");
  return method;
}
