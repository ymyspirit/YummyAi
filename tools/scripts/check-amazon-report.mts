/** Read-only acceptance: emit counts only; never persist buyer data or ZIP bytes. */
import { readFile } from "node:fs/promises";
import { parseAmazonOrderReport } from "../../apps/api/src/orders/amazon-report-parser.js";
import { parseAmazonCustomArchive } from "../../apps/api/src/orders/amazon-custom-archive.js";
import { AmazonArchiveAccessError, HttpAmazonReportArchiveGateway } from "../../apps/api/src/orders/amazon-report-archive.gateway.js";

const path = process.argv[2];
if (!path) throw new Error("Pass a local Amazon order report path");
const report = parseAmazonOrderReport(await readFile(path, "utf8"));
const gateway = new HttpAmazonReportArchiveGateway();
let passed = 0, failed = 0, previews = 0, images = 0, fields = 0;
for (const order of report.orders) {
  for (const line of order.lines) {
    if (!line.customizedUrl) continue;
    try {
      const bytes = await gateway.download(line.customizedUrl);
      const scan = await gateway.scan(bytes);
      if (scan.result !== "clean") throw new Error("scan_not_clean");
      const parsed = await parseAmazonCustomArchive(bytes, { externalOrderId: order.externalOrderId, externalLineId: line.externalLineId });
      previews += parsed.document.surfaces.filter((surface) => surface.previewFileKey).length;
      images += parsed.document.surfaces.reduce((total, surface) => total + surface.buyerFileKeys.length, 0);
      fields += parsed.document.surfaces.reduce((total, surface) => total + surface.fields.length, 0);
      passed++;
    } catch (error) {
      failed++;
      // Known parser messages are static, but network exceptions can contain a private URL.
      console.log(JSON.stringify({ inspected: passed + failed, result: "failed", errorType: error instanceof Error ? error.name : "unknown", code: error instanceof AmazonArchiveAccessError ? error.code : "parse_or_scan_failed" }));
    }
  }
}
console.log(JSON.stringify({ orders: report.orders.length, rows: report.rowCount, passed, failed, previews, images, fields }));
if (failed) process.exitCode = 1;
