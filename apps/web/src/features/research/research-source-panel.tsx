"use client";
import Link from "next/link";
import { ResearchThumbnail } from "./research-thumbnail";
import {
  researchSourceInstructions,
  type ResearchSourceReference,
} from "@yummyai/contracts/research/creative";
import "./research-workflow.css";

export function ResearchSourcePanel({
  sources,
  loading,
  error,
  onRetry,
  onFill,
  historicalIds = [],
}: {
  sources: ResearchSourceReference[];
  loading?: boolean;
  error?: string;
  onRetry?: () => void;
  onFill?: () => void;
  historicalIds?: string[];
}) {
  return (
    <section className="research-source-panel" aria-label="创意研究依据">
      <header>
        <h4>研究依据 · {sources.length} 条</h4>
        {onFill && sources.length > 0 && (
          <button type="button" onClick={onFill}>
            将研究结论填入空白需求
          </button>
        )}
      </header>
      <p>
        采用的采集快照和研究结论会随需求单保存。后续补充研究不会改变本项目；生产文件使用已确认的原创或授权素材。
      </p>
      {loading && <p role="status">正在读取所选研究版本…</p>}
      {error && (
        <p role="alert">
          {error}{" "}
          {onRetry && (
            <button type="button" onClick={onRetry}>
              重新读取研究来源
            </button>
          )}
        </p>
      )}
      {!loading && !error && !sources.length && (
        <p>
          {historicalIds.length
            ? "历史项目只记录了来源条目，没有固定研究版本。"
            : "尚未选择研究来源。可在上方选择，或从研究资料库勾选竞品加入。"}
        </p>
      )}
      {sources.map((source, index) => (
        <details className="research-source-row" key={source.researchItemId} open={index === 0}>
          <summary>
            <ResearchThumbnail privateArchive snapshotId={source.snapshotId} src={source.thumbnailUrl} alt={source.title} />
            <span>
              <strong>{source.title}</strong>
              <small>
                采集 {new Date(source.capturedAt).toLocaleString("zh-CN")} ·{" "}
                {source.studyVersion ? `研究 V${source.studyVersion}` : "尚无研究结论"} ·{" "}
                {source.mediaCount} 项媒体
              </small>
            </span>
          </summary>
          <pre>{researchSourceInstructions([source])}</pre>
          <Link
            href={`/research?item=${source.researchItemId}&snapshot=${source.snapshotId}&study=${source.studyRevisionId ?? "none"}`}
            target="_blank"
            rel="noreferrer"
          >
            查看采用的研究快照与媒体
          </Link>
        </details>
      ))}
      {!sources.length &&
        historicalIds.map((id, index) => (
          <p key={id}>
            <Link href={`/research?item=${id}`} target="_blank" rel="noreferrer">
              研究来源 {index + 1}（当前资料）
            </Link>
          </p>
        ))}
    </section>
  );
}
