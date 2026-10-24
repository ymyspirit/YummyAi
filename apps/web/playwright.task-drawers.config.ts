import { defineConfig } from "@playwright/test";
import base from "./playwright.order-workbench.config";

// UI contracts use in-memory transport; no business fixtures or model calls.
export default defineConfig({
  ...base,
  testMatch: [
    "task-drawers.spec.ts",
    "development-navigation.spec.ts",
    "product-spu-edit.spec.ts",
    "order-review.spec.ts",
    "order-processing.spec.ts",
    "order-artwork-review.spec.ts",
  ],
  outputDir: "../../tmp/task-drawers-e2e",
});
