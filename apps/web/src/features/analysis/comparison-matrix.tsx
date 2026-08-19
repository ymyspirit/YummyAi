import type { AnalysisReport } from "@yummyai/contracts";

export function ComparisonMatrix({ rows }: { rows: NonNullable<AnalysisReport["comparison"]> }) {
  const products = Array.from(new Set(rows.flatMap((row) => Object.keys(row.values))));
  if (!rows.length) return null;
  return (
    <section className="comparison-frame" aria-labelledby="comparison-title">
      <header><p className="section-code">CROSS-SNAPSHOT MATRIX</p><h2 id="comparison-title">多商品对比</h2></header>
      <div className="comparison-scroll">
        <table className="comparison-table">
          <thead><tr><th>比较维度</th>{products.map((id, index) => <th key={id}>商品 {String.fromCharCode(65 + index)}<code>{shortId(id)}</code></th>)}</tr></thead>
          <tbody>{rows.map((row) => <tr key={row.dimension}><th>{row.dimension}<span>{row.evidence.length} 条证据</span></th>{products.map((id) => <td key={id}>{row.values[id] ?? "—"}</td>)}</tr>)}</tbody>
        </table>
      </div>
    </section>
  );
}

function shortId(id: string) {
  return `${id.slice(0, 8)}…${id.slice(-4)}`;
}
