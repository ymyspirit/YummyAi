import { defineConfig } from "@playwright/test";
import base from "./playwright.order-daily.config";
const servers = Array.isArray(base.webServer) ? base.webServer : [];
export default defineConfig({ ...base, testMatch: ["whole-order.spec.ts", "order-centers.spec.ts", "order-review.spec.ts"], grep: /whole order|fulfillment configuration|six centers|review stays|successful saves|saving locks|direct order link|store deep link/, workers: 1, outputDir: "../../tmp/whole-order-e2e",
  webServer: servers.map((server, index) => index === 0 ? { ...server, url: "http://127.0.0.1:8114/health", env: { ...server.env, PORT: "8114", API_BASE_URL: "http://127.0.0.1:8114" } }
    : { ...server, env: { ...server.env, API_BASE_URL: "http://127.0.0.1:8114" } }),
});
