import { Controller, Get, Inject } from "@nestjs/common";
import type { DatabaseConnection } from "@yummyai/database";

import { Public } from "./auth/public.decorator.js";
import { DATABASE_CONNECTION } from "./platform.tokens.js";

@Controller("health")
export class HealthController {
  constructor(@Inject(DATABASE_CONNECTION) private readonly database: DatabaseConnection) {}

  @Get()
  @Public()
  async check() {
    await this.database.client`select 1`;
    return {
      database: "connected",
      service: "yummyai-api",
      status: "ok",
      timestamp: new Date().toISOString(),
    };
  }
}
