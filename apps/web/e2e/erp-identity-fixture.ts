import { expect, type Page } from "@playwright/test";
import { createRequire } from "node:module";
import { factoryControl } from "./factory-portal-fixture";
import { createEntityId } from "@yummyai/contracts";
export const actors = () =>
  JSON.parse(process.env.ERP_FIXTURE_ACTORS!) as Record<
    "operator" | "readonly" | "outsider",
    { roleId: string; membershipId: string; userId: string; tenantId: string }
  >;
export async function loginErp(page: Page, account = "operator", returnTo = "/products") {
  await page.goto(`/login?${new URLSearchParams({ returnTo })}`);
  await page.getByRole("link", { name: "使用运营账户登录" }).click();
  await expect(page.getByRole("heading", { name: "Synthetic identity fixture" })).toBeVisible();
  await page.getByLabel("Test account").selectOption(account);
  await page.getByRole("button", { name: "Continue synthetic login" }).click();
  if (account === "main") {
    await expect(page.getByRole("heading", { name: "登录运营工作台" })).toBeVisible();
    return;
  }
  await expect(page.getByRole("button", { name: "退出登录", exact: true })).toBeVisible();
}
export async function changeErpRights(account: "operator" | "readonly", permissions: string[]) {
  const url = new URL(process.env.DATABASE_URL!);
  if (
    process.env.E2E_ISOLATED_DAILY !== "1" ||
    !/^\/order_daily_e2e_[a-f0-9]{32}$/.test(url.pathname)
  )
    throw Error("Disposable identity fixture required");
  const require = createRequire(
      new URL("../../../packages/database/package.json", import.meta.url),
    ),
    database = require("postgres")(url.toString(), { max: 1 });
  try {
    const updated =
      await database`update roles set permissions=${database.json(permissions)} where id=${actors()[account].roleId} and tenant_id=${actors()[account].tenantId} returning jsonb_typeof(permissions) as shape`;
    if (updated.length !== 1 || updated[0].shape !== "array")
      throw Error("Role fixture must retain an array of permissions");
  } finally {
    await database.end();
  }
}
export { factoryControl as identityControl };

/** Mutable synthetic role, owned solely by a disposable personal-identity test. */
export async function productWriterRole(scope: "self" | "team" | "tenant") {
  return scopedErpRole(["product:write"], scope);
}
export async function scopedErpRole(permissions: string[], scope: "self" | "team" | "tenant") {
  const url = new URL(process.env.DATABASE_URL!);
  if (
    process.env.E2E_ISOLATED_DAILY !== "1" ||
    !/^\/order_daily_e2e_[a-f0-9]{32}$/.test(url.pathname)
  )
    throw Error("Disposable role scope fixture required");
  const require = createRequire(
      new URL("../../../packages/database/package.json", import.meta.url),
    ),
    database = require("postgres")(url.toString(), { max: 1 }),
    id = createEntityId(),
    actor = actors().readonly;
  try {
    await database.begin(async (sql: typeof database) => {
      await sql`insert into roles(id,tenant_id,name,permissions,data_scope) values(${id},${actor.tenantId},${"Synthetic scoped role " + id},${sql.json(permissions)},${scope})`;
      await sql`insert into membership_roles(tenant_id,membership_id,role_id) values(${actor.tenantId},${actor.membershipId},${id})`;
    });
  } finally {
    await database.end();
  }
  async function connection<T>(operation: (sql: typeof database) => Promise<T>) {
    const sql = require("postgres")(url.toString(), { max: 1 });
    try {
      return await operation(sql);
    } finally {
      await sql.end();
    }
  }
  return {
    setScope: (next: "self" | "tenant") =>
      connection(async (sql) => {
        const rows =
          await sql`update roles set data_scope=${next} where id=${id} and tenant_id=${actor.tenantId} returning id`;
        if (rows.length !== 1) throw Error("Synthetic writer role missing");
      }),
    remove: () =>
      connection(async (sql) => {
        await sql.begin(async (tx: typeof database) => {
          await tx`delete from membership_roles where tenant_id=${actor.tenantId} and membership_id=${actor.membershipId} and role_id=${id}`;
          await tx`delete from roles where tenant_id=${actor.tenantId} and id=${id}`;
        });
      }),
  };
}
