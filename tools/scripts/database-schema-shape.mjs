import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inspectDatabaseSchemaShape, compareSchemaShapes, schemaShapeHash } from "../../packages/database/src/schema-shape.ts";
const require = createRequire(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../packages/database/package.json"));
const postgres = require("postgres");
export { compareSchemaShapes, schemaShapeHash };
export async function inspectSchemaShape(databaseUrl) {
  const client = postgres(databaseUrl, { max: 1, onnotice() {} });
  try { return await inspectDatabaseSchemaShape(client); }
  finally { await client.end(); }
}
