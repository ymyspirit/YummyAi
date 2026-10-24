import {
  CreativeRequirementsSchema,
  type CreativeRequirements,
} from "@yummyai/contracts/catalog/artwork";
import type { AssistDirection, AssistMatch } from "@yummyai/contracts/ai/assist";
import {
  OrderWorkDraftSchema,
  type OrderWorkDetail,
  type OrderWorkDraft,
} from "@yummyai/contracts/order/workspace";
import type { DirectionField } from "./assist-panel";

export function adoptCreativeRequirements(
  current: CreativeRequirements,
  direction: AssistDirection,
  fields: DirectionField[],
): CreativeRequirements {
  const next = structuredClone(current);
  for (const key of fields)
    if (key !== "prompt" && key !== "negativePrompt" && key !== "customization")
      next[key] = direction.requirements[key];
  if (fields.includes("customization")) {
    next.mode = direction.requirements.mode;
    next.layout = [];
    next.customization = {
      version: 1,
      fields: direction.fields.map((f) => ({
        key: f.key,
        label: f.label,
        required: f.required,
        helpText: f.helpText,
        ...(f.type === "image"
          ? {
              type: "image" as const,
              validation: {
                allowedMediaTypes: ["image/png", "image/jpeg", "image/webp"] as (
                  "image/png" | "image/jpeg" | "image/webp"
                )[],
                maxFiles: 1,
                maxBytes: 20_000_000,
              },
            }
          : { type: f.type, validation: f.maxLength === null ? {} : { maxLength: f.maxLength } }),
      })),
    };
  }
  return CreativeRequirementsSchema.parse(next);
}
export function adoptOrderMatch(
  current: OrderWorkDraft,
  detail: OrderWorkDetail,
  match: AssistMatch,
): OrderWorkDraft {
  const art = detail.catalog?.artworks.find((a) => a.id === match.artworkVersionId),
    spec = detail.catalog?.specifications.find((s) => s.id === match.specificationVersionId);
  if (!art || !spec) throw new Error("候选已不在当前资料库中，请刷新后重新预审");
  return OrderWorkDraftSchema.parse({
    ...current,
    artworkVersionId: art.id,
    specificationVersionId: spec.id,
    printProfileVersionId: spec.processProfileVersionId,
    salesRecipeVersionId: null,
    salesPackageId: null,
    fields: [
      ...current.fields,
      ...art.customization.fields
        .filter((f) => f.type !== "image" && !current.fields.some((v) => v.key === f.key))
        .map((f) => ({ key: f.key, label: f.label, kind: "text", value: "" })),
    ],
  });
}
