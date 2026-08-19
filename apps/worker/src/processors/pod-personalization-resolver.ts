import type { TemplateMappingSnapshot, TemplateSlot } from "@yummyai/contracts";

export type ResolvedTemplateSlot =
  | { slotId: string; stableKey: string; kind: "text"; value: string }
  | {
    slotId: string;
    stableKey: string;
    kind: "image" | "decoration" | "background";
    assetId: string;
    assetVersion: number;
    checksumSha256: string;
    mediaType: string;
  };

export class InvalidTemplateSlotMappingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidTemplateSlotMappingError";
  }
}

export function resolveTemplateSlots(input: {
  slots: readonly TemplateSlot[];
  mapping: TemplateMappingSnapshot;
  values: Readonly<Record<string, string | string[]>>;
  files: ReadonlyArray<{
    fieldKey: string;
    assetId: string;
    assetVersion: number;
    checksumSha256: string;
    mediaType: string;
  }>;
}): ResolvedTemplateSlot[] {
  const reuseGroups = new Map<string, string>();
  const fieldOwners = new Map<string, string>();
  const fileByField = new Map(input.files.map((file) => [file.fieldKey, file]));

  return input.slots.filter((slot) => slot.replaceable).map((slot) => {
    const fieldKey = input.mapping.slotFieldMap[slot.stableKey];
    if (!fieldKey) throw new InvalidTemplateSlotMappingError(`Replaceable slot ${slot.stableKey} is not mapped`);
    const group = slot.reuseLabel ?? slot.stableKey;
    const groupField = reuseGroups.get(group);
    if (groupField && groupField !== fieldKey) {
      throw new InvalidTemplateSlotMappingError(`Slots sharing reuse label ${group} must use the same customer field`);
    }
    reuseGroups.set(group, fieldKey);
    const owner = fieldOwners.get(fieldKey);
    if (owner && owner !== group) {
      throw new InvalidTemplateSlotMappingError(`Independent slot groups ${owner} and ${group} cannot silently reuse one customer field`);
    }
    fieldOwners.set(fieldKey, group);

    if (slot.kind === "text") {
      const raw = input.values[fieldKey];
      if (raw === undefined) throw new InvalidTemplateSlotMappingError(`Text field ${fieldKey} is missing`);
      return {
        slotId: slot.id,
        stableKey: slot.stableKey,
        kind: "text" as const,
        value: Array.isArray(raw) ? raw.join(", ") : raw,
      };
    }

    const asset = fileByField.get(fieldKey);
    if (!asset) throw new InvalidTemplateSlotMappingError(`Customer file field ${fieldKey} is missing or not promoted`);
    return {
      slotId: slot.id,
      stableKey: slot.stableKey,
      kind: slot.kind,
      assetId: asset.assetId,
      assetVersion: asset.assetVersion,
      checksumSha256: asset.checksumSha256,
      mediaType: asset.mediaType,
    };
  });
}
