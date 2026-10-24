import type {
  AgentMethodWorkspace,
  AgentMethodRow,
  RegisteredAgentMethod,
  AgentMethodDefinition,
} from "@yummyai/contracts/harness/methods";
export type MethodItem = {
  key: string;
  label: string;
  catalog: RegisteredAgentMethod | null;
  row: AgentMethodRow | null;
};
export function methodItems(data: AgentMethodWorkspace): MethodItem[] {
  const keys = [
    ...new Set([
      ...data.catalog.map((item) => item.methodKey),
      ...data.methods.map((row) => row.methodKey),
    ]),
  ];
  return keys.map((key) => {
    const catalog = data.catalog.find((item) => item.methodKey === key) ?? null,
      row = data.methods.find((item) => item.methodKey === key) ?? null;
    const label = catalog?.label ?? row!.latest.definition.label;
    return {
      key,
      label: key.endsWith(".artwork_audit") ? `${label} · 看图审核` : label,
      catalog,
      row,
    };
  });
}
export function methodStatus(item: MethodItem) {
  const row = item.row;
  if (!row?.adoptedAt) return item.catalog ? "内置默认" : "版本不受支持";
  if (row.disabledAt || row.activeVersion === null) return "已停用";
  if (!row.activeAvailability?.supported) return "版本不受支持";
  if (!row.activeAvailability.sourcesUsable) return "来源待复核";
  return "已启用";
}
export const draftStatus = (row: AgentMethodRow | null) =>
  !row
    ? "未创建团队版本"
    : row.state === "in_review"
      ? "审核中"
      : row.state === "draft"
        ? "草稿"
        : "已发布";
export function methodDifference(
  previous: AgentMethodDefinition | null,
  next: AgentMethodDefinition,
) {
  const before = new Set(previous?.knowledgeReferences.map((ref) => ref.versionId) ?? []),
    after = new Set(next.knowledgeReferences.map((ref) => ref.versionId));
  return {
    notesChanged: (previous?.notes ?? "") !== next.notes,
    executionChanged:
      !!previous && previous.executionContract.checksum !== next.executionContract.checksum,
    added: next.knowledgeReferences.filter((ref) => !before.has(ref.versionId)),
    removed: (previous?.knowledgeReferences ?? []).filter((ref) => !after.has(ref.versionId)),
  };
}
