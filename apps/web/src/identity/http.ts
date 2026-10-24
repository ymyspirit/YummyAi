import type { NextResponse } from "next/server";
import { PersonalSessionError } from "./core";
export function identitySetting(name: string) {
  const value = process.env[name];
  if (!value) throw new PersonalSessionError(503, "session_unavailable");
  return value;
}
export function trustedIdentityUrl(value: string, originOnly = false) {
  try {
    const u = new URL(value),
      local = ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
    if (
      u.username ||
      u.password ||
      u.hash ||
      u.search ||
      (u.protocol !== "https:" && !(local && u.protocol === "http:")) ||
      (originOnly && u.pathname !== "/")
    )
      throw Error();
    return originOnly ? u.origin : u.href.replace(/\/$/, "");
  } catch {
    throw new PersonalSessionError(503, "session_unavailable");
  }
}
export function identityCookieNames(application: "factory" | "erp", origin: string) {
  const prefix = origin.startsWith("https:") ? "__Host-" : "";
  return {
    session: `${prefix}yummyai_${application}_session`,
    flow: `${prefix}yummyai_${application}_flow`,
  };
}
export function readIdentityCookie(request: Request, name: string) {
  const values = (request.headers.get("cookie") ?? "")
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.slice(0, s.indexOf("=")) === name);
  if (values.length > 1) throw new PersonalSessionError(401, "login_required");
  return values[0]?.slice(name.length + 1);
}
export function writeIdentityCookie(
  response: NextResponse,
  origin: string,
  name: string,
  value: string,
  maxAge: number,
) {
  response.cookies.set({
    name,
    value,
    maxAge,
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: origin.startsWith("https:"),
  });
}
export function requireIdentityOrigin(request: Request, origin: string) {
  if (request.headers.get("origin") !== origin)
    throw new PersonalSessionError(400, "login_invalid");
}
