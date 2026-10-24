import { afterEach, expect, it, vi } from "vitest";
import type { ErpSessionView } from "@yummyai/contracts/auth/session";
import { PersonalSessionError } from "../identity/core";
const service = vi.hoisted(() => ({
  configuration: { apiBase: "https://api.example" },
  assertLiveSession: vi.fn(),
}));
vi.mock("../identity/services", () => ({ personalIdentity: () => service }));
import {
  assertErpIdentityCurrent,
  erpAuthority,
  readErpSession,
  type ErpRequestIdentity,
} from "./server";
const view: ErpSessionView = {
  authenticated: true,
  canUseErp: true,
  userId: "019f0000-0000-7000-8000-000000000001",
  tenantId: "019f0000-0000-7000-8000-000000000002",
  displayName: "Synthetic operator",
  organizationName: "Synthetic organization",
  permissions: ["product:read"],
  dataScope: "self",
};
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});
it("rejects logout that occurs while the final membership response is delayed", async () => {
  vi.stubEnv("WEB_AUTH_MODE", "personal");
  vi.stubEnv("FACTORY_PORTAL_ONLY", "0");
  let live = true,
    release!: (response: Response) => void,
    started!: () => void;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  service.assertLiveSession.mockImplementation(async () => {
    if (!live) throw new PersonalSessionError(401, "login_required");
  });
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation(() => {
      started();
      return new Promise<Response>((resolve) => {
        release = resolve;
      });
    }),
  );
  const identity = {
    service,
    token: "synthetic-personal-token",
    sessionId: "synthetic-session",
    authority: erpAuthority(view),
  } as unknown as ErpRequestIdentity;
  const reading = assertErpIdentityCurrent(identity);
  await entered;
  live = false;
  release(Response.json(view));
  await expect(reading).rejects.toMatchObject({ status: 401 });
});
it("refuses an unsupported authority response rather than fabricating personal access", async () => {
  vi.stubEnv("WEB_AUTH_MODE", "personal");
  vi.stubEnv("FACTORY_PORTAL_ONLY", "0");
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(Response.json({ ...view, permissions: "product:write" })),
  );
  await expect(readErpSession("synthetic-personal-token")).rejects.toMatchObject({ status: 503 });
});
