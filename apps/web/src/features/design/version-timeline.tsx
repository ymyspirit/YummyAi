import { Check, Clock3, LockKeyhole, X } from "lucide-react";

import type { DesignVersionView } from "./design-task";

export function VersionTimeline({ versions, selectedId, primaryId, onSelect }: {
  versions: DesignVersionView[];
  selectedId: string;
  primaryId?: string;
  onSelect: (id: string) => void;
}) {
  return (
    <section className="version-timeline" aria-labelledby="version-history-title">
      <header><p className="section-code">IMMUTABLE HISTORY</p><h2 id="version-history-title">版本时间线</h2><span className="mono">{versions.length} VERSIONS</span></header>
      <ol>
        {versions.map((version) => (
          <li key={version.id} className={version.id === selectedId ? "selected" : ""}>
            <button type="button" onClick={() => onSelect(version.id)} aria-pressed={version.id === selectedId}>
              <span className={`version-state version-${version.status}`}>{statusIcon(version.status)}</span>
              <span><strong>VERSION {String(version.versionNumber).padStart(2, "0")}</strong><small>{formatDate(version.createdAt)}</small></span>
              <span className="version-badges">{version.id === primaryId && <b>PRIMARY</b>}<em>{statusLabel(version.status)}</em></span>
            </button>
            {version.rejectionReason && <p><X size={13} />{version.rejectionReason}</p>}
          </li>
        ))}
      </ol>
      <footer><LockKeyhole size={15} /><span>已审批版本由数据库锁定；修改会生成新版本。</span></footer>
    </section>
  );
}

function statusIcon(status: DesignVersionView["status"]) {
  if (status === "approved") return <Check size={14} />;
  if (status === "rejected") return <X size={14} />;
  return <Clock3 size={14} />;
}

function statusLabel(status: DesignVersionView["status"]) {
  return ({ approved: "已审批", rejected: "已驳回", pending_review: "待评审" })[status];
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}
