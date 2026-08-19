import { Palette } from "lucide-react";
import Link from "next/link";

import { DesignTask, type DesignTaskView } from "../../../features/design/design-task";
import { DesignCreatePanel, type DesignResearchSample, type DesignSkuOption } from "../../../features/design/design-create-panel";
import { ErpSidebar } from "../../../features/navigation/erp-sidebar";
import { apiFetch } from "../../../server-api";

export const dynamic = "force-dynamic";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;
type DesignTaskSummary = Omit<DesignTaskView, "skuCode" | "versions">;

export default async function DesignPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const status = stringValue(params.status);
  const selectedTaskId = stringValue(params.task);
  const selectedSkuId = stringValue(params.sku);
  const [result, context] = await Promise.all([loadDesignWorkspace(selectedTaskId, status), loadDesignContext()]);
  return (
    <div className="research-shell design-shell">
      <ErpSidebar
        active="design"
        contextLabel="DESIGN OPS"
        note="每个校样版本固定文件校验值、权利来源和评审结论；生产访问只使用授权域签名链接。"
      />
      <main className="research-main design-main">
        <DesignCreatePanel initialSkuId={selectedSkuId} researchSample={context.researchSample} skus={context.skus} />
        {result.tasks.length ? <DesignTaskQueue selectedId={result.task?.id} status={status} tasks={result.tasks} /> : null}
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

async function loadDesignContext(): Promise<{ researchSample?: DesignResearchSample; skus: DesignSkuOption[] }> {
  const apiBase = process.env.API_BASE_URL;
  if (!apiBase) return { skus: [] };
  try {
    const [productsResponse, researchResponse] = await Promise.all([
      apiFetch(`${apiBase.replace(/\/$/, "")}/v1/products/plans`, { cache: "no-store" }),
      apiFetch(`${apiBase.replace(/\/$/, "")}/v1/research-items`, { cache: "no-store" }),
    ]);
    const products = productsResponse.ok ? await productsResponse.json() as Array<{ name: string; spu?: { skus: Array<{ id: string; code: string }> } }> : [];
    const research = researchResponse.ok ? await researchResponse.json() as { items?: Array<{ id: string; latestTitle: string | null; shopName?: string | null }> } : {};
    const skus = products.flatMap((product) => product.spu?.skus.map((sku) => ({ id: sku.id, code: sku.code, productName: product.name })) ?? []);
    const sample = research.items?.length === 1 ? research.items[0] : undefined;
    return {
      skus,
      ...(sample ? { researchSample: { id: sample.id, shopName: sample.shopName, title: sample.latestTitle ?? "未识别标题的研究样例" } } : {}),
    };
  } catch {
    return { skus: [] };
  }
}

async function loadDesignWorkspace(selectedTaskId: string, status: string): Promise<{ tasks: DesignTaskSummary[]; task?: DesignTaskView; error?: string }> {
  if (process.env.DESIGN_DEMO_MODE === "1") {
    const task = demoTask();
    const tasks = filterTasks([task], status);
    return tasks.length ? { tasks, task } : { tasks: [], error: "当前筛选没有设计任务。" };
  }
  const apiBase = process.env.API_BASE_URL;
  if (!apiBase) return { tasks: [], error: "尚未配置设计 API。请设置 API_BASE_URL 后重试。" };
  try {
    const response = await apiFetch(`${apiBase.replace(/\/$/, "")}/v1/design/tasks`, {
      cache: "no-store",
    });
    if (!response.ok) throw new Error(`设计任务读取失败 (${response.status})`);
    const allTasks = (await response.json()) as DesignTaskSummary[];
    const productsResponse = await apiFetch(`${apiBase.replace(/\/$/, "")}/v1/products/plans`, { cache: "no-store" });
    const products = productsResponse.ok ? await productsResponse.json() as Array<{ spu?: { skus: Array<{ id: string; code: string }> } }> : [];
    const skuCodes = new Map(products.flatMap((product) => product.spu?.skus.map((sku) => [sku.id, sku.code] as const) ?? []));
    const tasks = filterTasks(allTasks, status);
    const task = selectedTaskId ? tasks.find((item) => item.id === selectedTaskId) : tasks[0];
    if (!task) return { tasks, ...(selectedTaskId ? { error: "指定设计任务不存在、无权访问或不符合当前筛选。" } : {}) };
    const versionsResponse = await apiFetch(
      `${apiBase.replace(/\/$/, "")}/v1/design/tasks/${task.id}/versions`,
      { cache: "no-store" },
    );
    if (!versionsResponse.ok) throw new Error(`设计版本读取失败 (${versionsResponse.status})`);
    return { tasks,
      task: {
        ...task,
        skuCode: skuCodes.get(task.skuId) ?? task.skuId.slice(0, 12),
        versions: (await versionsResponse.json()) as DesignTaskView["versions"],
      },
    };
  } catch (error) {
    return { tasks: [], error: error instanceof Error ? error.message : "设计任务读取失败" };
  }
}

function DesignTaskQueue({ selectedId, status, tasks }: { selectedId?: string; status: string; tasks: DesignTaskSummary[] }) {
  return <section className="design-task-queue" aria-labelledby="design-task-queue-title"><header><div><p className="section-code">FILTERED TASK QUEUE</p><h1 id="design-task-queue-title">设计任务队列</h1></div><span>{tasks.length} TASKS · {statusLabel(status)}</span></header><nav aria-label="设计任务列表">{tasks.map((task) => { const query = new URLSearchParams({ task: task.id }); if (status) query.set("status", status); return <Link aria-current={task.id === selectedId ? "page" : undefined} className={task.id === selectedId ? "active" : undefined} href={`/design?${query.toString()}`} key={task.id}><strong>{task.title}</strong><span>{task.status} · {task.dueAt ? formatDueAt(task.dueAt) : "未设截止"}</span></Link>; })}</nav></section>;
}

function filterTasks(tasks: DesignTaskSummary[], status: string) {
  if (!status) return tasks;
  const now = Date.now();
  if (status === "active") return tasks.filter((task) => !["approved", "archived"].includes(task.status));
  if (status === "overdue") return tasks.filter((task) => !["approved", "archived"].includes(task.status) && task.dueAt && Date.parse(task.dueAt) < now);
  return tasks.filter((task) => task.status === status);
}

function stringValue(value: string | string[] | undefined) { return typeof value === "string" ? value : ""; }
function statusLabel(status: string) { return ({ active: "进行中", overdue: "已逾期", open: "待处理", in_review: "评审中", approved: "已批准", archived: "已归档" } as Record<string, string>)[status] ?? "全部状态"; }
function formatDueAt(value: string) { return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value)); }

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
