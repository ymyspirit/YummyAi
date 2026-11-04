export class DocumentRequestError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
export async function documentRequest<T>(path: string, input?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api/logistics/documents/${path}`, { method: input === undefined ? "GET" : "POST", cache: "no-store", signal,
    headers: input === undefined ? undefined : { "content-type": "application/json" }, body: input === undefined ? undefined : JSON.stringify(input) });
  const data = await response.json();
  if (!response.ok) throw new DocumentRequestError(response.status, typeof data?.message === "string" ? data.message : "导单请求未完成");
  return data as T;
}
