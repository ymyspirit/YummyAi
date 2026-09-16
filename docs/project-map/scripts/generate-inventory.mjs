// Documentation-only static inventory. Run from the repository with Node 24.
import console from "node:console";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import ts from "typescript";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const out = path.join(root, "docs/project-map/generated");
const normalize = (value) => value.replaceAll("\\", "/");
const relative = (value) => normalize(path.relative(root, value));
const read = (value) => fs.readFileSync(path.join(root, value), "utf8");
const ignored = new Set(["node_modules", ".next", ".output", ".wxt", "dist", "coverage", "vendor"]);
function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (ignored.has(entry.name)) return [];
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [relative(full)];
  }).sort();
}
const files = ["apps", "packages"].flatMap((dir) => walk(path.join(root, dir)));
const sources = files.filter((file) => /\.[cm]?[jt]sx?$/.test(file) && !file.endsWith(".d.ts"));
const isTest = (file) => /(?:\.test\.|\.spec\.|\/e2e\/)/.test(file);
const isTestFile = (file) => /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file);
const permissionValues = Object.fromEntries([...read("packages/authz/src/permissions.ts").matchAll(/^\s+(\w+):\s*"([^"]+)"/gm)].map((match) => ["Permission." + match[1], match[2]]));
const sf = (file) => ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
const line = (node, source) => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
const decorators = (node) => ts.canHaveDecorators(node) ? ts.getDecorators(node) ?? [] : [];
function decorator(node, name) {
  return decorators(node).map((item) => item.expression).find((item) => ts.isCallExpression(item) && item.expression.getText() === name);
}
function strings(node) {
  if (!node) return [];
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return [node.text];
  if (ts.isArrayLiteralExpression(node)) return node.elements.flatMap(strings);
  return [];
}
const appModule = sf("apps/api/src/app.module.ts");
const registration = [];
function visitRegistrations(node) {
  if (ts.isPropertyAssignment(node) && node.name.getText() === "controllers" && ts.isArrayLiteralExpression(node.initializer)) {
    registration.push(...node.initializer.elements.map((element) => element.getText()));
  }
  ts.forEachChild(node, visitRegistrations);
}
visitRegistrations(appModule);
const controllers = [];
const tables = [];
const services = [];
const imports = [];
const sourceMetrics = [];
const environmentNames = new Set();
for (const file of sources) {
  const source = sf(file);
  const text = source.text;
  sourceMetrics.push({ file, lines: text.split(/\r?\n/).length, test: isTest(file) });
  if (isTest(file)) continue;
  for (const match of text.matchAll(/process\.env\.([A-Z][A-Z0-9_]+)/g)) environmentNames.add(match[1]);
  for (const node of source.statements) {
    if (ts.isImportDeclaration(node)) {
      const imported = node.moduleSpecifier.text;
      imports.push({ file, from: imported, symbols: node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings) ? node.importClause.namedBindings.elements.map((el) => (el.propertyName ?? el.name).text) : [] });
    }
    if (ts.isClassDeclaration(node)) {
      const name = node.name?.text;
      if (file.startsWith("apps/api/src/") && (file.endsWith(".service.ts") || file.endsWith(".repository.ts"))) {
        services.push({ name, file, line: line(node, source), methods: node.members.filter(ts.isMethodDeclaration).map((method) => ({ name: method.name.getText(), line: line(method, source) })) });
      }
      const route = decorator(node, "Controller");
      if (!route) continue;
      const prefixes = strings(route.arguments[0]);
      const endpoints = [];
      for (const member of node.members.filter(ts.isMethodDeclaration)) {
        for (const verb of ["Get", "Post", "Put", "Patch", "Delete", "Options", "Head", "All", "Sse"]) {
          const call = decorator(member, verb);
          if (!call) continue;
          for (const prefix of prefixes.length ? prefixes : [""]) {
            for (const suffix of strings(call.arguments[0]).length ? strings(call.arguments[0]) : [""]) {
              endpoints.push({ verb: verb.toUpperCase(), path: ("/" + prefix + "/" + suffix).replace(/\/+/g, "/").replace(/\/$/, "") || "/", handler: member.name.getText(), line: line(member, source), permissions: decorator(member, "RequiresPermission")?.arguments.map((argument) => permissionValues[argument.getText()] ?? strings(argument)[0] ?? argument.getText()) ?? [] });
            }
          }
        }
      }
      controllers.push({ name, file, line: line(node, source), registered: registration.includes(name), prefixes, endpoints });
    }
  }
  if (file.startsWith("packages/database/src/schema/")) {
    function visitTables(node) {
      if (ts.isVariableDeclaration(node) && node.initializer) {
        let call;
        function find(value) { if (ts.isCallExpression(value) && value.expression.getText() === "pgTable") call = value; else ts.forEachChild(value, find); }
        find(node.initializer);
        if (call) {
          const columnNode = call.arguments[1];
          const columns = columnNode && ts.isObjectLiteralExpression(columnNode) ? columnNode.properties.filter(ts.isPropertyAssignment).map((column) => ({ property: column.name.getText(), definition: column.initializer.getText().replace(/\s+/g, " ") })) : [];
          const refs = [...node.initializer.getText().matchAll(/(?:references\(\(\)\s*=>\s*|foreignColumns:\s*\[)([\w.]+)/g)].map((match) => match[1]);
          tables.push({ symbol: node.name.getText(), name: strings(call.arguments[0])[0], file, line: line(node, source), tenantScoped: columns.some((column) => column.property === "tenantId"), columns, references: [...new Set(refs)] });
        }
      }
      ts.forEachChild(node, visitTables);
    }
    visitTables(source);
  }
}
const pages = sources.filter((file) => file.startsWith("apps/web/src/app/") && file.endsWith("/page.tsx")).map((file) => {
  const redirect = [];
  function visit(node) {
    if (ts.isCallExpression(node) && node.expression.getText() === "redirect") redirect.push(node.arguments[0]?.getText().replace(/\s+/g, " ") ?? "dynamic");
    ts.forEachChild(node, visit);
  }
  visit(sf(file));
  return { file, path: "/" + file.replace(/^apps\/web\/src\/app\//, "").replace(/page\.tsx$/, "").split("/").filter((part) => part && !part.startsWith("(")).join("/"), redirect, featureImports: imports.filter((item) => item.file === file && item.from.includes("features/")).map((item) => item.from) };
});
const webHandlers = sources.filter((file) => file.startsWith("apps/web/src/app/") && file.endsWith("/route.ts")).map((file) => ({ file, path: "/" + file.replace(/^apps\/web\/src\/app\//, "").replace(/\/route\.ts$/, "").split("/").filter((part) => !part.startsWith("(")).join("/"), verbs: [...read(file).matchAll(/export\s+(?:async\s+)?function\s+(GET|POST|PATCH|PUT|DELETE|OPTIONS|HEAD)\b/g)].map((match) => match[1]) }));
const queueSource = read("packages/jobs/src/queues.ts");
const workerSource = read("apps/worker/src/run.ts");
const queues = [...queueSource.matchAll(/^\s+(\w+):\s*"([^"]+)"/gm)].map((match) => ({ key: match[1], name: match[2], registeredInRun: new RegExp("createWorker\\(\\s*QueueName\\." + match[1] + "\\s*,").test(workerSource) }));
const packages = files.filter((file) => /^(?:apps|packages)\/[^/]+\/package.json$/.test(file)).map((file) => {
  const data = JSON.parse(read(file));
  return { file, name: data.name, scripts: data.scripts ?? {}, workspaceDependencies: Object.keys({ ...data.dependencies, ...data.devDependencies }).filter((key) => key.startsWith("@yummyai/")) };
});
const migrations = walk(path.join(root, "packages/database")).filter((file) => file.endsWith(".sql") && /migrations\//.test(file));
const moduleDirectories = [...new Set(sources.filter((file) => file.startsWith("apps/api/src/") && file.split("/").length > 4).map((file) => file.split("/")[3]))].sort();
const sourceHash = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const branch = execFileSync("git", ["branch", "--show-current"], { cwd: root, encoding: "utf8" }).trim();
const sourceStatus = execFileSync("git", ["status", "--porcelain", "--", "apps", "packages", "infra", "tools", "package.json", "pnpm-lock.yaml"], { cwd: root, encoding: "utf8" }).trim();
const data = { baseline: { date: new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai" }).format(new Date()), commit: sourceHash, branch, sourceWorktreeClean: !sourceStatus, scope: "Static source inventory; definitions/registration do not prove live runtime or marketplace acceptance. Table columns describe Drizzle declarations, not a database introspection. Test counts are files, not passed cases. Tests include apps/packages test/spec files only; tools/tests and Python tests are outside this count." }, counts: { workspaces: packages.length, apiDirectories: moduleDirectories.length, pages: pages.length, webRouteHandlers: webHandlers.length, controllers: controllers.length, registeredControllers: controllers.filter((item) => item.registered).length, endpointDefinitions: controllers.reduce((n, item) => n + item.endpoints.length, 0), registeredEndpointDefinitions: controllers.filter((item) => item.registered).reduce((n, item) => n + item.endpoints.length, 0), tables: tables.length, migrations: migrations.length, queues: queues.length, queuesRegisteredInRun: queues.filter((item) => item.registeredInRun).length, testFiles: sources.filter(isTestFile).length }, packages, apiDirectories: moduleDirectories, pages, webHandlers, controllers, services, tables, queues, migrations, imports, sourceMetrics, environmentNames: [...environmentNames].sort() };
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, "inventory.json"), JSON.stringify(data, null, 2) + "\n");
const link = (file, label = file) => `[${label}](../../../${file})`;
const rows = (items) => items.map((cells) => "| " + cells.join(" | ") + " |").join("\n");
const preface = (title) => `# ${title}\n\n自动生成于代码基线 \`${sourceHash}\`。这是静态清单，不表示运行时可用或验收通过。更新命令：\`node docs/project-map/scripts/generate-inventory.mjs\`。\n\n[返回项目地图](../README.md)\n\n`;
fs.writeFileSync(path.join(out, "routes.md"), preface("页面与 Web 代理路由清单") + "## 页面\n\n| 路径 | 源码 | 静态重定向 |\n| --- | --- | --- |\n" + rows(pages.map((item) => ["`" + item.path + "`", link(item.file), item.redirect.join(", ") || "—"])) + "\n\n## Web 路由处理器\n\n| 路径 | HTTP 方法 | 源码 |\n| --- | --- | --- |\n" + rows(webHandlers.map((item) => ["`" + item.path + "`", item.verbs.join(", "), link(item.file)])) + "\n");
fs.writeFileSync(path.join(out, "api.md"), preface("API 控制器与接口清单") + "注册列仅核对当前 `AppModule.controllers`。未注册定义不能当成可访问接口；已注册仍需启动、鉴权和集成验收。SSE 是 Nest 装饰器名，实际传输为 GET。权限列列出方法级 `RequiresPermission` 并解析 Permission 常量，空值不代表匿名开放，全局 Guard 仍适用。\n\n" + controllers.map((item) => `## ${item.name}\n\n源码：${link(item.file)}；AppModule 注册：**${item.registered ? "是" : "否"}**。\n\n| 方法 | 路径 | 处理方法 | 行号 | 方法级权限 |\n| --- | --- | --- | --- | --- |\n` + rows(item.endpoints.map((ep) => [ep.verb, "`" + ep.path + "`", "`" + ep.handler + "`", ep.line, ep.permissions.join(", ") || "见源码/全局 Guard"])) + "\n").join("\n"));
fs.writeFileSync(path.join(out, "tables.md"), preface("数据库表目录") + "表名来自 Drizzle `pgTable()` 声明。`tenantId` 列不等同于 RLS 已生效；实际策略、复合外键与写权限必须结合迁移核对。完整列定义在 inventory.json；这里的引用只作导航，不是完整 ERD。\n\n| 表名 | TS 导出 | 有 tenantId | 源文件 | 行号 |\n| --- | --- | --- | --- | --- |\n" + rows(tables.map((item) => ["`" + item.name + "`", "`" + item.symbol + "`", item.tenantScoped ? "是" : "否", link(item.file), item.line])) + "\n");
fs.writeFileSync(path.join(out, "queues.md"), preface("异步队列目录") + "启动引用只检查 `apps/worker/src/run.ts` 的 `createWorker()` 调用。配置开关可能阻止实际注册；队列常量、处理器文件、消费者启动是三个不同层次。\n\n| 常量 | 队列名 | run.ts 中有启动调用 |\n| --- | --- | --- |\n" + rows(queues.map((item) => [item.key, "`" + item.name + "`", item.registeredInRun ? "是，需进一步检查条件" : "未发现"])) + "\n");
console.log(JSON.stringify({ baseline: data.baseline, counts: data.counts, unregisteredControllers: controllers.filter((item) => !item.registered).map((item) => item.name), queuesWithoutStartup: queues.filter((item) => !item.registeredInRun).map((item) => item.name), largestSourceFiles: sourceMetrics.filter((item) => !item.test).sort((a,b) => b.lines-a.lines).slice(0,12) }, null, 2));
