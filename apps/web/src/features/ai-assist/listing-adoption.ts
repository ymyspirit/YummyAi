import type { AssistListingCopy } from "@yummyai/contracts/ai/assist";
import type { ListingDraft } from "@yummyai/platform-rules";
import type { CopyField } from "./assist-business-results";

export function adoptListingCopy(
  current: ListingDraft,
  copy: AssistListingCopy,
  fields: CopyField[],
): ListingDraft {
  const draft = structuredClone(current);
  if (fields.includes("title")) draft.title = copy.title;
  if (fields.includes("description")) draft.description = copy.description;
  if (fields.includes("bullets") && draft.platform === "amazon") draft.bullets = [...copy.bullets];
  if (fields.includes("tags") && draft.platform === "etsy") draft.tags = [...copy.tags];
  if (fields.includes("personalizationInstructions") && draft.personalization?.enabled)
    draft.personalization.instructions = copy.personalizationInstructions;
  if (fields.includes("imageDescriptions")) {
    draft.mediaDescriptions = { ...draft.mediaDescriptions };
    for (const image of copy.imageDescriptions)
      if (draft.mediaAssetIds.includes(image.assetId))
        draft.mediaDescriptions[image.assetId] = image.text;
  }
  return draft;
}
