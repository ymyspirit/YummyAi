import { defineConfig } from "@playwright/test";
import identity from "./playwright.erp-identity.config";

if (process.env.E2E_ADVERTISING_AUTHORITY_ISOLATED !== "1")
  throw new Error("Use the dedicated disposable advertising-authority-browser runner");
export default defineConfig({ ...identity, testMatch: ["advertising-authority.spec.ts"], grep: undefined });
