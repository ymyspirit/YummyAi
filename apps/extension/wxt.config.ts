import { defineConfig } from "wxt";

export default defineConfig({
  srcDir: "src",
  modules: ["@wxt-dev/module-react"],
  dev: {
    server: {
      origin: "http://localhost:3001",
      port: 3001,
      strictPort: true,
    },
  },
  manifest: {
    key: "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAnqL25TeKJDdxLy8ocrV1RMtHTq+h95GZ7PJjO68RbCLhKiRJQISBkEVg6FSyhX+xN8nwRRy2nAiOmefvRf0EMR5q0H5vvGbwMKV6+NHsTIREANgmpzcL3dvnPHzZo9XzEta/YLybGfcw1iWwMvjpPHHLauFdc2biS41IN3WFkmzgjjc+x/uofgEUcONCjaO/fqR8aQaBrNfMDZxZPtr7wUVT744trOEvPPRr8NXSngmzw+S5Wd5t1r29ANPV+RSiUOCQjIAklp8CNQJ9Qt1KzOSKN9MKoPrW975xOx68zTH44UOhw3ztqY8UPqViRYsKY6AMxkz2NwKcQmakLHDBoQIDAQAB",
    name: "YummyAI Capture",
    description: "Capture public Amazon and Etsy product evidence into YummyAI.",
    permissions: ["activeTab", "identity", "storage"],
    host_permissions: [
      "http://localhost:3000/*",
      "http://localhost:8000/*",
      "http://localhost:8081/*",
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
