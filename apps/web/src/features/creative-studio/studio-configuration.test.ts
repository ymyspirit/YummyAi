import { expect, it } from "vitest";
import { studioRuntimeUrl } from "./studio-configuration";
it("exposes only the loopback model settings surface in production personal mode", () => {
  const env: NodeJS.ProcessEnv = { NODE_ENV: "production", WEB_AUTH_MODE: "personal", CANVAS_STUDIO_URL: "http://127.0.0.1:4176" };
  expect(studioRuntimeUrl(env, "settings")).toBe("http://127.0.0.1:4176");
  expect(studioRuntimeUrl(env)).toBeNull();
  expect(studioRuntimeUrl({ ...env, WEB_AUTH_MODE: "local-service" }, "settings")).toBeNull();
  expect(studioRuntimeUrl({ ...env, CANVAS_STUDIO_URL: "https://untrusted.example" }, "settings")).toBeNull();
  expect(studioRuntimeUrl({ ...env, CANVAS_STUDIO_URL: "http://127.0.0.1:4176?token=synthetic" }, "settings")).toBeNull();
});
it("requires the explicit adopted personal Studio flag and rejects non-loopback or credential-bearing runtime URLs", () => {
  const env: NodeJS.ProcessEnv = { NODE_ENV: "production", WEB_AUTH_MODE: "personal", CANVAS_STUDIO_PRODUCTION_ENABLED: "1", CANVAS_STUDIO_URL: "http://127.0.0.1:4176" };
  expect(studioRuntimeUrl(env)).toBe("http://127.0.0.1:4176");
  expect(studioRuntimeUrl({ ...env, CANVAS_STUDIO_PRODUCTION_ENABLED: "0" })).toBeNull();
  expect(studioRuntimeUrl({ ...env, CANVAS_STUDIO_PRODUCTION_ENABLED: undefined })).toBeNull();
  expect(studioRuntimeUrl({ ...env, WEB_AUTH_MODE: "local-service" })).toBeNull();
  for (const value of ["http://user:synthetic@127.0.0.1:4176", "http://127.0.0.1:4176?scope=private", "http://127.0.0.1:4176#fragment", "https://untrusted.example"]) expect(studioRuntimeUrl({ ...env, CANVAS_STUDIO_URL: value })).toBeNull();
  expect(studioRuntimeUrl({ NODE_ENV: "development", CANVAS_STUDIO_URL: "http://localhost:4176" })).toBe("http://localhost:4176");
});
