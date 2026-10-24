import {defineConfig} from "vitest/config";
import {requireAmazonPublicNodeEnvironment} from "../../tools/testing/amazon-public-node-environment.mjs";
requireAmazonPublicNodeEnvironment();
export default defineConfig({test:{include:["src/marketplaces/amazon-public-node.integration.test.ts"],environment:"node",maxWorkers:1,hookTimeout:120000,testTimeout:180000,sequence:{concurrent:false}}});
