import type { AnalysisReport } from "@yummyai/contracts";
import { FileSearch2 } from "lucide-react";

import { AnalysisReportView } from "../../../../features/analysis/analysis-report-view";
import { ErpSidebar } from "../../../../features/navigation/erp-sidebar";
import { getApiHeaders } from "../../../../server-api";

export const dynamic = "force-dynamic";

export default async function AnalysisReportPage({
  params,
}: {
  params: Promise<{ reportId: string }>;
}) {
  const { reportId } = await params;
  const result = await loadAnalysis(reportId);
  return (
    <div className="research-shell analysis-shell">
      <ErpSidebar
        active="research"
        contextLabel="EVIDENCE ERP"
        note="每条事实保留快照和字段路径；推断与建议单独标记，方便人工审阅。"
      />
      <main className="research-main analysis-main">
        {result.error && (
          <section className="analysis-error" role="alert">
            <FileSearch2 size={28} />
            <h1>报告暂不可用</h1>
            <p>{result.error}</p>
            <a href="/research">返回研究资料库</a>
          </section>
        )}
        {result.report && <AnalysisReportView report={result.report} versions={result.versions} />}
      </main>
    </div>
  );
}

async function loadAnalysis(
  reportId: string,
): Promise<{ report?: AnalysisReport; versions: AnalysisReport[]; error?: string }> {
  if (process.env.ANALYSIS_DEMO_MODE === "1") {
    const versions = demoVersions(reportId);
    return { report: versions.at(-1), versions };
  }
  const apiBase = process.env.API_BASE_URL;
  if (!apiBase) return { versions: [], error: "尚未配置分析 API。请设置 API_BASE_URL 后重试。" };
  const base = `${apiBase.replace(/\/$/, "")}/v1/ai/analyses/${encodeURIComponent(reportId)}`;
  try {
    const headers = await getApiHeaders();
    const [reportResponse, versionsResponse] = await Promise.all([
      fetch(base, { cache: "no-store", headers }),
      fetch(`${base}/versions`, { cache: "no-store", headers }),
    ]);
    if (!reportResponse.ok || !versionsResponse.ok)
      throw new Error(`分析报告读取失败 (${reportResponse.status}/${versionsResponse.status})`);
    return {
      report: (await reportResponse.json()) as AnalysisReport,
      versions: (await versionsResponse.json()) as AnalysisReport[],
    };
  } catch (error) {
    return { versions: [], error: error instanceof Error ? error.message : "分析报告读取失败" };
  }
}

function demoVersions(reportSeriesId: string): AnalysisReport[] {
  const series = /^[0-9a-f-]{36}$/i.test(reportSeriesId)
    ? reportSeriesId
    : "0198fbef-4a10-7000-8000-000000000021";
  const snapshotA = "0198fbef-4a10-7000-8000-000000000022";
  const snapshotB = "0198fbef-4a10-7000-8000-000000000023";
  const common = {
    reportSeriesId: series,
    taskType: "AI-05" as const,
    status: "completed" as const,
    title: "礼品类商品定位与机会审计",
    inputSnapshotIds: [snapshotA, snapshotB],
    model: { providerId: "openai", modelKey: "analyst.comparison", costUsd: 0.0842 },
    promptTemplateVersion: "comparison-v3",
    createdBy: "0198fbef-4a10-7000-8000-000000000024",
  };
  const first: AnalysisReport = {
    ...common,
    id: "0198fbef-4a10-7000-8000-000000000025",
    version: 1,
    createdAt: "2026-07-17T06:30:00.000Z",
    executiveSummary: "两个商品都强调送礼场景，但价格和定制深度存在明显差异。",
    sections: [
      {
        id: "market",
        title: "市场信号",
        claims: [
          {
            id: "price-band",
            kind: "fact",
            text: "两个公开价格分别为 29.99 美元与 42.00 美元。",
            evidence: [
              {
                snapshotId: snapshotA,
                sourceType: "field",
                sourcePath: "price.amount",
                excerpt: "$29.99",
              },
              {
                snapshotId: snapshotB,
                sourceType: "field",
                sourcePath: "price.amount",
                excerpt: "$42.00",
              },
            ],
          },
        ],
      },
    ],
  };
  return [
    first,
    {
      ...common,
      id: "0198fbef-4a10-7000-8000-000000000026",
      version: 2,
      createdAt: "2026-07-18T07:45:00.000Z",
      executiveSummary:
        "证据显示中价位商品以交付速度取胜，高价商品依赖个性化与礼盒体验；新方案应优先验证轻定制组合。",
      sections: [
        {
          id: "market",
          title: "市场与价格",
          summary: "公开页面证据显示两个清晰的价值层级。",
          claims: [
            {
              id: "price-band",
              kind: "fact",
              text: "两个公开价格分别为 29.99 美元与 42.00 美元，价差约 40%。",
              evidence: [
                {
                  snapshotId: snapshotA,
                  sourceType: "field",
                  sourcePath: "price.amount",
                  excerpt: "$29.99",
                },
                {
                  snapshotId: snapshotB,
                  sourceType: "field",
                  sourcePath: "price.amount",
                  excerpt: "$42.00",
                },
              ],
            },
            {
              id: "premium-signal",
              kind: "inference",
              text: "高价商品的溢价主要来自刻字选项和礼盒呈现，而不是基础材质差异。",
              confidence: 0.78,
              evidence: [
                {
                  snapshotId: snapshotB,
                  sourceType: "field",
                  sourcePath: "content.personalization",
                  excerpt: "Add a name and gift message",
                },
              ],
            },
          ],
        },
        {
          id: "opportunity",
          title: "行动机会",
          claims: [
            {
              id: "bundle-test",
              kind: "recommendation",
              text: "先测试可选刻字与标准礼盒的轻定制组合，并把交付时效作为首屏证据。",
              priority: "high",
              evidence: [
                {
                  snapshotId: snapshotA,
                  sourceType: "field",
                  sourcePath: "shipping.promise",
                  excerpt: "Ships within 24 hours",
                },
              ],
            },
          ],
        },
      ],
      comparison: [
        {
          dimension: "公开价格",
          values: { [snapshotA]: "$29.99", [snapshotB]: "$42.00" },
          evidence: [
            { snapshotId: snapshotA, sourceType: "field", sourcePath: "price.amount" },
            { snapshotId: snapshotB, sourceType: "field", sourcePath: "price.amount" },
          ],
        },
        {
          dimension: "定制能力",
          values: { [snapshotA]: "固定款式", [snapshotB]: "姓名刻字 + 赠言" },
          evidence: [
            { snapshotId: snapshotB, sourceType: "field", sourcePath: "content.personalization" },
          ],
        },
        {
          dimension: "交付承诺",
          values: { [snapshotA]: "24 小时发货", [snapshotB]: "3–5 个工作日" },
          evidence: [
            { snapshotId: snapshotA, sourceType: "field", sourcePath: "shipping.promise" },
          ],
        },
      ],
    },
  ];
}
