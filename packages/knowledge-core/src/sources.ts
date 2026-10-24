import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { request } from "node:https";
import { and, eq, isNull, sql } from "drizzle-orm";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import {
  knowledgeSources as sources,
  knowledgeSourceSnapshots as snapshots,
  knowledgeSourceReviews as reviews,
  knowledgeSourceChecks as checks,
  knowledgeEntries as entries,
  knowledgeVersions as versions,
  knowledgeDocuments as documents,
  withTenant,
  type DatabaseConnection,
} from "@yummyai/database";
import { knowledgeChecksum, redactKnowledgeText } from "./documents.js";

export function knowledgePublicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b] = address.split(".").map(Number) as [number, number];
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && [0, 168].includes(b)) ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 198 && [18, 19, 51].includes(b)) ||
      (a === 203 && b === 0)
    );
  }
  if (isIP(address) === 6) {
    const lower = address.toLowerCase();
    return /^[23][0-9a-f]{3}:/.test(lower) && !/^2001:(?:0:|:|db8:|10:|20:)|^2002:/.test(lower);
  }
  return false;
}
export function knowledgeOfficialUrl(value: string) {
  const url = new URL(value);
  if (
    [...url.searchParams.keys()].some((k) =>
      /token|secret|password|cookie|api[-_]?key|signature|credential/i.test(k),
    )
  )
    throw new Error("来源不能包含访问凭证或签名链接");
  if (
    url.protocol !== "https:" ||
    (url.port && url.port !== "443") ||
    url.username ||
    url.password ||
    url.hash ||
    isIP(url.hostname.replace(/^\[|\]$/g, "")) ||
    !url.hostname.includes(".") ||
    /(?:^|\.)(?:localhost|local|internal|test|invalid)$/i.test(url.hostname)
  )
    throw new Error("来源必须是公开 HTTPS 域名，不能包含凭证、端口或本机地址");
  return url;
}
export function normalizeKnowledgeHtml(html: string) {
  let value = html.replace(
    /<(script|style|nav|header|footer|aside|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,
    "",
  );
  value = /<(?:main|article)\b[^>]*>([\s\S]*?)<\/(?:main|article)\s*>/i.exec(value)?.[1] ?? value;
  return value
    .replace(/<\/(?:p|div|li|h[1-6]|tr|section|article)>|<br\s*\/?\s*>/gi, "\n")
    .replace(/<[^>]*>/g, " ")
    .replace(
      /&(?:nbsp|amp|lt|gt|quot|apos);/g,
      (s) =>
        ({ "&nbsp;": " ", "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'" })[
          s
        ]!,
    )
    .replace(/&#(x[0-9a-f]+|\d+);/gi, (_s, n: string) => {
      const c = n[0]?.toLowerCase() === "x" ? parseInt(n.slice(1), 16) : parseInt(n, 10);
      return c > 0 && c <= 0x10ffff ? String.fromCodePoint(c) : "";
    })
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n\n");
}
export async function readKnowledgeOfficialSource(
  value: string,
): Promise<{ url: string; body: string }> {
  const initial = knowledgeOfficialUrl(value);
  let url = initial;
  const expires = Date.now() + 12_000;
  for (let redirect = 0; redirect <= 3; redirect++) {
    const remaining = expires - Date.now();
    if (remaining <= 0) throw new Error("官方来源读取超时");
    const resolved = await new Promise<Awaited<ReturnType<typeof lookup>>[]>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("官方来源域名解析超时")), remaining);
      lookup(url.hostname, { all: true })
        .then(resolve, reject)
        .finally(() => clearTimeout(timer));
    });
    if (!resolved.length || resolved.some((r) => !knowledgePublicAddress(r.address)))
      throw new Error("来源域名指向非公开地址，已阻止读取");
    const chosen = resolved[0]!;
    const response = await new Promise<{
      status: number;
      location?: string;
      type: string;
      body: Buffer;
    }>((resolve, reject) => {
      const req = request(
        url,
        {
          method: "GET",
          headers: {
            Accept: "text/html,text/plain",
            "Accept-Encoding": "identity",
            "User-Agent": "YummyAI-Knowledge/1.0",
          },
          // Pin the validated DNS answer for the connection, including redirects.
          lookup: (_host, options, callback) => {
            if (options.all) callback(null, [chosen]);
            else callback(null, chosen.address, chosen.family);
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          let bytes = 0;
          res.on("data", (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > 2_000_000) req.destroy(new Error("来源正文超过 2 MB 限制"));
            else chunks.push(chunk);
          });
          res.once("error", reject);
          res.once("end", () =>
            resolve({
              status: res.statusCode ?? 0,
              ...(res.headers.location ? { location: res.headers.location } : {}),
              type: String(res.headers["content-type"] ?? ""),
              body: Buffer.concat(chunks),
            }),
          );
          if (res.headers["content-encoding"] && res.headers["content-encoding"] !== "identity")
            req.destroy(new Error("来源未返回可检查的普通正文"));
        },
      );
      const timer = setTimeout(
        () => req.destroy(new Error("官方来源读取超时")),
        Math.max(1, expires - Date.now()),
      );
      req.once("error", reject);
      req.once("close", () => clearTimeout(timer));
      req.end();
    });
    if ([301, 302, 303, 307, 308].includes(response.status) && response.location) {
      const next = knowledgeOfficialUrl(new URL(response.location, url).href);
      if (next.hostname !== initial.hostname)
        throw new Error("来源跳转到未登记域名；请核对后登记最终地址");
      url = next;
      continue;
    }
    if (response.status !== 200) throw new Error(`官方来源读取失败（HTTP ${response.status}）`);
    if (!/^text\/(?:html|plain)\b/i.test(response.type))
      throw new Error("来源仅支持公开 HTML 或纯文本页面");
    const charset = /charset\s*=\s*([\w-]+)/i.exec(response.type)?.[1] ?? "utf-8";
    const raw = new TextDecoder(charset, { fatal: true }).decode(response.body);
    const body = redactKnowledgeText(
      /^text\/html/i.test(response.type)
        ? normalizeKnowledgeHtml(raw)
        : raw.replace(/\r\n?/g, "\n").trim(),
    ).text;
    if (!body || body.length > 200_000) throw new Error("来源没有可读取正文或正文超过 20 万字符");
    return { url: url.href, body };
  }
  throw new Error("官方来源跳转次数超过限制");
}
export async function checkKnowledgeSource(
  database: DatabaseConnection,
  context: TenantContext,
  id: string,
  reader = readKnowledgeOfficialSource,
) {
  const started = new Date();
  const source = await withTenant(database.db, context, async (tx) => {
    const [row] = await tx
      .select()
      .from(sources)
      .where(and(eq(sources.id, id), isNull(sources.archivedAt)))
      .for("update");
    if (!row) throw new Error("来源不存在");
    if (row.lastCheckedAt && started.getTime() - row.lastCheckedAt.getTime() < 60_000)
      throw new Error("来源一分钟内已检查，请稍后再试");
    await tx
      .update(sources)
      .set({
        lastCheckedAt: started,
        nextCheckAt: new Date(started.getTime() + row.checkEveryHours * 3600_000),
      })
      .where(eq(sources.id, id));
    return row;
  });
  let fetched: { url: string; body: string } | null = null,
    diagnostic = "";
  try {
    fetched = await reader(source.url);
  } catch (error) {
    diagnostic =
      error instanceof Error && /^(来源|官方来源)/.test(error.message)
        ? error.message.slice(0, 240)
        : "官方来源读取或解析失败；原有效证据和核对时间未变更";
  }
  return withTenant(database.db, context, async (tx) => {
    const [current] = await tx.select().from(sources).where(eq(sources.id, id)).for("update");
    if (!current || current.lastCheckedAt?.getTime() !== started.getTime())
      return { changed: false, diagnostic: "来源检查已被后续任务取代" };
    if (!fetched) {
      await tx.update(sources).set({ lastError: diagnostic }).where(eq(sources.id, id));
      await tx.insert(checks).values({
        id: createEntityId(),
        tenantId: context.tenantId,
        sourceId: id,
        result: "failed",
        diagnostic,
      });
      return { changed: false, diagnostic };
    }
    const [previous] = current.latestSnapshotId
      ? await tx.select().from(snapshots).where(eq(snapshots.id, current.latestSnapshotId))
      : [];
    const snapshotId = createEntityId(),
      checksum = knowledgeChecksum(fetched.body),
      now = new Date();
    await tx.insert(snapshots).values({
      id: snapshotId,
      tenantId: context.tenantId,
      sourceId: id,
      url: fetched.url,
      body: fetched.body,
      checksum,
      validUntil: new Date(now.getTime() + source.freshnessDays * 86400_000),
    });
    const changed = !!previous && previous.checksum !== checksum;
    if (changed) {
      const previousAnchors = new Set(
        (
          await tx.select({ id: snapshots.id }).from(snapshots).where(eq(snapshots.sourceId, id))
        ).map((row) => row.id),
      );
      const affected = await tx
        .select({ id: entries.id, fields: versions.fields })
        .from(entries)
        .innerJoin(
          versions,
          and(eq(versions.entryId, entries.id), eq(versions.version, entries.activeVersion)),
        )
        .where(isNull(entries.archivedAt));
      await tx.insert(reviews).values({
        id: createEntityId(),
        tenantId: context.tenantId,
        sourceId: id,
        beforeSnapshotId: previous.id,
        afterSnapshotId: snapshotId,
        entryIds: affected
          .filter(
            (row) =>
              row.fields.sourceUrl === source.url ||
              row.fields.sourceSnapshotIds?.some((anchor) => previousAnchors.has(anchor)),
          )
          .map((row) => row.id),
      });
    }
    await tx
      .update(sources)
      .set({ latestSnapshotId: snapshotId, lastSuccessAt: now, lastError: null })
      .where(eq(sources.id, id));
    await tx.insert(checks).values({
      id: createEntityId(),
      tenantId: context.tenantId,
      sourceId: id,
      result: changed ? "changed" : "unchanged",
      diagnostic: "",
      snapshotId,
    });
    return { changed, snapshotId, diagnostic: "" };
  });
}
export async function purgeKnowledgeOriginals(
  database: DatabaseConnection,
  context: TenantContext,
) {
  return withTenant(database.db, context, (tx) =>
    tx
      .update(documents)
      .set({ encryptedOriginal: null, encryptedParsed: null })
      .where(
        and(
          sql`${documents.rawExpiresAt}<=now()`,
          sql`(${documents.encryptedOriginal} IS NOT NULL OR ${documents.encryptedParsed} IS NOT NULL)`,
        ),
      )
      .returning({ id: documents.id }),
  );
}
