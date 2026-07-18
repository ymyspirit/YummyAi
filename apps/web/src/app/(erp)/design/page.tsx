import { Palette } from "lucide-react";

import { DesignTask, type DesignTaskView } from "../../../features/design/design-task";
import { ErpSidebar } from "../../../features/navigation/erp-sidebar";
import { apiFetch } from "../../../server-api";

export const dynamic = "force-dynamic";

export default async function DesignPage() {
  const result = await loadDesignTask();
  return (
    <div className="research-shell design-shell">
      <ErpSidebar
        active="design"
        contextLabel="DESIGN OPS"
        note="每个校样版本固定文件校验值、权利来源和评审结论；生产访问只使用授权域签名链接。"
      />
      <main className="research-main design-main">
        {result.task ? (
          <DesignTask task={result.task} />
        ) : (
          <section className="analysis-error" role="alert">
            <Palette size={28} />
            <h1>暂无设计任务</h1>
            <p>{result.error ?? "为已创建的 SKU 建立第一个设计任务。"}</p>
            <a href="/products">返回产品开发</a>
          </section>
        )}
      </main>
    </div>
  );
}

async function loadDesignTask(): Promise<{ task?: DesignTaskView; error?: string }> {
  if (process.env.DESIGN_DEMO_MODE === "1") return { task: demoTask() };
  const apiBase = process.env.API_BASE_URL;
  if (!apiBase) return { error: "尚未配置设计 API。请设置 API_BASE_URL 后重试。" };
  try {
    const response = await apiFetch(`${apiBase.replace(/\/$/, "")}/v1/design/tasks`, {
      cache: "no-store",
    });
    if (!response.ok) throw new Error(`设计任务读取失败 (${response.status})`);
    const tasks = (await response.json()) as Omit<DesignTaskView, "versions" | "skuCode">[];
    const task = tasks[0];
    if (!task) return {};
    const versionsResponse = await apiFetch(
      `${apiBase.replace(/\/$/, "")}/v1/design/tasks/${task.id}/versions`,
      { cache: "no-store" },
    );
    if (!versionsResponse.ok) throw new Error(`设计版本读取失败 (${versionsResponse.status})`);
    return {
      task: {
        ...task,
        skuCode: task.skuId.slice(0, 12),
        versions: (await versionsResponse.json()) as DesignTaskView["versions"],
      },
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "设计任务读取失败" };
  }
}

function demoTask(): DesignTaskView {
  const taskId = "0198fbef-4a10-7000-8000-000000000091";
  const v3 = "0198fbef-4a10-7000-8000-000000000092";
  const v2 = "0198fbef-4a10-7000-8000-000000000093";
  const v1 = "0198fbef-4a10-7000-8000-000000000094";
  const asset = (
    id: string,
    fileName: string,
    mediaType: string,
    byteSize: number,
    kind: "owned" | "licensed" | "commissioned" = "owned",
  ) => ({
    id,
    fileName,
    mediaType,
    byteSize,
    sha256: id.replaceAll("-", "").padEnd(64, "a").slice(0, 64),
    domain: "authorized" as const,
    rightsSource: {
      kind,
      reference: kind === "licensed" ? "LICENSE-2026-0718" : "INTERNAL-BRIEF-041",
    },
    rightsApprovedAt: "2026-07-18T01:24:00.000Z",
  });
  return {
    id: taskId,
    skuId: "0198fbef-4a10-7000-8000-000000000095",
    skuCode: "TMG-NVY-16",
    title: "旅行礼品杯 · 激光刻字与礼盒校样",
    brief: "建立杯身刻字安全区、海军蓝效果图与供应商可直接使用的激光/刀模文件。",
    status: "in_review",
    dueAt: "2026-07-24T10:00:00.000Z",
    primaryVersionId: v2,
    versions: [
      {
        id: v3,
        versionNumber: 3,
        status: "pending_review",
        changeNote: "按供应商反馈扩大顶部安全边距 2 mm，并更新高级礼盒烫金位置。",
        createdAt: "2026-07-18T02:30:00.000Z",
        files: [
          {
            id: "0198fbef-4a10-7000-8000-000000000096",
            role: "source",
            asset: asset(
              "0198fbef-4a10-7000-8000-000000000097",
              "travel-mug-master-v3.ai",
              "application/postscript",
              4_820_000,
              "owned",
            ),
          },
          {
            id: "0198fbef-4a10-7000-8000-000000000098",
            role: "effect",
            asset: asset(
              "0198fbef-4a10-7000-8000-000000000099",
              "navy-giftbox-proof-v3.png",
              "image/png",
              2_140_000,
              "licensed",
            ),
          },
          {
            id: "0198fbef-4a10-7000-8000-000000000100",
            role: "production",
            asset: asset(
              "0198fbef-4a10-7000-8000-000000000101",
              "laser-and-dieline-v3.zip",
              "application/zip",
              8_760_000,
              "commissioned",
            ),
          },
        ],
      },
      {
        id: v2,
        versionNumber: 2,
        status: "approved",
        changeNote: "完成刻字安全区、杯身海军蓝效果与两档礼盒刀模。",
        createdAt: "2026-07-17T09:45:00.000Z",
        files: [
          {
            id: "0198fbef-4a10-7000-8000-000000000102",
            role: "source",
            asset: asset(
              "0198fbef-4a10-7000-8000-000000000103",
              "travel-mug-master-v2.ai",
              "application/postscript",
              4_610_000,
            ),
          },
          {
            id: "0198fbef-4a10-7000-8000-000000000104",
            role: "effect",
            asset: asset(
              "0198fbef-4a10-7000-8000-000000000105",
              "navy-giftbox-proof-v2.png",
              "image/png",
              2_020_000,
              "licensed",
            ),
          },
          {
            id: "0198fbef-4a10-7000-8000-000000000106",
            role: "production",
            asset: asset(
              "0198fbef-4a10-7000-8000-000000000107",
              "laser-and-dieline-v2.zip",
              "application/zip",
              8_420_000,
              "commissioned",
            ),
          },
        ],
      },
      {
        id: v1,
        versionNumber: 1,
        status: "rejected",
        changeNote: "首次供应商校样。",
        rejectionReason: "激光刻字离杯口过近，礼盒刀模缺少出血线。",
        createdAt: "2026-07-15T07:20:00.000Z",
        files: [
          {
            id: "0198fbef-4a10-7000-8000-000000000108",
            role: "effect",
            asset: asset(
              "0198fbef-4a10-7000-8000-000000000109",
              "first-proof.png",
              "image/png",
              1_840_000,
            ),
          },
        ],
      },
    ],
  };
}
