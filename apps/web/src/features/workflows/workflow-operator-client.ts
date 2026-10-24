export class WorkflowReadError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
export async function readWorkflow<T>(
  path: string,
  schema: { parse(value: unknown): T },
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(`/api/workflow-runs/${path}`, { cache: "no-store", signal });
  const body = await response.json().catch(() => null);
  if (!response.ok)
    throw new WorkflowReadError(
      response.status,
      typeof body?.message === "string" ? body.message : "读取任务未完成，请刷新重试",
    );
  try {
    return schema.parse(body);
  } catch {
    throw new WorkflowReadError(502, "执行记录内容不完整，请刷新后重试");
  }
}
