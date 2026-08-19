import { describe, expect, it } from "vitest";

import { parseCanvasBatchCsv } from "./canvas-batch-csv";

const assetId = "01987654-3210-7abc-8def-0123456789ab";
const specId = "01987654-3210-7abc-8def-0123456789ac";
const header = "row_key,name,prompt,negative_prompt,reference_asset_ids,candidate_count,print_spec_version_ids";

describe("parseCanvasBatchCsv", () => {
  it("parses quoted prompts and pipe-separated pinned identifiers", () => {
    const result = parseCanvasBatchCsv(`${header}\nrow-1,Coast,"ocean, dawn",,${assetId},4,${specId}`);

    expect(result.diagnostics).toEqual([]);
    expect(result.items).toEqual([expect.objectContaining({
      rowKey: "row-1",
      prompt: "ocean, dawn",
      referenceAssetIds: [assetId],
      candidateCount: 4,
      printSpecVersionIds: [specId],
    })]);
  });

  it.each([
    [`${header},surprise\nrow-1,Name,Prompt,,,2,${specId},x`, "未知列：surprise"],
    [`${header}\nrow-1,Name,Prompt,,,5,${specId}`, "candidate_count 必须为 1–4"],
    [`${header}\nrow-1,Name,Prompt,,,2,not-a-version`, "非法规格版本 ID"],
    [`${header}\nrow-1,Name,Prompt,,not-an-asset,2,${specId}`, "非法资产 ID"],
    [`${header}\nrow-1,Name,Prompt,,,2,${specId}\nrow-1,Again,Prompt,,,2,${specId}`, "row_key row-1 重复"],
  ])("returns line diagnostics instead of partial import", (source, expected) => {
    const result = parseCanvasBatchCsv(source);
    expect(result.items).toEqual([]);
    expect(result.diagnostics.join(" ")).toContain(expected);
  });

  it("rejects more than 50 valid rows", () => {
    const rows = Array.from({ length: 51 }, (_, index) => `row-${index + 1},Name ${index + 1},Prompt,,,1,${specId}`);
    const result = parseCanvasBatchCsv([header, ...rows].join("\n"));

    expect(result.items).toEqual([]);
    expect(result.diagnostics).toContain("CSV 包含 51 条有效需求，单批最多 50 条。");
  });
});
