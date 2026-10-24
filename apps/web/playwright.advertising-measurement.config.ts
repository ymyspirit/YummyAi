import {defineConfig} from "@playwright/test";
import identity from "./playwright.erp-identity.config";
if(process.env.E2E_ADVERTISING_MEASUREMENT_ISOLATED!=="1")throw new Error("Use the dedicated disposable advertising-measurement-browser runner");
export default defineConfig({...identity,testMatch:["advertising-measurement.spec.ts"],grep:undefined});
