import { defineConfig } from "wxt";

export default defineConfig({
  srcDir: "src",
  modules: ["@wxt-dev/module-react"],
  manifest: {
    name: "YummyAI Capture",
    description: "Capture public Amazon and Etsy product evidence into YummyAI.",
    permissions: ["activeTab", "identity", "storage"],
    host_permissions: [
      "http://localhost:8000/*",
      "https://*.amazon.com/*",
      "https://*.amazon.co.uk/*",
      "https://*.amazon.ca/*",
      "https://*.amazon.de/*",
      "https://*.amazon.fr/*",
      "https://*.amazon.it/*",
      "https://*.amazon.es/*",
      "https://*.amazon.co.jp/*",
      "https://*.etsy.com/*",
    ],
    action: {
      default_title: "Capture with YummyAI",
    },
  },
});
