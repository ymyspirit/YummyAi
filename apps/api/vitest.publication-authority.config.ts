import {defineConfig} from "vitest/config";
import {requirePublicationAuthorityEnvironment} from "../../tools/testing/publication-authority-environment.mjs";
requirePublicationAuthorityEnvironment();
export default defineConfig({test:{include:["src/marketplaces/publication-authority.integration.test.ts"],environment:"node",maxWorkers:1,
 hookTimeout:120000,testTimeout:180000,sequence:{concurrent:false}}});
