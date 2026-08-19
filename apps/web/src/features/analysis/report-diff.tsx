import type { AnalysisReport } from "@yummyai/contracts";

export function ReportDiff({ versions }: { versions: AnalysisReport[] }) {
  if (versions.length < 2) return <p className="diff-empty">这是首个报告版本；下一次分析后会在这里显示声明变化。</p>;
  const previous = versions.at(-2)!;
  const current = versions.at(-1)!;
  const before = claimsById(previous);
  const after = claimsById(current);
  const added = [...after.keys()].filter((id) => !before.has(id));
  const removed = [...before.keys()].filter((id) => !after.has(id));
  const changed = [...after.entries()].filter(([id, text]) => before.has(id) && before.get(id) !== text).map(([id]) => id);
  return (
    <section className="diff-strip" aria-labelledby="diff-title">
      <div><p className="section-code">VERSION DIFF</p><h2 id="diff-title">V{previous.version} → V{current.version}</h2></div>
      <dl><div><dt>新增</dt><dd>{added.length}</dd></div><div><dt>修改</dt><dd>{changed.length}</dd></div><div><dt>移除</dt><dd>{removed.length}</dd></div></dl>
      <p>{[...added.map((id) => `+ ${id}`), ...changed.map((id) => `~ ${id}`), ...removed.map((id) => `− ${id}`)].join(" · ") || "声明内容无变化"}</p>
    </section>
  );
}

function claimsById(report: AnalysisReport): Map<string, string> {
  return new Map(report.sections.flatMap((section) => section.claims.map((claim) => [claim.id, claim.text])));
}
