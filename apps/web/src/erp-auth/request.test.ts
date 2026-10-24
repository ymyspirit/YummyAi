import { afterEach, expect, it, vi } from "vitest";
const boundary = vi.hoisted(() => ({ headers: vi.fn(), identity: vi.fn() }));
vi.mock("next/headers.js", () => ({ headers: boundary.headers }));
vi.mock("./server", () => ({ erpRequestIdentity: boundary.identity }));
import { erpAmbientIdentity, hasNextRequestContext } from "./request";
afterEach(() => vi.resetAllMocks());
it("recognizes only the actual outside-request error as a fixture context", async () => {
  boundary.headers.mockRejectedValueOnce(new Error("headers was called outside a request scope"));
  expect(await hasNextRequestContext()).toBe(false);
  boundary.headers.mockRejectedValueOnce(new Error("Synthetic unexpected request failure"));
  await expect(hasNextRequestContext()).rejects.toThrow("Synthetic unexpected request failure");
});
it("derives an ambient identity from the current request cookie", async () => {
  boundary.headers.mockResolvedValue(
    new Headers({ cookie: "yummyai_erp_session=synthetic-current-cookie" }),
  );
  boundary.identity.mockResolvedValue({ token: "synthetic-current-user" });
  await erpAmbientIdentity();
  const [request] = boundary.identity.mock.calls[0]!;
  expect(request.headers.get("cookie")).toBe("yummyai_erp_session=synthetic-current-cookie");
});
