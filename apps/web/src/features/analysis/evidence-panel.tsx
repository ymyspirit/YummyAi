"use client";

import type { AnalysisClaim, EvidenceRef } from "@yummyai/contracts";
import { BookOpenText, Check, Lightbulb, Sparkles, X } from "lucide-react";
import { useState } from "react";

interface EvidenceSection {
  id: string;
  title: string;
  summary?: string;
  claims: AnalysisClaim[];
}

interface SelectedEvidence {
  claim: AnalysisClaim;
  references: EvidenceRef[];
}

export function EvidencePanel({ sections }: { sections: EvidenceSection[] }) {
  const [selected, setSelected] = useState<SelectedEvidence | null>(null);

  return (
    <div className="evidence-workbench">
      <div className="evidence-sections">
        {sections.map((section) => (
          <section className="analysis-section" key={section.id} aria-labelledby={`section-${section.id}`}>
            <header>
              <p className="section-code">EVIDENCE SECTION</p>
              <h2 id={`section-${section.id}`}>{section.title}</h2>
              {section.summary && <p>{section.summary}</p>}
            </header>
            <ol className="claim-spine">
              {section.claims.map((claim, index) => (
                <li key={claim.id}>
                  <span className="claim-node" aria-hidden="true">{String(index + 1).padStart(2, "0")}</span>
                  <article className="claim-body">
                    <div className="claim-heading">
                      <ClaimBadge claim={claim} />
                      {claim.kind === "inference" && <span className="claim-signal mono">{Math.round(claim.confidence * 100)}% 信心</span>}
                      {claim.kind === "recommendation" && <span className="claim-signal mono">{claim.priority.toUpperCase()}</span>}
                    </div>
                    <p>{claim.text}</p>
                    <button
                      className="evidence-button"
                      type="button"
                      onClick={() => setSelected({ claim, references: claim.evidence })}
                      aria-label={`查看“${claim.text}”的 ${claim.evidence.length} 条证据`}
                    >
                      <BookOpenText size={15} /> {claim.evidence.length} 条来源
                    </button>
                  </article>
                </li>
              ))}
            </ol>
          </section>
        ))}
      </div>
      <aside className={`evidence-drawer ${selected ? "evidence-drawer-open" : ""}`} aria-live="polite" aria-label="证据详情">
        <div className="drawer-heading">
          <div><p className="section-code">SOURCE TRACE</p><h2>证据抽屉</h2></div>
          {selected && <button className="drawer-close" type="button" onClick={() => setSelected(null)} aria-label="关闭证据抽屉"><X size={17} /></button>}
        </div>
        {!selected && <div className="drawer-empty"><BookOpenText size={22} /><p>选择一条声明，核对它引用的快照、字段与原文摘录。</p></div>}
        {selected && (
          <div className="drawer-content">
            <p className="drawer-claim">{selected.claim.text}</p>
            {selected.references.length === 0 ? <p className="drawer-empty-copy">这条推断或建议没有直接证据；请结合信心值与上下文审阅。</p> : (
              <ol className="reference-list">
                {selected.references.map((reference, index) => (
                  <li key={`${reference.snapshotId}-${reference.sourcePath}`}>
                    <span className="reference-number mono">E{String(index + 1).padStart(2, "0")}</span>
                    <div><strong>{reference.sourceType} · {reference.sourcePath}</strong><code>{reference.snapshotId}</code>{reference.excerpt && <blockquote>{reference.excerpt}</blockquote>}</div>
                  </li>
                ))}
              </ol>
            )}
          </div>
        )}
      </aside>
    </div>
  );
}

function ClaimBadge({ claim }: { claim: AnalysisClaim }) {
  if (claim.kind === "fact") return <span className="claim-badge claim-fact"><Check size={13} />事实</span>;
  if (claim.kind === "inference") return <span className="claim-badge claim-inference"><Lightbulb size={13} />推断</span>;
  return <span className="claim-badge claim-recommendation"><Sparkles size={13} />建议</span>;
}
