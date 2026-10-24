import {defineConfig} from "@playwright/test";
import originals from "./playwright.finance-command.config";
if(process.env.E2E_FINANCE_COMMAND_RESULT_ISOLATED!=="1")throw new Error("Use the dedicated disposable finance-command-result-browser runner");
export default defineConfig({...originals,testMatch:["finance-command-result.spec.ts"],grep:undefined});
