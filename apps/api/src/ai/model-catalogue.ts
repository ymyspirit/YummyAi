import { BadGatewayException, BadRequestException, GatewayTimeoutException } from "@nestjs/common";
import { ModelNameSchema, type ModelCatalogue } from "@yummyai/contracts/ai/model-configuration";

export function modelEndpoint(raw: string): string {
  let url: URL;
  try { url = new URL(raw.trim()); } catch { throw new BadRequestException("请填写有效的 API 地址"); }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || (url.protocol !== "https:" && !(url.protocol === "http:" && loopback && process.env.NODE_ENV !== "production"))) {
    throw new BadRequestException("API 地址须使用 HTTPS，不能包含凭据、查询参数或片段");
  }
  const base = url.href.replace(/\/+$/, "");
  if (/\/(?:models|chat\/completions|responses|images\/(?:edits|generations))$/i.test(base)) throw new BadRequestException("请填写 API 基础地址，例如 https://api.openai.com/v1");
  return /\/v\d+(?:beta)?$/.test(base) ? base : `${base}/v1`;
}

/** Directory lookup only. No generation, automatic retry, redirect, or provider error body. */
export async function discoverProviderModels(endpoint: string, apiKey: string, transport: typeof fetch = fetch): Promise<ModelCatalogue> {
  const base = modelEndpoint(endpoint);
  try {
    const response = await transport(`${base}/models`, { headers: { authorization: `Bearer ${apiKey}` }, redirect: "error", signal: AbortSignal.timeout(15_000) });
    if (!response.ok) {
      await response.body?.cancel();
      const messages: Record<number, string> = {
        401: "渠道认证失败，请检查 API Key 是否正确或已过期",
        403: "此 API Key 没有读取模型目录的权限，请核对项目权限",
        404: "渠道没有提供模型目录，请检查 API 基础地址，或手动添加模型",
        429: "渠道请求受到限流，请稍后重新获取模型",
      };
      throw new BadGatewayException(messages[response.status] ?? "渠道暂时无法返回模型目录，请稍后重试");
    }
    const reader = response.body?.getReader();
    if (!reader) throw new BadGatewayException("渠道返回了空内容，请检查模型目录接口");
    const chunks: Uint8Array[] = []; let length = 0;
    for (;;) {
      const part = await reader.read(); if (part.done) break;
      length += part.value.byteLength;
      if (length > 2_000_000) { await reader.cancel(); throw new BadGatewayException("渠道模型目录过大，请使用手动添加"); }
      chunks.push(part.value);
    }
    let body: unknown;
    try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new BadGatewayException("渠道返回的模型目录不是有效 JSON"); }
    const data = body && typeof body === "object" && "data" in body ? body.data : undefined;
    if (!Array.isArray(data) || data.length > 10_000) throw new BadGatewayException("渠道模型目录格式不兼容，请使用手动添加");
    const models = new Set<string>(); let skipped = 0;
    for (const row of data) {
      const parsed = ModelNameSchema.safeParse(row && typeof row === "object" ? row.id : undefined);
      if (parsed.success) models.add(parsed.data); else skipped++;
    }
    return { models: [...models].sort(), fetchedAt: new Date().toISOString(), source: "provider", skipped };
  } catch (cause) {
    if (cause instanceof BadGatewayException) throw cause;
    if (cause instanceof Error && ["TimeoutError", "AbortError"].includes(cause.name)) throw new GatewayTimeoutException("读取渠道模型目录超时，请稍后重试");
    throw new BadGatewayException("无法连接模型渠道，请检查 API 地址和网络连接");
  }
}
