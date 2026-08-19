import { NextResponse } from "next/server";

import { apiFetch } from "../../../../server-api";

export async function PATCH(request: Request) {
  const apiBase = process.env.API_BASE_URL;
  if (!apiBase) {
    return NextResponse.json({ title: "API_BASE_URL is not configured" }, { status: 503 });
  }

  const response = await apiFetch(
    `${apiBase.replace(/\/$/, "")}/v1/research-items/product-type`,
    {
      body: await request.text(),
      cache: "no-store",
      headers: { "content-type": request.headers.get("content-type") ?? "application/json" },
      method: "PATCH",
    },
  );
  return new NextResponse(response.body, {
    status: response.status,
    headers: { "content-type": response.headers.get("content-type") ?? "application/json" },
  });
}
