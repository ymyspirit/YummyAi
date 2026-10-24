import {defineConfig} from "@playwright/test";
import identity from "./playwright.erp-identity.config";
if(process.env.E2E_ADVERTISING_HISTORY_ISOLATED!=="1")throw new Error("Use the dedicated disposable advertising-history-browser runner");
export default defineConfig({...identity,testMatch:["advertising-history.spec.ts"],grep:undefined});
