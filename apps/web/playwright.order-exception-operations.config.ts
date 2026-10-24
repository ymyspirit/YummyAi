import { defineConfig } from "@playwright/test";
import base from "./playwright.order-responsibility.config";
export default defineConfig({...base,testMatch:["order-exception-operations.spec.ts"],outputDir:"../../tmp/order-exception-operations-e2e"});
