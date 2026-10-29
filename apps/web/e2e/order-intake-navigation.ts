import { errors, expect, type Page, type Response } from "@playwright/test";
import { OrderIntakeCheckViewSchema, type OrderIntakeCheck } from "@yummyai/contracts/order/workspace";
import type { OrderIntakePillowFixture } from "./order-intake-pillow-fixture";

/** Observe before real navigation, but reserve the response budget for after it. */
export async function navigateToInitialOrderCheck(page: Page, fixture: OrderIntakePillowFixture,
  predicate: (check: OrderIntakeCheck) => boolean) {
  const pathname = `/api/order-centers/lines/${fixture.lineId}/intake-check`;
  const responses: Response[] = [];
  let active = true, notify = () => {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  const observe = (response: Response) => {
    if (new URL(response.url()).pathname !== pathname || response.request().method() !== "POST") return;
    responses.push(response);
    notify();
  };
  async function checkedResponse() {
    while (active) {
      const response = responses.shift();
      if (!response) {
        await new Promise<void>(resolve => { notify = resolve; });
        continue;
      }
      expect(response.ok(), `Initial intake check returned HTTP ${response.status()}`).toBe(true);
      const check = OrderIntakeCheckViewSchema.parse(await response.json());
      expect(check.orderLineId).toBe(fixture.lineId);
      expect(check.revision).toBe(fixture.initial.line.revision);
      expect(check.sourceVersionId).toBe(fixture.sourceVersionId);
      if (predicate(check)) return check;
    }
    throw new Error("Initial intake observation ended before a matching check");
  }
  page.on("response", observe);
  try {
    const navigation = await page.goto(fixture.url);
    expect(navigation?.ok(), "Initial order navigation must succeed").toBe(true);
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new errors.TimeoutError("Initial intake response: Timeout 15000ms exceeded after navigation")), 15_000);
    });
    return await Promise.race([checkedResponse(), deadline]);
  } finally {
    active = false;
    if (timer) clearTimeout(timer);
    page.off("response", observe);
    notify();
  }
}
