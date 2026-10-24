import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalJson } from "@yummyai/contracts/common/canonical-json";
import {
  HarnessExecutionContractSchema,
  HarnessToolDescriptorSchema,
  type HarnessExecutionContract,
  type HarnessReference,
  type HarnessToolDescriptor,
} from "@yummyai/contracts/harness";

export type HarnessToolDefinition = {
  descriptor: Omit<HarnessToolDescriptor, "inputSchemaChecksum" | "outputSchemaChecksum">;
  inputSchema: z.ZodType;
  outputSchema: z.ZodType;
};
export type HarnessSkillDefinition = {
  key: string;
  version: string;
  label: string;
  instructions: string;
  steps: readonly string[];
  tools: readonly { key: string; version: string }[];
};
export class HarnessContractError extends Error {
  constructor(readonly code: "harness_contract_missing" | "harness_contract_invalid" | "harness_contract_changed" | "harness_tool_unavailable" | "harness_tool_input_invalid" | "harness_tool_output_invalid") {
    super(code); this.name = "HarnessContractError";
  }
}
const identity = (ref: { key: string; version: string }) => `${ref.key}@${ref.version}`;
export function harnessChecksum(value: unknown) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

/** Code-owned registry. Data, prompts and method text cannot register executable tools. */
export class HarnessRegistry {
  private readonly tools = new Map<string, { definition: HarnessToolDefinition; descriptor: HarnessToolDescriptor; reference: HarnessReference }>();
  private readonly skills = new Map<string, { definition: HarnessSkillDefinition; reference: HarnessReference; tools: HarnessReference[] }>();
  constructor(private readonly executorKey: string, tools: readonly HarnessToolDefinition[], skills: readonly HarnessSkillDefinition[]) {
    for (const tool of tools) {
      const inputSchema = z.toJSONSchema(tool.inputSchema), outputSchema = z.toJSONSchema(tool.outputSchema);
      const descriptor = HarnessToolDescriptorSchema.parse({ ...tool.descriptor, inputSchemaChecksum: harnessChecksum(inputSchema), outputSchemaChecksum: harnessChecksum(outputSchema) });
      const id = identity(descriptor);
      if (this.tools.has(id)) throw new Error("Duplicate registered tool: " + id);
      const reference = { key: descriptor.key, version: descriptor.version, checksum: harnessChecksum(descriptor) };
      this.tools.set(id, { definition: { ...tool }, descriptor, reference });
    }
    for (const skill of skills) {
      const id = identity(skill);
      if (this.skills.has(id) || !skill.instructions || !skill.steps.length || !skill.tools.length || new Set(skill.tools.map(v => v.key)).size !== skill.tools.length) throw new Error("Invalid registered skill: " + id);
      const refs = skill.tools.map(tool => {
        const registered = this.tools.get(identity(tool));
        if (!registered) throw new Error("Skill references an unregistered tool");
        return registered.reference;
      }).sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
      const reference = { key: skill.key, version: skill.version, checksum: harnessChecksum({ ...skill, tools: refs }) };
      this.skills.set(id, { definition: structuredClone(skill), reference, tools: refs });
      this.pin({ key: skill.key, version: skill.version });
    }
  }
  pin(skill: { key: string; version: string }): HarnessExecutionContract {
    const registered = this.skills.get(identity(skill));
    if (!registered) throw new HarnessContractError("harness_tool_unavailable");
    const value = { contractVersion: "native-harness-v1" as const, executorKey: this.executorKey, skill: registered.reference, tools: registered.tools };
    return HarnessExecutionContractSchema.parse({ ...value, checksum: harnessChecksum(value) });
  }
  assertCurrent(raw: unknown, skill: { key: string; version: string }): HarnessExecutionContract {
    if (!raw) throw new HarnessContractError("harness_contract_missing");
    const parsed = HarnessExecutionContractSchema.safeParse(raw);
    if (!parsed.success) throw new HarnessContractError("harness_contract_invalid");
    if (harnessChecksum(parsed.data) !== harnessChecksum(this.pin(skill))) throw new HarnessContractError("harness_contract_changed");
    return parsed.data;
  }
  private resolve(raw: unknown, skill: { key: string; version: string }, toolKey: string) {
    const plan = this.assertCurrent(raw, skill), ref = plan.tools.find(tool => tool.key === toolKey);
    const tool = ref ? this.tools.get(identity(ref)) : undefined;
    if (!tool) throw new HarnessContractError("harness_tool_unavailable");
    return tool;
  }
  checkInput(raw: unknown, skill: { key: string; version: string }, toolKey: string, input: unknown): void {
    const tool = this.resolve(raw, skill, toolKey);
    try {
      if (Buffer.byteLength(JSON.stringify(input)) > tool.descriptor.maxInputBytes) throw new Error("limit");
      tool.definition.inputSchema.parse(input);
    } catch { throw new HarnessContractError("harness_tool_input_invalid"); }
  }
  checkOutput(raw: unknown, skill: { key: string; version: string }, toolKey: string, output: unknown): void {
    const tool = this.resolve(raw, skill, toolKey);
    try {
      if (Buffer.byteLength(JSON.stringify(output)) > tool.descriptor.maxOutputBytes) throw new Error("limit");
      tool.definition.outputSchema.parse(output);
    } catch { throw new HarnessContractError("harness_tool_output_invalid"); }
  }
  instructions(raw: unknown, skill: { key: string; version: string }): string {
    this.assertCurrent(raw, skill);
    return this.skills.get(identity(skill))!.definition.instructions;
  }
  describeSkill(skill: { key: string; version: string }) {
    const executionContract = this.pin(skill), registered = this.skills.get(identity(skill))!;
    return structuredClone({ methodKey: skill.key, label: registered.definition.label,
      instructions: registered.definition.instructions, steps: [...registered.definition.steps], executionContract,
      tools: executionContract.tools.map(ref => this.tools.get(identity(ref))!.descriptor) });
  }
  descriptor(raw: unknown, skill: { key: string; version: string }, toolKey: string): HarnessToolDescriptor {
    return structuredClone(this.resolve(raw, skill, toolKey).descriptor);
  }
}
