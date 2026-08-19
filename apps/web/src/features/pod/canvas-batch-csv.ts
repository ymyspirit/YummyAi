import type { CreateCreativeDesignBatchInput } from "@yummyai/contracts/pod/batch-workflows";
import { EntityIdSchema } from "@yummyai/contracts/common/ids";

const columns = ["row_key", "name", "prompt", "negative_prompt", "reference_asset_ids", "candidate_count", "print_spec_version_ids"] as const;
const required = new Set(["row_key", "name", "prompt", "candidate_count", "print_spec_version_ids"]);

export function parseCanvasBatchCsv(source: string): { items: CreateCreativeDesignBatchInput["items"]; diagnostics: string[] } {
  const records = parseRecords(source);
  if (!records.length) return { items: [], diagnostics: ["CSV 为空。"] };
  const header = records[0]!.map((value) => value.trim());
  const diagnostics: string[] = [];
  const unknown = header.filter((value) => !columns.includes(value as typeof columns[number]));
  if (unknown.length) diagnostics.push(`未知列：${unknown.join("、")}`);
  for (const name of required) if (!header.includes(name)) diagnostics.push(`缺少必填列：${name}`);
  if (diagnostics.length) return { items: [], diagnostics };
  const seen = new Set<string>();
  const items: CreateCreativeDesignBatchInput["items"] = [];
  for (const [index, values] of records.slice(1).entries()) {
    if (values.every((value) => !value.trim())) continue;
    const row = Object.fromEntries(header.map((name, columnIndex) => [name, values[columnIndex]?.trim() ?? ""]));
    const line = index + 2;
    const candidateCount = Number(row.candidate_count);
    const references = splitIds(row.reference_asset_ids);
    const specs = splitIds(row.print_spec_version_ids);
    const rowErrors: string[] = [];
    if (!row.row_key || !row.name || !row.prompt) rowErrors.push("row_key、name、prompt 不能为空");
    if (seen.has(row.row_key)) rowErrors.push(`row_key ${row.row_key} 重复`);
    if (!Number.isInteger(candidateCount) || candidateCount < 1 || candidateCount > 4) rowErrors.push("candidate_count 必须为 1–4");
    if (references.length > 10) rowErrors.push("参考图最多 10 个");
    if (!specs.length || specs.length > 8) rowErrors.push("印刷规格必须为 1–8 个");
    if (references.some((id) => !EntityIdSchema.safeParse(id).success)) rowErrors.push("reference_asset_ids 包含非法资产 ID");
    if (specs.some((id) => !EntityIdSchema.safeParse(id).success)) rowErrors.push("print_spec_version_ids 包含非法规格版本 ID");
    if (new Set(references).size !== references.length) rowErrors.push("reference_asset_ids 不得重复");
    if (new Set(specs).size !== specs.length) rowErrors.push("print_spec_version_ids 不得重复");
    if (rowErrors.length) { diagnostics.push(`第 ${line} 行：${rowErrors.join("；")}`); continue; }
    seen.add(row.row_key);
    items.push({
      rowKey: row.row_key,
      name: row.name,
      prompt: row.prompt,
      ...(row.negative_prompt ? { negativePrompt: row.negative_prompt } : {}),
      referenceAssetIds: references,
      candidateCount,
      printSpecVersionIds: specs,
      focalPoint: { xPermille: 500, yPermille: 500 },
    });
  }
  if (items.length > 50) diagnostics.push(`CSV 包含 ${items.length} 条有效需求，单批最多 50 条。`);
  return { items: diagnostics.length ? [] : items, diagnostics };
}

function splitIds(value: string | undefined) {
  return value?.split("|").map((entry) => entry.trim()).filter(Boolean) ?? [];
}

function parseRecords(source: string) {
  const records: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;
    if (character === '"') {
      if (quoted && source[index + 1] === '"') { field += '"'; index += 1; }
      else quoted = !quoted;
    } else if (character === "," && !quoted) {
      row.push(field); field = "";
    } else if ((character === "\n" || character === "\r") && !quoted) {
      if (character === "\r" && source[index + 1] === "\n") index += 1;
      row.push(field); records.push(row); row = []; field = "";
    } else field += character;
  }
  if (field || row.length) { row.push(field); records.push(row); }
  return records;
}
