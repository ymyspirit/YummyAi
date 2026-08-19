import { NextResponse } from "next/server";

import { apiFetch } from "../../../../../../server-api";

export async function GET(_request: Request, { params }: { params: Promise<{ planId: string }> }) {
  const { planId } = await params;
  if (!UUID_V7_PATTERN.test(planId)) {
    return NextResponse.json({ message: "无效的产品计划 ID。" }, { status: 400 });
  }
  const apiBase = process.env.API_BASE_URL;
  if (!apiBase) return NextResponse.json({ message: "API_BASE_URL 未配置。" }, { status: 503 });
  const response = await apiFetch(
    `${apiBase.replace(/\/$/, "")}/v1/products/plans/${planId}/custom-package/listing-materials/readiness`,
    { cache: "no-store" },
  );
  const payload = await response.json().catch(() => undefined);
  return NextResponse.json(payload ?? { message: `资料齐套检查失败 (${response.status})` }, {
    status: response.status,
  });
}

const UUID_V7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
