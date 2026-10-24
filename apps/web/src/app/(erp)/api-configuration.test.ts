import { afterAll, beforeEach, describe, expect, test } from "vitest";

import { loadCompetitorShops } from "../../features/competitors/competitor-shop-data";
import { loadResearch } from "../../features/research/research-page-data";

const originalApiBaseUrl = process.env.API_BASE_URL;

describe.sequential("server API configuration failures", () => {
  beforeEach(() => {
    delete process.env.API_BASE_URL;
  });

  afterAll(() => {
    if (originalApiBaseUrl === undefined) delete process.env.API_BASE_URL;
    else process.env.API_BASE_URL = originalApiBaseUrl;
  });

  test("research reports missing configuration instead of an empty library", async () => {
    await expect(loadResearch(new URLSearchParams())).resolves.toMatchObject({
      error: expect.stringContaining("API_BASE_URL"),
      items: [],
      total: 0,
    });
  });

  test("competitor shops report missing configuration instead of an empty library", async () => {
    await expect(loadCompetitorShops()).resolves.toMatchObject({
      error: expect.stringContaining("API_BASE_URL"),
      items: [],
    });
  });
});
