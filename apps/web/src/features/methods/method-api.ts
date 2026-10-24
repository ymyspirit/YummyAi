export class MethodRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "MethodRequestError";
  }
}
export async function methodRequest(
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<unknown> {
  const response = await fetch("/api/agent-methods/" + path, {
    method: body === undefined ? "GET" : "POST",
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    cache: "no-store",
    signal,
  });
  const value = await response.json().catch(() => null);
  if (!response.ok)
    throw new MethodRequestError(
      response.status,
      typeof value?.message === "string" ? value.message : "方法服务暂不可用",
    );
  return value;
}
export const methodAccessDenied = (error: unknown) =>
  error instanceof MethodRequestError && [401, 403, 404].includes(error.status);
