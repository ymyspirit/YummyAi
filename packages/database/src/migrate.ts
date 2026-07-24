import { fileURLToPath, pathToFileURL } from "node:url";

import { migrate } from "drizzle-orm/postgres-js/migrator";

import { connectDatabase, type DatabaseConnection } from "./client.js";

const migrationsFolder = fileURLToPath(new URL("../migrations", import.meta.url));

export async function migrateDatabase(connection: DatabaseConnection): Promise<void> {
  const lockConnection = await connection.client.reserve();
  try {
    await lockConnection.unsafe("select pg_advisory_lock(hashtextextended('yummyai-schema-migrations', 0))");
    await migrate(connection.db, { migrationsFolder });
  } finally {
    await lockConnection.unsafe("select pg_advisory_unlock(hashtextextended('yummyai-schema-migrations', 0))");
    await lockConnection.release();
  }
}

async function main(): Promise<void> {
  const connection = connectDatabase();

  try {
    await migrateDatabase(connection);
  } finally {
    await connection.client.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
