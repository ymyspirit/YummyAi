import "reflect-metadata";

import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";

import { AppModule } from "./app.module.js";

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { cors: false });
  // Asset uploads are JSON/base64. A 20 MB binary expands to about 26.7 MB,
  // so keep the transport limit aligned with the design UI's 20 MB file gate.
  app.useBodyParser("json", { limit: "28mb" });
  app.useBodyParser("urlencoded", { extended: true, limit: "28mb" });
  app.enableCors({
    allowedHeaders: ["Authorization", "Content-Type"],
    methods: ["GET", "POST", "PATCH", "OPTIONS"],
    origin: process.env.WEB_ORIGIN ?? "http://localhost:3000",
  });
  app.enableShutdownHooks();

  const port = Number.parseInt(process.env.PORT ?? "8000", 10);
  // Local extension uploads arrive through the Web proxy, so the API remains loopback-only.
  await app.listen(port, "127.0.0.1");
  Logger.log(`YummyAI API listening on http://127.0.0.1:${port}`, "Bootstrap");
}

void bootstrap();
