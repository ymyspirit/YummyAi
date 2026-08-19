import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { getDatabaseUrl } from "./database-url.js";
import * as schema from "./schema/index.js";

export type Database = PostgresJsDatabase<typeof schema>;
export type DatabaseClient = ReturnType<typeof postgres>;

export interface DatabaseConnection {
  db: Database;
  client: DatabaseClient;
}

export function connectDatabase(databaseUrl = getDatabaseUrl()): DatabaseConnection {
  const client = postgres(databaseUrl, {
    max: Number.parseInt(process.env.DATABASE_POOL_SIZE ?? "10", 10),
    prepare: false,
  });

  return {
    client,
    db: drizzle(client, { schema }),
  };
}
