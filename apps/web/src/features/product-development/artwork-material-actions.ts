"use server";
import { apiFetch } from "../../server-api";

export async function uploadArtworkMaterial(
  data: FormData,
): Promise<{ assetId?: string; error?: string }> {
  const file = data.get("file"),
    source = String(data.get("source") ?? ""),
    reference = String(data.get("reference") ?? "").trim();
  if (!(file instanceof File) || !file.size || file.size > 20 * 1024 * 1024)
    return { error: "请选择 20 MiB 以内的文件" };
  if (
    !["owned", "licensed", "commissioned", "ai_generated"].includes(source) ||
    !reference ||
    reference.length > 500
  )
    return { error: "请确认素材来源并填写来源说明" };
  const types: Record<string, string> = {
    psd: "image/vnd.adobe.photoshop",
    svg: "image/svg+xml",
    pdf: "application/pdf",
    ttf: "font/ttf",
    otf: "font/otf",
    zip: "application/zip",
  };
  const mediaType = file.type || types[file.name.split(".").at(-1)?.toLowerCase() ?? ""];
  if (!mediaType) return { error: "文件格式无法识别" };
  const base = process.env.API_BASE_URL?.replace(/\/$/, "");
  if (!base) return { error: "服务尚未就绪" };
  try {
    const response = await apiFetch(`${base}/assets`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        domain: "authorized",
        fileName: file.name,
        mediaType,
        dataBase64: Buffer.from(await file.arrayBuffer()).toString("base64"),
      }),
    });
    const uploaded = await response.json();
    if (!response.ok || typeof uploaded.id !== "string")
      return { error: typeof uploaded.message === "string" ? uploaded.message : "素材上传失败" };
    const rights = await apiFetch(`${base}/v1/design/assets/${uploaded.id}/rights`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rightsSource: { kind: source, reference } }),
    });
    if (!rights.ok) return { error: "文件已上传，但使用权确认失败，请到素材审核页处理" };
    return { assetId: uploaded.id };
  } catch {
    return { error: "上传未完成，请检查连接后重试" };
  }
}
