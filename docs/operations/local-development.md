# Local development

## Prerequisites

- Node.js 24.17.x and pnpm 11.10.x
- Docker Desktop with Compose v2
- Chrome or Edge for extension smoke tests

## Start

```powershell
Copy-Item .env.example .env
docker compose --env-file .env -f infra/docker-compose.yml up -d
pnpm install --frozen-lockfile
pnpm --filter @yummyai/database db:migrate
pnpm dev
```

Default endpoints are PostgreSQL `5432`, Redis `6379`, MinIO `9000/9001`, Keycloak `8081`, and OTLP `4317/4318`. Change host ports in `.env` when they collide; keep container ports unchanged.

## Health and diagnostics

```powershell
docker compose --env-file .env -f infra/docker-compose.yml ps
docker compose --env-file .env -f infra/docker-compose.yml logs --tail=100 postgres redis minio keycloak otel-collector
pnpm --filter @yummyai/database exec drizzle-kit check
```

Use `DASHBOARD_DEMO_MODE=1`, `ANALYSIS_DEMO_MODE=1`, `PRODUCT_DEMO_MODE=1`, `DESIGN_DEMO_MODE=1`, and `LISTING_DEMO_MODE=1` only for UI development. Never set demo flags in deployed environments.

## Verification

```powershell
pnpm lint
pnpm typecheck
pnpm test
pnpm test:integration
pnpm test:e2e
pnpm build
```

The extension build is in `apps/extension/.output/chrome-mv3`. Run `pnpm --filter @yummyai/extension zip` to produce Chrome and Edge packages.
