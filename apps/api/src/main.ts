import "reflect-metadata";

import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";

import { AppModule } from "./app.module.js";

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { cors: false });
  app.enableCors({
    allowedHeaders: ["Authorization", "Content-Type"],
    methods: ["GET", "POST", "PATCH", "OPTIONS"],
    origin: process.env.WEB_ORIGIN ?? "http://localhost:3000",
  });
  app.enableShutdownHooks();

  const port = Number.parseInt(process.env.PORT ?? "8000", 10);
  await app.listen(port, "127.0.0.1");
  Logger.log(`YummyAI API listening on http://127.0.0.1:${port}`, "Bootstrap");
}

void bootstrap();
