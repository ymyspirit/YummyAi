import type { AmazonReportLineView } from "@yummyai/contracts/order/report";

export const archiveLimit = 20 * 1024 * 1024;
export type ArchiveCandidate<T> = { file: T; line: AmazonReportLineView | null; issue: string | null };

// Filenames only propose a match. The existing server scanner/parser verifies the
// order and item identity inside the ZIP before persisting any customer material.
export function planReportArchives<T extends { name: string; size: number }>(files: readonly T[], lines: readonly AmazonReportLineView[]): ArchiveCandidate<T>[] {
  const byKey = new Map<string, AmazonReportLineView[]>();
  for (const line of lines) {
    const key = `${line.externalOrderId}_${line.externalLineId}`;
    byKey.set(key, [...(byKey.get(key) ?? []), line]);
  }
  const counts = new Map<string, number>();
  for (const file of files) counts.set(file.name.toLowerCase(), (counts.get(file.name.toLowerCase()) ?? 0) + 1);
  return files.map(file => {
    if (!/^\d{3}-\d{7}-\d{7}_\d{1,24}\.zip$/i.test(file.name)) return { file, line: null, issue: "文件名须为 订单号_订单项编号.zip" };
    if (counts.get(file.name.toLowerCase()) !== 1) return { file, line: null, issue: "存在同名文件 请仅保留核实后的原始文件" };
    if (!file.size || file.size > archiveLimit) return { file, line: null, issue: "文件须为 1 字节至 20 MB" };
    const matches = byKey.get(file.name.slice(0, -4)) ?? [];
    if (matches.length !== 1) return { file, line: null, issue: matches.length ? "订单项匹配不唯一" : "当前店铺与批次未找到订单项 请先导入对应报告" };
    const line = matches[0]!;
    return { file, line, issue: archiveSkipReason(line) };
  });
}

export function archiveSkipReason(line: AmazonReportLineView): string | null {
  if (["ready", "partial"].includes(line.state)) return "已有可读取的定制内容 保留当前版本";
  if (line.state === "expired") return "资料已到期 无法补传";
  if (line.state === "processing") return "后台正在处理 请完成后刷新";
  if (line.reviewed) return "已有核对记录 请在单件详情核对";
  return null;
}
