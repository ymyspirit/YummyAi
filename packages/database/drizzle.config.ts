import { defineConfig } from "drizzle-kit";

import { getDatabaseUrl } from "./src/database-url.js";

export default defineConfig({
  dialect: "postgresql",
  dbCredentials: {
    url: getDatabaseUrl(),
  },
  out: "./migrations",
  schema: "./src/schema/*.ts",
  strict: true,
  verbose: true,
});
