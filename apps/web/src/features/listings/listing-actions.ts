"use server";

import type { ListingDraft, ListingValidation } from "@yummyai/platform-rules";
import { revalidatePath } from "next/cache";

import { apiFetch } from "../../server-api";

export interface ListingSaveResult {
  message: string;
  status: "success" | "error";
  version?: { id: string; versionNumber: number; validation: ListingValidation };
}

export async function saveListingVersion(listingId: string, content: ListingDraft): Promise<ListingSaveResult> {
  const apiBase = process.env.API_BASE_URL;
  if (!apiBase) return { message: "API_BASE_URL 未配置，无法保存 Listing。", status: "error" };
  try {
    const response = await apiFetch(`${apiBase.replace(/\/$/, "")}/v1/listings/${listingId}/versions`, {
      body: JSON.stringify(content), cache: "no-store", headers: { "content-type": "application/json" }, method: "POST",
    });
    const payload = await response.json().catch(() => undefined) as Record<string, unknown> | undefined;
    if (!response.ok) return { message: messageFrom(payload) ?? `保存失败 (${response.status})`, status: "error" };
    const version = payload as unknown as ListingSaveResult["version"];
    revalidatePath(`/listings/${listingId}`);
    revalidatePath("/listings");
    return { message: `已保存为不可变版本 V${String(version?.versionNumber ?? "").padStart(2, "0")}。`, status: "success", ...(version ? { version } : {}) };
  } catch (error) { return { message: error instanceof Error ? error.message : "Listing 保存失败。", status: "error" }; }
}

function messageFrom(payload: Record<string, unknown> | undefined) { for (const key of ["detail", "message", "title"]) if (typeof payload?.[key] === "string") return payload[key]; return undefined; }
