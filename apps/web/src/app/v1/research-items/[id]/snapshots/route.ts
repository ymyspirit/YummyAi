import { NextResponse } from "next/server";

import { apiFetch } from "../../../../../server-api";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const apiBase = process.env.API_BASE_URL;
  if (!apiBase)
    return NextResponse.json({ title: "API_BASE_URL is not configured" }, { status: 503 });
  const { id } = await params;
  const response = await apiFetch(
    `${apiBase.replace(/\/$/, "")}/v1/research-items/${encodeURIComponent(id)}/snapshots`,
    {
      cache: "no-store",
    },
  );
  return new NextResponse(response.body, {
    status: response.status,
    headers: { "content-type": response.headers.get("content-type") ?? "application/json" },
  });
}
