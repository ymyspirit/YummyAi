import {defineConfig} from "@playwright/test";
import identity from "./playwright.erp-identity.config";
if(process.env.E2E_ADVERTISING_COMMAND_ISOLATED!=="1")throw new Error("Use the dedicated disposable advertising-command-browser runner");
const port=Number(process.env.E2E_ADVERTISING_COMMAND_API_PORT);
if(!Number.isInteger(port)||port<1025||port>65535||[3000,8000,4177,3130,8130].includes(port))throw new Error("A dedicated loopback disposable API port is required");
const api=`http://127.0.0.1:${port}`;
process.env.API_BASE_URL=api;
const servers=Array.isArray(identity.webServer)?identity.webServer:[];
export default defineConfig({...identity,testMatch:["advertising-command.spec.ts"],grep:undefined,
  webServer:servers.map(server=>({...server,...(String(server.url).includes(":8130")?{url:api+"/health"}:{}),
    env:{...server.env,API_BASE_URL:api,PORT:String(port)},
  }))});
