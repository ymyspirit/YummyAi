import { NextResponse } from "next/server";

import { apiFetch } from "../../../../../server-api";

export async function GET(request: Request, { params }: { params: Promise<{ planId: string }> }) {
  const { planId } = await params;
  if (!UUID_V7_PATTERN.test(planId)) {
    return NextResponse.json({ message: "无效的产品计划 ID。" }, { status: 400 });
  }
  const mode = new URL(request.url).searchParams.get("mode") ?? "draft";
  if (mode !== "draft" && mode !== "release") {
    return NextResponse.json({ message: "无效的导出模式。" }, { status: 400 });
  }
  const apiBase = process.env.API_BASE_URL;
  if (!apiBase) {
    return NextResponse.json({ message: "API_BASE_URL 未配置。" }, { status: 503 });
  }

  const response = await apiFetch(
    `${apiBase.replace(/\/$/, "")}/v1/products/plans/${planId}/custom-package?mode=${mode}`,
    { cache: "no-store" },
  );
  if (!response.ok || !response.body) {
    const payload = await response.json().catch(() => undefined);
    return NextResponse.json(payload ?? { message: `产品包导出失败 (${response.status})` }, {
      status: response.status,
    });
  }

  const headers = new Headers();
  headers.set("content-type", "application/zip");
  headers.set(
    "content-disposition",
    response.headers.get("content-disposition") ??
      `attachment; filename="${planId}-amazon-custom-product.zip"`,
  );
  headers.set("cache-control", "private, no-store");
  const contentLength = response.headers.get("content-length");
  if (contentLength) headers.set("content-length", contentLength);
  return new Response(response.body, { headers, status: 200 });
}

const UUID_V7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
