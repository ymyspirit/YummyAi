import {defineConfig} from "vitest/config";
import {requirePublicationNodeSubmitEnvironment} from "../../tools/testing/publication-node-submit-environment.mjs";
const legacy=process.env.E2E_LEGACY_SCHEMA_TARGET==="pre-0183";
requirePublicationNodeSubmitEnvironment(process.env,legacy?"pre-0183":"current");
export default defineConfig({test:{include:[legacy?"src/marketplaces/publication-node-submit-upgrade.integration.test.ts":"src/marketplaces/publication-node-submit.integration.test.ts"],environment:"node",maxWorkers:1,hookTimeout:120000,testTimeout:180000,sequence:{concurrent:false}}});
