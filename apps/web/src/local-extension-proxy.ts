import { NextResponse } from "next/server";

import { apiFetch } from "./server-api";

const LOCAL_EXTENSION_ID = "pbfkpadkdjbjgmibceaelflmgjhclnhl";
const LOCAL_EXTENSION_ORIGIN = `chrome-extension://${LOCAL_EXTENSION_ID}`;

export async function proxyLocalExtensionPost(request: Request, apiPath: string) {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ title: "Local extension proxy is disabled" }, { status: 404 });
  }
  if (!isTrustedLocalExtensionRequest(request)) {
    return NextResponse.json({ title: "Local extension identity is required" }, { status: 403 });
  }

  const apiBase = process.env.API_BASE_URL;
  if (!apiBase) {
    return NextResponse.json({ title: "API_BASE_URL is not configured" }, { status: 503 });
  }
  const response = await apiFetch(`${apiBase.replace(/\/$/, "")}${apiPath}`, {
    body: await request.text(),
    cache: "no-store",
    headers: { "content-type": request.headers.get("content-type") ?? "application/json" },
    method: "POST",
  });
  return new NextResponse(response.body, {
    status: response.status,
    headers: {
      "access-control-allow-origin": LOCAL_EXTENSION_ORIGIN,
      "content-type": response.headers.get("content-type") ?? "application/json",
      vary: "Origin",
    },
  });
}

export function localExtensionOptions(request: Request) {
  if (!isTrustedLocalExtensionRequest(request)) {
    return NextResponse.json({ title: "Local extension identity is required" }, { status: 403 });
  }
  return new NextResponse(null, {
    status: 204,
    headers: {
      "access-control-allow-headers": "content-type, x-yummyai-extension-id",
      "access-control-allow-methods": "POST, OPTIONS",
      "access-control-allow-origin": LOCAL_EXTENSION_ORIGIN,
      vary: "Origin",
    },
  });
}

export function isTrustedLocalExtensionRequest(request: Request): boolean {
  return (
    request.headers.get("origin") === LOCAL_EXTENSION_ORIGIN &&
    request.headers.get("x-yummyai-extension-id") === LOCAL_EXTENSION_ID
  );
}
