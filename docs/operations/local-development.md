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

## Extension smoke test

After changing a marketplace parser, rebuild the extension, click **Reload** for YummyAI Capture on `chrome://extensions`, and refresh the open Amazon or Etsy page before testing:

```powershell
pnpm --filter @yummyai/extension test
pnpm --filter @yummyai/extension build
```

In the popup, **重新读取** only refreshes the local preview. It does not create a research snapshot. Click **发送到研究库** and confirm that the research item gains a new version with the current parser version. For Etsy listing smoke tests, verify the preview includes the shop name, estimated delivery, shipping cost, origin, destination, listing date, and favorite count when those values are visible on the public page.
