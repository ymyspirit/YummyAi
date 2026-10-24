import { EntityIdSchema } from "@yummyai/contracts/common/ids";
import { PodCompletionRecordSchema } from "@yummyai/contracts/pod/completion";
import { apiFetch } from "../../../../../../server-api";

export const dynamic = "force-dynamic";
const headers = { "cache-control": "private, no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" };
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const id = EntityIdSchema.safeParse((await context.params).id);
  if (!id.success) return Response.json({ message: "任务标识无效" }, { status: 400, headers });
  const base = process.env.API_BASE_URL;
  if (!base) return Response.json({ message: "交接记录服务未配置" }, { status: 503, headers });
  try {
    const upstream = await apiFetch(`${base.replace(/\/$/, "")}/v1/pod/tasks/${id.data}/completion`, { cache: "no-store", signal: AbortSignal.timeout(15_000) });
    if (!upstream.ok) return Response.json({ message: [401,403].includes(upstream.status) ? "当前无权读取此交接记录" : upstream.status === 404 ? "此任务没有可读取的原始交接记录" : "交接记录核验失败" }, { status: [400,401,403,404,409,410].includes(upstream.status) ? upstream.status : 502, headers });
    const record = PodCompletionRecordSchema.safeParse(await upstream.json());
    if (!record.success || record.data.evidence.taskId !== id.data) return Response.json({ message: "交接记录与原任务不一致" }, { status: 502, headers });
    return Response.json(record.data, { headers: { ...headers, "content-disposition": `attachment; filename="pod-completion-${id.data}.json"` } });
  } catch {
    return Response.json({ message: "暂时无法核对原始交接记录，请稍后重试" }, { status: 502, headers });
  }
}
