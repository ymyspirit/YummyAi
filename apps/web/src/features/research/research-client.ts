import {
  ResearchSourceReferenceSchema,
  type ResearchSourceSelection,
} from "@yummyai/contracts/research/creative";

export async function researchRequest<T>(
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(`/api/research/${path}`, {
    method: body === undefined ? "GET" : "POST",
    cache: "no-store",
    signal,
    ...(body === undefined
      ? {}
      : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.message ?? `研究资料读取失败 (${response.status})`);
  return data as T;
}
export async function resolveSources(sources: ResearchSourceSelection[], signal?: AbortSignal) {
  return ResearchSourceReferenceSchema.array().parse(
    await researchRequest("creative-sources", { sources }, signal),
  );
}
export const studyStatusLabels = {
  unreviewed: "待研究",
  analyzed: "已研究",
  parked: "暂不采用",
} as const;
