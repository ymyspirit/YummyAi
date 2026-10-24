import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const repo = path.resolve(root, "../..");
const require = createRequire(path.join(repo, "package.json"));
const JSZip = require("jszip");
const metadata = JSON.parse(await fs.readFile(path.join(root, "blueprint-version.json"), "utf8"));
const updatedOn=metadata.updatedOn??metadata.date;
const output = `docs/YummyAI-ERP-Blueprint-v${metadata.version}-${updatedOn}.zip`;
const targets = new Set();
async function collect(directory) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) await collect(full);
    else targets.add(path.relative(repo, full).replaceAll("\\", "/"));
  }
}
await collect(root);

targets.add("docs/project-control/QUALITY_SCRAP_PROGRESS_20261021.md");
targets.add("docs/integration/quality-scrap.md");
const qualityScrapPrefix = "2026-10-21-quality-scrap-c54e17a8-";
const qualityScrapChanges = JSON.parse(await fs.readFile(path.join(repo, "docs/project-control/checkpoints/" + qualityScrapPrefix + "changed-scope-final.json"), "utf8"));
for (const target of [...qualityScrapChanges.added, ...qualityScrapChanges.changed]) {
  if (!/^(apps|packages|tools)\//.test(target) || target.split("/").includes("..") || target.includes("\\")) throw new Error("Unexpected quality scrap dependency");
  targets.add(target);
}
for (const entry of await fs.readdir(path.join(repo, "docs/project-control/checkpoints"), { withFileTypes: true })) {
  if (entry.isFile() && entry.name.startsWith(qualityScrapPrefix) && /\.(json|md|mts|mjs|ps1|py)$/.test(entry.name)) targets.add("docs/project-control/checkpoints/" + entry.name);
}

targets.add("docs/project-control/PRODUCTION_QUANTITY_PROGRESS_20261021.md");
targets.add("docs/integration/production-physical-quantities.md");
const productionQuantityPrefix = "2026-10-21-production-stop-b72e8c4a-";
const productionQuantityChanges = JSON.parse(await fs.readFile(path.join(repo, "docs/project-control/checkpoints/" + productionQuantityPrefix + "changed-scope-final.json"), "utf8"));
for (const target of [...productionQuantityChanges.added, ...productionQuantityChanges.changed]) {
  if (!/^(apps|packages|tools)\//.test(target) || target.split("/").includes("..") || target.includes("\\")) throw new Error("Unexpected production quantity dependency");
  targets.add(target);
}
for (const entry of await fs.readdir(path.join(repo, "docs/project-control/checkpoints"), { withFileTypes: true })) {
  if (entry.isFile() && entry.name.startsWith(productionQuantityPrefix) && /\.(json|md|mts|mjs|ps1|py)$/.test(entry.name)) targets.add("docs/project-control/checkpoints/" + entry.name);
}

targets.add("docs/project-control/FACTORY_CAPACITY_PROGRESS_20261021.md");
targets.add("docs/integration/factory-capacity.md");
targets.add("docs/integration/local-responses-provider.md");
const factoryCapacityPrefix = "2026-10-21-factory-capacity-a64d29f1-";
const factoryCapacityChanges = JSON.parse(await fs.readFile(path.join(repo, "docs/project-control/checkpoints/" + factoryCapacityPrefix + "changed-scope-final.json"), "utf8"));
for (const target of [...factoryCapacityChanges.added, ...factoryCapacityChanges.changed]) {
  if ((!/^(apps|packages|tools)\//.test(target) && target !== "pnpm-lock.yaml") || target.split("/").includes("..") || target.includes("\\")) throw new Error("Unexpected factory capacity dependency");
  targets.add(target);
}
for (const entry of await fs.readdir(path.join(repo, "docs/project-control/checkpoints"), { withFileTypes: true })) {
  if (entry.isFile() && entry.name.startsWith(factoryCapacityPrefix) && /\.(json|md|mts|mjs|ps1|py)$/.test(entry.name)) targets.add("docs/project-control/checkpoints/" + entry.name);
}

targets.add("docs/project-control/FACTORY_AUTHORITY_PROGRESS_20261021.md");
targets.add("docs/integration/factory-authority.md");
const factoryAuthorityPrefix = "2026-10-21-factory-authority-7ca64e10-";
const factoryAuthorityChanges = JSON.parse(await fs.readFile(path.join(repo, "docs/project-control/checkpoints/" + factoryAuthorityPrefix + "changed-scope-final.json"), "utf8"));
for (const target of [...factoryAuthorityChanges.added, ...factoryAuthorityChanges.changed]) {
  if (!/^(apps|packages|tools)\//.test(target) || target.split("/").includes("..") || target.includes("\\")) throw new Error("Unexpected factory authority dependency");
  targets.add(target);
}
for (const entry of await fs.readdir(path.join(repo, "docs/project-control/checkpoints"), { withFileTypes: true })) {
  if (entry.isFile() && entry.name.startsWith(factoryAuthorityPrefix) && /\.(json|md|mts|mjs|ps1|py)$/.test(entry.name)) targets.add("docs/project-control/checkpoints/" + entry.name);
}

targets.add("docs/project-control/ADVERTISING_COMMAND_PROGRESS_20261021.md");
targets.add("docs/integration/advertising-original-requests.md");
targets.add(".env.example");
const advertisingCommandPrefix="2026-10-21-advertising-command-e3a58d70-";
const advertisingCommandChanges=JSON.parse(await fs.readFile(path.join(repo,"docs/project-control/checkpoints/"+advertisingCommandPrefix+"changed-scope-final.json"),"utf8"));
for(const target of [...advertisingCommandChanges.added,...advertisingCommandChanges.changed]){
 if((! /^(apps|packages|tools)\//.test(target)&&target!=="turbo.json")||target.split("/").includes("..")||target.includes("\\"))throw new Error("Unexpected advertising command dependency");
 targets.add(target);
}
for(const entry of await fs.readdir(path.join(repo,"docs/project-control/checkpoints"),{withFileTypes:true})){
 if(entry.isFile()&&entry.name.startsWith(advertisingCommandPrefix)&&/\.(json|md|mts|mjs|ps1|py)$/.test(entry.name))targets.add("docs/project-control/checkpoints/"+entry.name);
}

targets.add("docs/project-control/ADVERTISING_HISTORY_PROGRESS_20261021.md");
targets.add("docs/integration/advertising-history.md");
const historyPrefix="2026-10-21-advertising-history-b7e49a2f-";
const historyChanges=JSON.parse(await fs.readFile(path.join(repo,"docs/project-control/checkpoints/"+historyPrefix+"changed-scope-final.json"),"utf8"));
for(const target of [...historyChanges.added,...historyChanges.changed]){
 if(!/^(apps|packages|tools)\//.test(target)||target.split("/").includes("..")||target.includes("\\"))throw new Error("Unexpected advertising history dependency");
 targets.add(target);
}
for(const entry of await fs.readdir(path.join(repo,"docs/project-control/checkpoints"),{withFileTypes:true})){
 if(entry.isFile()&&entry.name.startsWith(historyPrefix)&&/\.(json|md|mts|mjs|ps1|py)$/.test(entry.name))targets.add("docs/project-control/checkpoints/"+entry.name);
}

targets.add("docs/project-control/ADVERTISING_MEASUREMENT_PROGRESS_20261021.md");
targets.add("docs/integration/advertising-measurement.md");
const measurementPrefix="2026-10-21-advertising-measurement-c8e71f42-";
const measurementChanges=JSON.parse(await fs.readFile(path.join(repo,"docs/project-control/checkpoints/"+measurementPrefix+"changed-scope-final.json"),"utf8"));
for(const target of [...measurementChanges.added,...measurementChanges.changed]){
 if(!/^(apps|packages|tools)\//.test(target)||target.split("/").includes("..")||target.includes("\\"))throw new Error("Unexpected advertising measurement dependency");
 targets.add(target);
}
for(const entry of await fs.readdir(path.join(repo,"docs/project-control/checkpoints"),{withFileTypes:true})){
 if(entry.isFile()&&entry.name.startsWith(measurementPrefix)&&/\.(json|md|mts|mjs|ps1|py)$/.test(entry.name))targets.add("docs/project-control/checkpoints/"+entry.name);
}

targets.add("docs/project-control/ADVERTISING_AUTHORITY_PROGRESS_20261021.md");
targets.add("docs/integration/advertising-authority.md");
const advertisingPrefix="2026-10-21-advertising-evidence-7bd4a2c9-";
const advertisingChanges=JSON.parse(await fs.readFile(path.join(repo,"docs/project-control/checkpoints/"+advertisingPrefix+"changed-scope-final.json"),"utf8"));
for(const target of [...advertisingChanges.added,...advertisingChanges.changed]){
 if(!/^(apps|packages|tools)\//.test(target)||target.split("/").includes("..")||target.includes("\\"))throw new Error("Unexpected advertising authority dependency");
 targets.add(target);
}
for(const entry of await fs.readdir(path.join(repo,"docs/project-control/checkpoints"),{withFileTypes:true})){
 if(entry.isFile()&&entry.name.startsWith(advertisingPrefix)&&/\.(json|md|mts|mjs|ps1|py)$/.test(entry.name))targets.add("docs/project-control/checkpoints/"+entry.name);
}

targets.add("docs/project-control/FINANCE_RECEIPT_PROGRESS_20261021.md");
targets.add("docs/integration/finance-recorded-results.md");
const receiptPrefix="2026-10-21-finance-receipt-94b72e6d-";
const receiptChanges=JSON.parse(await fs.readFile(path.join(repo,"docs/project-control/checkpoints/"+receiptPrefix+"changed-scope-final.json"),"utf8"));
for(const target of [...receiptChanges.added,...receiptChanges.changed]){
 if(!/^(apps|packages|tools)\//.test(target)||target.split("/").includes("..")||target.includes("\\"))throw new Error("Unexpected finance receipt dependency");
 targets.add(target);
}
for(const entry of await fs.readdir(path.join(repo,"docs/project-control/checkpoints"),{withFileTypes:true})){
 if(entry.isFile()&&entry.name.startsWith(receiptPrefix)&&/\.(json|md|mts|mjs|ps1|py)$/.test(entry.name))targets.add("docs/project-control/checkpoints/"+entry.name);
}

targets.add("docs/project-control/FINANCE_COMMAND_PROGRESS_20261021.md");
targets.add("docs/integration/finance-original-requests.md");
targets.add(".env.example");
const financeCommandPrefix="2026-10-21-finance-command-6c29d8f4-";
const financeCommandChanges=JSON.parse(await fs.readFile(path.join(repo,"docs/project-control/checkpoints/"+financeCommandPrefix+"changed-scope-final.json"),"utf8"));
for(const target of [...financeCommandChanges.added,...financeCommandChanges.changed]){
 if(!/^(apps|packages|tools)\//.test(target)&&target!=="turbo.json")throw new Error("Unexpected finance command dependency");
 if(target.split("/").includes("..")||target.includes("\\"))throw new Error("Invalid finance command dependency");
 targets.add(target);
}
for(const entry of await fs.readdir(path.join(repo,"docs/project-control/checkpoints"),{withFileTypes:true})){
 if(entry.isFile()&&entry.name.startsWith(financeCommandPrefix)&&/\.(json|md|mts|mjs|ps1|py)$/.test(entry.name))targets.add("docs/project-control/checkpoints/"+entry.name);
}

targets.add("docs/project-control/ORDER_REVIEW_FIXTURE_PROGRESS_20261021.md");
targets.add("docs/operations/order-profit-review-acceptance.md");
const orderReviewPrefix="2026-10-21-order-review-7b4a6e21-";
const orderReviewChanges=JSON.parse(await fs.readFile(path.join(repo,"docs/project-control/checkpoints/"+orderReviewPrefix+"changed-scope-final.json"),"utf8"));
for(const target of [...orderReviewChanges.added,...orderReviewChanges.changed]){
 if(!/^(apps|packages|tools)\//.test(target)||target.split("/").includes("..")||target.includes("\\"))throw new Error("Unexpected order review acceptance dependency");
 targets.add(target);
}
for(const entry of await fs.readdir(path.join(repo,"docs/project-control/checkpoints"),{withFileTypes:true})){
 if(entry.isFile()&&entry.name.startsWith(orderReviewPrefix)&&/\.(json|md|mts|mjs|ps1|py)$/.test(entry.name))targets.add("docs/project-control/checkpoints/"+entry.name);
}

targets.add("docs/project-control/FINANCE_COST_ALLOCATION_PROGRESS_20261021.md");
targets.add("docs/integration/finance-cost-allocation.md");
const allocationPrefix="2026-10-21-finance-allocation-87a6c2d9-";
const allocationChanges=JSON.parse(await fs.readFile(path.join(repo,"docs/project-control/checkpoints/"+allocationPrefix+"changed-scope-final.json"),"utf8"));
for(const target of [...allocationChanges.added,...allocationChanges.changed]){
 if(!/^(apps|packages|tools)\//.test(target)||target.split("/").includes("..")||target.includes("\\"))throw new Error("Unexpected cost allocation dependency");
 targets.add(target);
}
for(const entry of await fs.readdir(path.join(repo,"docs/project-control/checkpoints"),{withFileTypes:true})){
 if(entry.isFile()&&entry.name.startsWith(allocationPrefix)&&/\.(json|mts|mjs|ps1|py)$/.test(entry.name))targets.add("docs/project-control/checkpoints/"+entry.name);
}

targets.add("docs/project-control/FINANCE_LEDGER_PROGRESS_20261021.md");
targets.add("docs/integration/finance-ledger.md");
const ledgerPrefix="2026-10-21-finance-ledger-4c7b1e92-";
const ledgerChanges=JSON.parse(await fs.readFile(path.join(repo,"docs/project-control/checkpoints/"+ledgerPrefix+"changed-scope-final.json"),"utf8"));
for(const target of [...ledgerChanges.added,...ledgerChanges.changed]){
 if(!/^(apps|packages|tools)\//.test(target)||target.split("/").includes("..")||target.includes("\\"))throw new Error("Unexpected finance ledger dependency");
 targets.add(target);
}
for(const entry of await fs.readdir(path.join(repo,"docs/project-control/checkpoints"),{withFileTypes:true})){
 if(entry.isFile()&&entry.name.startsWith(ledgerPrefix)&&/\.(json|mts|mjs|ps1|py)$/.test(entry.name))targets.add("docs/project-control/checkpoints/"+entry.name);
}

targets.add("docs/project-control/FINANCE_ADJUSTMENTS_PROGRESS_20261021.md");
targets.add("docs/integration/finance-payable-adjustments.md");
targets.add("docs/project-control/RESPONSES_RECHECK_PROGRESS_20261021.md");
const adjustmentPrefix="2026-10-21-finance-adjustments-a96c21f4-";
const adjustmentChanges=JSON.parse(await fs.readFile(path.join(repo,"docs/project-control/checkpoints/"+adjustmentPrefix+"changed-scope-final.json"),"utf8"));
for(const target of [...adjustmentChanges.added,...adjustmentChanges.changed]){
 if(!/^(apps|packages|tools)\//.test(target)||target.split("/").includes("..")||target.includes("\\"))throw new Error("Unexpected payable adjustment dependency");
 targets.add(target);
}
for(const entry of await fs.readdir(path.join(repo,"docs/project-control/checkpoints"),{withFileTypes:true})){
 if(entry.isFile()&&(entry.name.startsWith(adjustmentPrefix)||entry.name.startsWith("2026-10-21-responses-recheck-9ce4b210"))&&/\.(json|mts|mjs|ps1|py)$/.test(entry.name))targets.add("docs/project-control/checkpoints/"+entry.name);
}

targets.add("docs/project-control/FINANCE_AUTHORITY_PROGRESS_20261021.md");
targets.add("docs/integration/finance-source-authority.md");
const authorityPrefix="2026-10-21-finance-authority-c42e8d19-";
const authorityChanges=JSON.parse(await fs.readFile(path.join(repo,"docs/project-control/checkpoints/"+authorityPrefix+"changed-scope-final.json"),"utf8"));
for(const target of [...authorityChanges.added,...authorityChanges.changed]){
 if(!/^(apps|packages|tools)\//.test(target)||target.split("/").includes("..")||target.includes("\\"))throw new Error("Unexpected finance authority dependency");
 targets.add(target);
}
for(const entry of await fs.readdir(path.join(repo,"docs/project-control/checkpoints"),{withFileTypes:true})){
 if(entry.isFile()&&entry.name.startsWith(authorityPrefix)&&/\.(json|mts|mjs|ps1|py)$/.test(entry.name))targets.add("docs/project-control/checkpoints/"+entry.name);
}

targets.add("docs/project-control/FINANCE_PAYABLES_PROGRESS_20261021.md");
targets.add("docs/integration/finance-payables.md");
const payablePrefix="2026-10-21-finance-payables-e35b7c92-";
const payableChanges=JSON.parse(await fs.readFile(path.join(repo,"docs/project-control/checkpoints/"+payablePrefix+"changed-scope-final.json"),"utf8"));
for(const target of [...payableChanges.added,...payableChanges.changed]){
 if(!/^(apps|packages|tools)\//.test(target)||target.split("/").includes("..")||target.includes("\\"))throw new Error("Unexpected payable dependency");
 targets.add(target);
}
for(const entry of await fs.readdir(path.join(repo,"docs/project-control/checkpoints"),{withFileTypes:true})){
 if(entry.isFile()&&entry.name.startsWith(payablePrefix)&&/\.(json|mts|mjs|ps1|py)$/.test(entry.name))targets.add("docs/project-control/checkpoints/"+entry.name);
}

targets.add("docs/project-control/FINANCE_MONETARY_PROGRESS_20261021.md");
targets.add("docs/integration/finance.md");
const monetaryPrefix="2026-10-21-finance-monetary-a84d6e71-";
const monetaryChanges=JSON.parse(await fs.readFile(path.join(repo,"docs/project-control/checkpoints/"+monetaryPrefix+"changed-scope-r6.json"),"utf8"));
for(const target of [...monetaryChanges.added,...monetaryChanges.modified]){
 if(!/^(apps|packages|tools)\//.test(target)||target.split("/").includes("..")||target.includes("\\"))throw new Error("Unexpected monetary dependency");
 targets.add(target);
}
for(const entry of await fs.readdir(path.join(repo,"docs/project-control/checkpoints"),{withFileTypes:true})){
 if(entry.isFile()&&entry.name.startsWith(monetaryPrefix)&&/\.(json|mts|mjs|ps1)$/.test(entry.name))targets.add("docs/project-control/checkpoints/"+entry.name);
}
targets.add("docs/project-control/checkpoints/2026-10-21-blueprint-v1.1.58-independent.py");

targets.add("docs/project-control/INVOICE_RECONCILIATION_PROGRESS_20261021.md");
targets.add("docs/architecture/procurement-invoice-reconciliation.md");
targets.add("docs/integration/procurement-invoice-reconciliation.md");
const reconciliationPrefix="2026-10-20-procurement-resolution-6f24ac90-";
const reconciliationChanges=JSON.parse(await fs.readFile(path.join(repo,"docs/project-control/checkpoints/"+reconciliationPrefix+"changed-scope-r3.json"),"utf8"));
for(const target of [...reconciliationChanges.added,...reconciliationChanges.modified]){
 if(!/^(apps|packages|tools)\//.test(target)||target.split("/").includes("..")||target.includes("\\"))throw new Error("Unexpected reconciliation dependency");
 targets.add(target);
}
for(const e of await fs.readdir(path.join(repo,"docs/project-control/checkpoints"),{withFileTypes:true})){if(e.isFile()&&e.name.startsWith(reconciliationPrefix)&&/\.(json|mts|mjs|ps1)$/.test(e.name))targets.add("docs/project-control/checkpoints/"+e.name);}


targets.add("docs/project-control/INVOICE_COMMAND_PROGRESS_20261020.md");
targets.add("docs/architecture/procurement-invoice-commands.md");
const invoicePrefix="2026-10-20-invoice-command-d7a8e0c2-";
const invoiceChanges=JSON.parse(await fs.readFile(path.join(repo,"docs/project-control/checkpoints/"+invoicePrefix+"changed-scope.json"),"utf8"));
for(const target of [...invoiceChanges.added,...invoiceChanges.modified]){
 if(!/^(apps|packages|tools)\//.test(target)||target.split("/").includes("..")||target.includes("\\"))throw new Error("Unexpected invoice dependency");
 targets.add(target);
}
for(const e of await fs.readdir(path.join(repo,"docs/project-control/checkpoints"),{withFileTypes:true})){if(e.isFile()&&e.name.startsWith(invoicePrefix)&&/\.(json|mts|mjs|ps1)$/.test(e.name))targets.add("docs/project-control/checkpoints/"+e.name);}


targets.add("docs/project-control/PROCUREMENT_PRECISION_PROGRESS_20261020.md");
targets.add("docs/architecture/procurement-measurement-and-invoices.md");
const precisionPrefix="2026-10-20-procurement-precision-9a62c173-";
const precisionChanges=JSON.parse(await fs.readFile(path.join(repo,"docs/project-control/checkpoints/"+precisionPrefix+"changed-scope.json"),"utf8"));
for(const target of [...precisionChanges.added,...precisionChanges.modified]){
 if(!/^(apps|packages|tools)\//.test(target)||target.split("/").includes("..")||target.includes("\\"))throw new Error("Unexpected precision dependency");
 targets.add(target);
}
for(const entry of await fs.readdir(path.join(repo,"docs/project-control/checkpoints"),{withFileTypes:true})){
 if(entry.isFile()&&entry.name.startsWith(precisionPrefix)&&/\.(json|mts|mjs|ps1)$/.test(entry.name))targets.add("docs/project-control/checkpoints/"+entry.name);
}


targets.add("docs/project-control/PROCUREMENT_ADOPTION_PROGRESS_20261020.md");
for (const entry of await fs.readdir(path.join(repo, "docs/project-control/checkpoints"), { withFileTypes: true })) {
  if (entry.isFile() && entry.name.startsWith("2026-10-20-procurement-adoption-41d9bb72-") && /\.(json|mts|ps1)$/.test(entry.name))
    targets.add("docs/project-control/checkpoints/" + entry.name);
}


targets.add("docs/project-control/PROCUREMENT_RECOVERY_PROGRESS_20261020.md");
targets.add("docs/integration/local-responses-provider.md");
const recoveryPrefix = "2026-10-20-procurement-recovery-72c396a4-";
const recoveryChanges = JSON.parse(await fs.readFile(path.join(repo,
  "docs/project-control/checkpoints/" + recoveryPrefix + "changed-scope.json"), "utf8"));
for (const target of [...recoveryChanges.added, ...recoveryChanges.modified]) {
  if ((!/^(apps|packages|tools)\//.test(target) && target !== "package.json") || target.split("/").includes("..") || target.includes("\\"))
    throw new Error("Unexpected recovery source dependency");
  targets.add(target);
}
for (const entry of await fs.readdir(path.join(repo, "docs/project-control/checkpoints"), { withFileTypes: true })) {
  if (entry.isFile() && (entry.name.startsWith(recoveryPrefix) || entry.name.startsWith("2026-10-20-responses-provider-2fcea036-")) && /\.(json|ps1|mts)$/.test(entry.name))
    targets.add("docs/project-control/checkpoints/" + entry.name);
}

targets.add("docs/project-control/PROCUREMENT_CYCLE_AUDIT_20261020.md");
targets.add("docs/project-control/AGENT_FILE_OWNERSHIP_20261020.md");
targets.add("docs/integration/procurement-original-requests.md");
const procurementPrefix = "2026-10-20-procurement-cycle-becfa1bb-";
const procurementChanges = JSON.parse(await fs.readFile(path.join(repo,
  "docs/project-control/checkpoints/" + procurementPrefix + "changed-scope.json"), "utf8"));
for (const target of [...procurementChanges.added, ...procurementChanges.modified]) {
  if ((!/^(apps|packages|tools)\//.test(target) && target !== "package.json") || target.split("/").includes("..") || target.includes("\\"))
    throw new Error("Unexpected procurement source dependency");
  targets.add(target);
}
for (const entry of await fs.readdir(path.join(repo, "docs/project-control/checkpoints"), { withFileTypes: true })) {
  if (entry.isFile() && entry.name.startsWith(procurementPrefix) && /\.(json|ps1)$/.test(entry.name))
    targets.add("docs/project-control/checkpoints/" + entry.name);
}

targets.add("docs/project-control/ARRIVAL_INSPECTION_PROGRESS_20261020.md");
targets.add("docs/integration/incoming-inspection.md");
const incomingPrefix = "2026-10-20-arrival-inspection-1652bf96-";
const incomingChanges = JSON.parse(await fs.readFile(path.join(repo,
  "docs/project-control/checkpoints/" + incomingPrefix + "changed-scope.json"), "utf8"));
for (const target of [...incomingChanges.added, ...incomingChanges.modified]) {
  if ((!/^(apps|packages|tools)\//.test(target) && target !== "package.json") || target.split("/").includes("..") || target.includes("\\"))
    throw new Error("Unexpected incoming source dependency");
  targets.add(target);
}
for (const entry of await fs.readdir(path.join(repo, "docs/project-control/checkpoints"), { withFileTypes: true })) {
  if (entry.isFile() && entry.name.startsWith(incomingPrefix) && entry.name.endsWith(".json"))
    targets.add("docs/project-control/checkpoints/" + entry.name);
}

targets.add("docs/project-control/INVENTORY_RECEIVING_PROGRESS_20261020.md");
targets.add("docs/architecture/incoming-material-inspection.md");
targets.add("docs/integration/procurement.md");
const receivingChanges = JSON.parse(await fs.readFile(path.join(repo,
  "docs/project-control/checkpoints/2026-10-20-inventory-receiving-2ec58a86-changed-scope.json"), "utf8"));
for (const target of [...receivingChanges.added, ...receivingChanges.modified]) {
  if (!/^(apps|packages|tools)\//.test(target) || target.split("/").includes("..") || target.includes("\\")) throw new Error("Unexpected reviewed source dependency");
  targets.add(target);
}
for (const entry of await fs.readdir(path.join(repo, "docs/project-control/checkpoints"), { withFileTypes: true })) {
  if (entry.isFile() && entry.name.startsWith("2026-10-20-inventory-receiving-2ec58a86-") && /\.(json|ps1)$/.test(entry.name))
    targets.add("docs/project-control/checkpoints/" + entry.name);
}
targets.add("docs/project-control/MATERIAL_RETENTION_PROGRESS_20261020.md");
targets.add("docs/integration/material-input-retention-runtime.md");
targets.add("docs/project-control/MATERIAL_ADOPTION_PROGRESS_20261020.md");
for (const entry of await fs.readdir(path.join(repo, "docs/project-control/checkpoints"), { withFileTypes: true })) {
  if (entry.isFile() && ["2026-10-20-material-adoption-867684e2-", "2026-10-20-material-retention-57de4b86-"].some(prefix => entry.name.startsWith(prefix)) && /\.(json|ps1)$/.test(entry.name))
    targets.add("docs/project-control/checkpoints/" + entry.name);
}
for (const target of [
  "docs/project-control/MATERIAL_RECOVERY_PROGRESS_20261020.md",
  ...["baseline","progress","source-before","source-final","changed-scope","types","evidence","resources","runtime","preservation","cleanup-plan","cleanup-native-result","cleanup","final-audit"].map(name=>"docs/project-control/checkpoints/2026-10-20-material-recovery-db764600-"+name+".json"),
  "docs/project-control/checkpoints/2026-10-20-material-recovery-db764600-cleanup-command.ps1",
  "docs/project-control/INVENTORY_EXECUTION_PROGRESS_20261020.md",
  "docs/integration/production-material-execution.md",
  ...["baseline","progress","source-before","source-precision-stage","source-material-stage","source-final","changed-scope","types","evidence","resources","runtime","worker-queues","preservation","cleanup-plan","cleanup-native-result","cleanup","final-audit"].map(name=>"docs/project-control/checkpoints/2026-10-20-inventory-execution-f754acae-"+name+".json"),
  "docs/project-control/checkpoints/2026-10-20-inventory-execution-f754acae-cleanup-command.ps1",
  "docs/project-control/SHIPOS_OBSERVATION_PROGRESS_20261020.md",
  "docs/integration/shipos-readonly.md",
  "docs/operations/local-development.md", "docs/operations/backup-restore.md",
  ...["baseline","progress","source-before","source-stage","source-final","source-acceptance-final","full-initial","evidence","worker-queues","worker-queues-final","backup","original-receipts","rehearsal","rehearsal-restore","apply","adoption-preservation","resources","runtime","preservation","cleanup-plan","cleanup-native-result","cleanup","final-audit"].map(name=>"docs/project-control/checkpoints/2026-10-20-shipos-observation-f7d44af3-"+name+".json"),
  "docs/project-control/checkpoints/2026-10-20-shipos-observation-f7d44af3-cleanup-command.ps1",
  "docs/project-control/EXECUTION_ISOLATION_PROGRESS_20261020.md",
  "docs/integration/inventory.md", "docs/integration/workflow-node-execution.md",
  ...["baseline","preflight","progress","source-before","source-final","evidence","resources","runtime","worker-queues","worker-queues-final","preservation","cleanup-plan","cleanup-native-result","cleanup","final-audit"].map(name=>"docs/project-control/checkpoints/2026-10-20-execution-isolation-b146a533-"+name+".json"),
  "docs/project-control/checkpoints/2026-10-20-execution-isolation-b146a533-cleanup-command.ps1",
  "docs/project-control/PRODUCTION_ADOPTION_PROGRESS_20261020.md",
  ...["baseline","progress","source","source-acceptance","source-acceptance-final","source-acceptance-r4","fixture-clock-correction","fixture-recovery-correction","fixture-due-correction","clock-observation","backup","original-receipts","rehearsal","rehearsal-restore","apply","preservation-after-upgrade","runtime-smoke","worker-queues","resources","evidence","preservation","dependencies","cleanup-plan","cleanup-native-result","cleanup","final-audit"].map(name=>"docs/project-control/checkpoints/2026-10-20-production-adoption-3e91282a-"+name+".json"),
  "docs/project-control/checkpoints/2026-10-20-production-adoption-3e91282a-cleanup-command.ps1",
  "docs/project-control/INVENTORY_REBUILD_AUDIT_20261020.md",
  "docs/project-control/checkpoints/2026-10-20-production-adoption-3e91282a-worker-queues-final.json",
  "docs/project-control/PRODUCTION_RESTART_PROGRESS_20261020.md",
  "patches/README.md", "patches/postgres@3.4.9.patch", "pnpm-workspace.yaml", "pnpm-lock.yaml",
  "tools/testing/isolated-postgres.mts", "tools/testing/run-production-command-restart.mts", "tools/testing/production-command-restart.mts",
  ...["baseline","progress","attempt1","attempt2","attempt3","attempt4","attempt5","source","source-final","source-verified","source-actual","candidate-plan","candidate-final-plan","candidate-verified-plan","candidate-actual-plan","candidate","evidence","resources","preservation","dependencies","cleanup-plan","cleanup-native-result","cleanup","final-audit"].map(name=>"docs/project-control/checkpoints/2026-10-20-production-restart-a6c3daf5-"+name+".json"),
  "docs/project-control/checkpoints/2026-10-20-production-restart-a6c3daf5-cleanup-command.ps1",
  "README.md", "PROJECT_STATUS.md", "PROJECT_HANDOFF.md", "CLAUDE.md", "AGENTS.md", "docs/user-guide.md",
  "docs/integration/production-command-recovery.md",
  "docs/project-control/PRODUCTION_COMMAND_RECOVERY_PROGRESS_20261020.md",
  ...["baseline","progress","source","unit","types","evidence","resources","candidate","dependencies","preservation-before","preservation","cleanup-plan","cleanup-native-result","cleanup","final-audit"].map(name=>"docs/project-control/checkpoints/2026-10-20-production-command-recovery-0c451145-"+name+".json"),
  "docs/project-control/checkpoints/2026-10-20-production-command-recovery-0c451145-cleanup-command.ps1",
  "docs/integration/acceptance-output-isolation.md",
  "docs/architecture/order-command-recovery.md",
  "docs/project-control/HARNESS_RECOVERY_PROGRESS_20261020.md",
  ...["baseline","progress","source","source-final","evidence","final-supplement","resources","cleanup-plan","cleanup-native-result","cleanup","preservation","dependencies","final-audit"].map(name=>"docs/project-control/checkpoints/2026-10-20-harness-recovery-91e8f022-"+name+".json"),
  "docs/project-control/checkpoints/2026-10-20-harness-recovery-91e8f022-cleanup-command.ps1",
  "docs/integration/normal-runtime-adoption.md",
  "docs/project-control/NORMAL_RUNTIME_ADOPTION_PROGRESS_20261020.md",
  ...["baseline","progress","backup","source","pairing","identity-inspection","queues","final-queues","rehearsal","rehearsal-restore","rehearsal-resources","apply","post-upgrade-preservation","build-traces","runtime","resources","output-boundary-incident","cleanup-plan","cleanup-native-result","cleanup","preservation","dependencies","final-audit"].map(name=>"docs/project-control/checkpoints/2026-10-20-normal-runtime-adoption-a448a200-"+name+".json"),
  "docs/project-control/checkpoints/2026-10-20-normal-runtime-adoption-a448a200-cleanup-command.ps1",
  "docs/integration/production-entry.md",
  "docs/project-control/PRODUCTION_ENTRY_PROGRESS_20261020.md",
  ...["baseline","progress","source-working","source-final","evidence","resources","dependencies","preservation","cleanup-plan","cleanup-native-result","cleanup","final-audit"].map(name=>"docs/project-control/checkpoints/2026-10-19-production-entry-"+name+".json"),
  "docs/project-control/checkpoints/2026-10-19-production-entry-cleanup-command.ps1",
  "docs/agent-decisions-method-reconstruction-20261015.md",
  "docs/integration/agent-harness.md", "docs/integration/knowledge-workspace.md",
  "docs/integration/factory-portal.md",
  "docs/integration/erp-identity.md",
  "docs/integration/local-personal-runtime.md",
  "docs/integration/local-web-candidates.md",
  "docs/integration/supplier-factories.md",
  "docs/integration/specification-facts.md",
  "docs/integration/quality-assessment.md",
  "docs/integration/manufacturing-regression.md",
  "docs/project-control/MANUFACTURING_REGRESSION_PROGRESS_20261019.md",
  ...["baseline","progress","source","source-final","evidence","resources","preservation","dependencies","cleanup-plan","cleanup-native-result","cleanup","final-audit","candidate-plan"].map(name=>"docs/project-control/checkpoints/2026-10-19-manufacturing-regression-"+name+".json"),
  "docs/integration/manufacturing-recipes.md",
  "docs/integration/production-manufacturing.md",
  "docs/integration/manufacturing-delivery.md",
  "docs/integration/production-operator-handoff.md",
  "docs/project-control/PRODUCTION_OPERATOR_HANDOFF_PROGRESS_20261019.md",
  ...["baseline","progress","source","source-final","evidence","resources","dependencies","preservation","cleanup-plan","cleanup-native-result","cleanup","final-audit"].map(name=>"docs/project-control/checkpoints/2026-10-19-production-handoff-"+name+".json"),
  "docs/integration/production-delivery.md",
  "docs/project-control/MANUFACTURING_RELEASE_PROGRESS_20261019.md",
  ...["baseline","progress","source","source-final","evidence","resources","preservation","cleanup-plan","cleanup-native-result","cleanup","final-audit"].map(name=>"docs/project-control/checkpoints/2026-10-19-manufacturing-release-"+name+".json"),
  "docs/project-control/MANUFACTURING_DELIVERY_PROGRESS_20261019.md",
  ...["baseline","progress","source","source-final","evidence","resources","preservation","dependencies","cleanup-plan","cleanup-native-result","cleanup","final-audit"].map(name=>"docs/project-control/checkpoints/2026-10-19-manufacturing-delivery-"+name+".json"),
  "docs/project-control/FULL_PLATFORM_REMAINING_AUDIT_20261019.md",
  "docs/project-control/checkpoints/2026-10-19-full-platform-triage.json",
  "docs/project-control/MANUFACTURING_FOUNDATION_DELIVERY_20261019.md",
  ...["baseline","progress","source","evidence","dependencies","resources","preservation","cleanup","cleanup-plan","cleanup-native-result","final-audit"].map(name=>"docs/project-control/checkpoints/2026-10-19-manufacturing-"+name+".json"),
  "docs/project-control/MANUFACTURING_UI_DELIVERY_20261019.md",
  ...["baseline","progress","source","build-plan","build","evidence","dependencies","resources","preservation","cleanup","cleanup-plan","cleanup-native-result"].map(name=>"docs/project-control/checkpoints/2026-10-19-manufacturing-ui-"+name+".json"),
  "docs/integration/quality-groups.md",
  "docs/project-control/QUALITY_GROUPS_DELIVERY_20261019.md",
  ...["baseline","progress","source","source-build-1","build-1","build","evidence","preservation","resources","cleanup","cleanup-plan","cleanup-native-result","candidate-audit"].map(name=>"docs/project-control/checkpoints/2026-10-19-quality-groups-"+name+".json"),
  ...["baseline","progress","source","source-before-lint","build","evidence","preservation","dependencies","resources","cleanup","cleanup-plan","cleanup-native-result","candidate-audit"].map(name=>"docs/project-control/checkpoints/2026-10-19-quality-work-authority-"+name+".json"),
  "docs/integration/shipment-production-sources.md",
  "docs/project-control/SHIPMENT_SOURCES_DELIVERY_20261019.md",
  ...["baseline","progress","source","source-build-1","source-build-2","build-1","build-2","build","evidence","preservation","dependencies","resources","normal-ready","current-queues","cleanup","cleanup-plan","cleanup-native-result"].map(name=>"docs/project-control/checkpoints/2026-10-19-shipment-lots-"+name+".json"),
  "docs/project-control/FACTORY_EXECUTION_DELIVERY_20261019.md",
  ...["baseline","progress","source","source-build-1","evidence","preservation","dependencies","resources","current-queues","normal-ready","cleanup","cleanup-plan","cleanup-native-result","build","fixture-upgrade"].map(name=>"docs/project-control/checkpoints/2026-10-19-factory-execution-"+name+".json"),
  ...["source-build-2","build-1"].map(name=>"docs/project-control/checkpoints/2026-10-19-factory-execution-"+name+".json"),
  ...["source-build-3","build-2"].map(name=>"docs/project-control/checkpoints/2026-10-19-factory-execution-"+name+".json"),
  ...["source-build-4","build-3"].map(name=>"docs/project-control/checkpoints/2026-10-19-factory-execution-"+name+".json"),
  ...["source-build-5","build-4"].map(name=>"docs/project-control/checkpoints/2026-10-19-factory-execution-"+name+".json"),
  ...["source-build-6","build-5"].map(name=>"docs/project-control/checkpoints/2026-10-19-factory-execution-"+name+".json"),
  "docs/integration/product-development.md",
  "docs/project-control/SPECIFICATION_FACTS_DELIVERY_20261019.md",
  ...["baseline","progress","source","source-build-1","evidence","preservation","dependencies","resources","current-queues","normal-ready","cleanup","cleanup-plan","cleanup-native-result","build","fixture-upgrade"].map(name=>"docs/project-control/checkpoints/2026-10-19-specification-facts-"+name+".json"),
  "docs/project-control/FACTORY_ELIGIBILITY_DELIVERY_20261019.md",
  ...["baseline","progress","source","evidence","preservation","dependencies","resources","cleanup","cleanup-plan","build"].map(name=>"docs/project-control/checkpoints/2026-10-19-product-facts-factory-"+name+".json"),
  "docs/project-control/LOCAL_WEB_RUNTIME_DELIVERY_20261019.md",
  ...["baseline","progress","source","source-build-1","source-build-2","evidence","preservation","dependencies","resources","current-queues","normal-ready","cleanup","cleanup-plan","cleanup-native-result","web-probe-rejection","build-1","candidate-plan"].map(name=>"docs/project-control/checkpoints/2026-10-19-local-web-runtime-"+name+".json"),
  "docs/integration/worker-runtime.md",
  "docs/integration/creative-execution.md",
  "docs/integration/creative-execution-operator.md",
  "docs/integration/mockup-management-authority.md",
  "docs/project-control/MOCKUP_MANAGEMENT_AUTHORITY_DELIVERY_20261019.md",
  ...["evidence","source","preservation","dependencies","resources","cleanup","cleanup-plan","cleanup-native-result","baseline","progress","web-build"].map(name=>"docs/project-control/checkpoints/2026-10-19-mockup-management-authority-"+name+".json"),
  ...["normal-ready","current-queues","web-build-attempt-76777ff613aa4ed691c5f44205c72c88","web-build-attempt-700b425b1aed4c578aad951821363959"].map(name=>"docs/project-control/checkpoints/2026-10-19-mockup-management-authority-"+name+".json"),
  "docs/project-control/CREATIVE_EXECUTION_OPERATOR_DELIVERY_20261019.md",
  ...["evidence","source","preservation","dependencies","resources","cleanup","cleanup-plan","cleanup-native-result","baseline","progress"].map(name=>"docs/project-control/checkpoints/2026-10-19-creative-execution-operator-"+name+".json"),
  ...["normal-ready","mockup-audit"].map(name=>"docs/project-control/checkpoints/2026-10-19-creative-execution-operator-"+name+".json"),
  "docs/operations/mockup-runtime.md",
  "docs/architecture/adr-2026-10-19-creative-execution-recovery.md",
  "docs/project-control/CREATIVE_EXECUTION_DELIVERY_20261019.md",
  ...["source-delivery","preservation-delivery","dependencies-delivery","generated-restoration-delivery"].map(name=>"docs/project-control/checkpoints/2026-10-19-legacy-creative-harness-"+name+".json"),
  ...["normal-ready-final","current-queues-final"].map(name=>"docs/project-control/checkpoints/2026-10-19-legacy-creative-harness-"+name+".json"),
  ...["evidence","source","source-final","preservation","preservation-final","dependencies","dependencies-final","resources-final","cleanup","cleanup-plan","cleanup-native-result","generated-restoration","generated-restoration-final","baseline","progress","normal-ready","current-queues","ordinary-test-fixtures","ordinary-test-correction","normal-drift","normal-129-rehearsal","normal-129-rehearsal-restore","normal-129-apply","dependency-before","dependency-result","full-suite-source","full-suite-source-final","full-suite-source-candidate","continuation-226"].map(name=>"docs/project-control/checkpoints/2026-10-19-legacy-creative-harness-"+name+".json"),
  "docs/integration/canvas-workflow-authority.md",
  "docs/project-control/CANVAS_WORKFLOW_AUTHORITY_DELIVERY_20261019.md",
  ...["evidence","source","preservation","dependencies","resources","cleanup","cleanup-plan","cleanup-native-result","generated-restoration","baseline","progress","normal-ready","current-queues","worker-admission-audit"].map(name=>"docs/project-control/checkpoints/2026-10-19-canvas-workflow-authority-"+name+".json"),
  ...["independent-audit","final-audit","final-resource-recheck"].map(name=>"docs/project-control/checkpoints/2026-10-19-native-design-authority-"+name+".json"),
  "docs/integration/native-design-authority.md",
  "docs/project-control/NATIVE_DESIGN_AUTHORITY_DELIVERY_20261019.md",
  ...["evidence","source","preservation","dependencies","resources","cleanup","cleanup-plan","cleanup-native-result","generated-restoration","baseline","progress","normal-ready","current-queues"].map(name=>"docs/project-control/checkpoints/2026-10-19-native-design-authority-"+name+".json"),
  ...["independent-audit","final-audit","final-resource-recheck"].map(name=>"docs/project-control/checkpoints/2026-10-19-asset-authority-"+name+".json"),
  "docs/integration/asset-authority.md",
  "docs/project-control/ASSET_AUTHORITY_DELIVERY_20261019.md",
  ...["evidence","source","preservation","dependencies","resources","cleanup","cleanup-plan","cleanup-native-result","generated-restoration","baseline","progress","normal-ready","current-queues"].map(name=>`docs/project-control/checkpoints/2026-10-19-asset-authority-${name}.json`),
  ...["independent-audit","final-audit","final-resource-recheck"].map(name=>`docs/project-control/checkpoints/2026-10-19-order-authority-${name}.json`),
  "docs/integration/order-authority.md",
  "docs/integration/order-centers.md",
  "docs/project-control/ORDER_AUTHORITY_DELIVERY_20261019.md",
  ...["evidence","source","preservation","dependencies","resources","cleanup","cleanup-plan","cleanup-native-result","generated-restoration","baseline","progress","normal-ready","current-queues","transaction-map"].map(name=>`docs/project-control/checkpoints/2026-10-19-order-authority-${name}.json`),
  "docs/integration/research-authority.md",
  "docs/integration/capture-media-archive.md",
  "docs/integration/research-creative-handoff.md",
  "docs/project-control/CAPTURE_AUTHORITY_DELIVERY_20261019.md",
  ...["evidence","source","preservation","dependencies","resources","cleanup","cleanup-plan","cleanup-native-result","generated-restoration","baseline","progress","normal-ready","admission","current-queues"].map(name=>`docs/project-control/checkpoints/2026-10-19-capture-authority-${name}.json`),
  "docs/project-control/WORKER_SELECTION_DELIVERY_20261019.md",
  ...["evidence","source","preservation","dependencies","resources","cleanup","cleanup-plan","cleanup-native-result","generated-restoration","baseline","progress","normal-state","normal-ready","runtime","process-proof","queue-inspection-acceptance"].map(name=>`docs/project-control/checkpoints/2026-10-19-worker-selection-${name}.json`),
  "docs/project-control/NORMAL_IDENTITY_RUNTIME_DELIVERY_20261019.md",
  ...["evidence","source","preservation","dependencies","resources","cleanup","cleanup-plan","cleanup-native-result","generated-restoration","baseline","progress","initial-preflight","identity-contract","environment","alignment-plan","identity-alignment","identity-readback","final-identity-readback","queue-inspection-acceptance","queue-inspection-acceptance-r2","queue-inspection-acceptance-r3","current-queues","normal-ready"].map(name=>`docs/project-control/checkpoints/2026-10-19-normal-identity-runtime-${name}.json`),
  "docs/integration/product-access.md",
  "docs/integration/product-authority.md",
  "docs/integration/catalog-scope.md",
  "docs/integration/catalog-editor.md",
  "docs/integration/listing-authority.md", "docs/integration/sales-plans.md",
  "docs/integration/sales-plan-session.md",
  "docs/integration/sales-plan-references.md",
  "docs/project-control/checkpoints/2026-10-18-sales-composition-concurrent-preservation.json",
  "docs/integration/catalog-render-recovery.md",
  "docs/integration/legacy-runtime-upgrade.md",
  "docs/operations/backup-restore.md",
  "docs/project-control/NORMAL_RUNTIME_UPGRADE_DELIVERY_20261019.md",
  ...["evidence","source","preservation","dependencies","resources","cleanup","cleanup-plan","cleanup-native-result","generated-restoration","baseline","progress","actual-restore","schema-probe","actual-rehearsal","actual-rehearsal-restore","final-rehearsal","final-rehearsal-restore","actual-apply","normal-ready"].map(name=>`docs/project-control/checkpoints/2026-10-19-normal-runtime-upgrade-${name}.json`),
  "docs/project-control/CATALOG_RENDER_RECOVERY_DELIVERY_20261019.md",
  ...["evidence","source","preservation","dependencies","resources","cleanup","cleanup-plan","cleanup-native-result","generated-restoration","baseline","progress"].map(name=>`docs/project-control/checkpoints/2026-10-19-catalog-render-recovery-${name}.json`),
  "docs/integration/sales-editor-lifecycle.md",
  "docs/project-control/SALES_EDITOR_LIFECYCLE_DELIVERY_20261019.md",
  ...["evidence","source","preservation","dependencies","resources","cleanup","cleanup-plan","cleanup-native-result","generated-restoration","baseline","progress"].map(name=>`docs/project-control/checkpoints/2026-10-19-sales-editor-lifecycle-${name}.json`),
  "docs/integration/sales-composition-lifecycle.md",
  "docs/project-control/SALES_COMPOSITION_DELIVERY_20261018.md",
  ...["evidence","source","preservation","dependencies","resources","cleanup","cleanup-plan","cleanup-native-result","generated-restoration","baseline","progress"].map(name=>`docs/project-control/checkpoints/2026-10-18-sales-composition-${name}.json`),
  "docs/integration/channel-mapping.md",
  "docs/project-control/CHANNEL_MAPPING_DELIVERY_20261018.md",
  ...["evidence","source","preservation","dependencies","resources","cleanup","cleanup-plan","cleanup-native-result","generated-restoration","baseline","progress"].map(name=>`docs/project-control/checkpoints/2026-10-18-channel-mapping-${name}.json`),
  "docs/integration/sales-package-history.md",
  "docs/project-control/SALES_PACKAGE_HISTORY_DELIVERY_20261018.md",
  ...["evidence","source","preservation","dependencies","resources","cleanup","cleanup-plan","cleanup-native-result","generated-restoration","baseline","progress"].map(name=>`docs/project-control/checkpoints/2026-10-18-sales-package-history-${name}.json`),
  "docs/project-control/SALES_PLAN_REFERENCES_DELIVERY_20261018.md",
  ...["evidence","source","preservation","dependencies","resources","cleanup","cleanup-plan","cleanup-native-result","generated-restoration","baseline","progress"].map(name=>`docs/project-control/checkpoints/2026-10-18-sales-plan-references-${name}.json`),
  "docs/project-control/SALES_PLAN_SESSION_DELIVERY_20261018.md",
  ...["evidence","source","preservation","dependencies","resources","cleanup","cleanup-plan","cleanup-native-result","generated-restoration"].map(name=>`docs/project-control/checkpoints/2026-10-18-sales-plan-session-${name}.json`),
  ...["baseline","progress","interim-evidence","interim-resources","interim-cleanup-plan","interim-cleanup-native-result"].map(name=>`docs/project-control/checkpoints/2026-10-18-sales-plan-session-${name}.json`),
  "docs/project-control/SALES_FLOW_AUTHORITY_DELIVERY_20261018.md",
  ...["evidence","source","preservation","dependencies","resources","cleanup","cleanup-plan","cleanup-native-result","generated-restoration"].map(name=>`docs/project-control/checkpoints/2026-10-18-sales-flow-authority-${name}.json`),
  "docs/project-control/CATALOG_EDITOR_DELIVERY_20261018.md",
  ...["evidence","source","preservation","dependencies","resources","cleanup","cleanup-plan","cleanup-native-result","generated-restoration"].map(name=>`docs/project-control/checkpoints/2026-10-18-catalog-ui-authority-${name}.json`),
  "docs/project-control/CATALOG_SCOPE_DELIVERY_20261018.md",
  ...["evidence","source","preservation","dependencies","resources","cleanup","cleanup-plan","cleanup-native-result","generated-restoration"].map(name=>`docs/project-control/checkpoints/2026-10-18-catalog-scope-${name}.json`),
  "docs/project-control/PRODUCT_AUTHORITY_DELIVERY_20261018.md",
  ...["evidence","source","preservation","dependencies","resources","cleanup","cleanup-plan","cleanup-native-result","generated-restoration"].map(name=>`docs/project-control/checkpoints/2026-10-18-product-authority-${name}.json`),
  "docs/project-control/PRODUCT_ACCESS_DELIVERY_20261018.md",
  ...["evidence","source","preservation","dependencies","resources","cleanup","cleanup-plan","cleanup-native-result","production-smoke","generated-restoration"].map(name=>`docs/project-control/checkpoints/2026-10-18-product-access-${name}.json`),
  "docs/project-control/ERP_IDENTITY_DELIVERY_20261018.md",
  ...["evidence","source","preservation","dependencies","resources","cleanup","cleanup-plan","production-smoke","generated-restoration"].map(name=>`docs/project-control/checkpoints/2026-10-18-erp-identity-${name}.json`),
  "docs/project-control/FACTORY_PORTAL_DELIVERY_20261018.md",
  ...["evidence","source","preservation","dependencies","resources","cleanup","cleanup-plan","production-smoke","format-restoration","generated-restoration"].map(name=>`docs/project-control/checkpoints/2026-10-18-factory-portal-${name}.json`),
  "docs/integration/order-design-agent.md", "docs/integration/rule-center.md",
  "docs/integration/infinite-canvas.md", "docs/integration/creative-studio.md",
  "docs/operations/custom-pillow-workflow.md",
  "docs/operations/local-development.md",
  "docs/project-control/state.json", "docs/project-control/DELIVERY_PROTOCOL.md",
  "docs/project-control/scripts/render-status.mjs",
  "docs/project-control/CAPABILITY_RETENTION.md", "docs/project-control/capability-retention-evidence.json",
  "docs/project-control/REFACTOR_REVIEW_20261016.md",
  "docs/project-control/REFACTOR_DELIVERY_20261016.md",
  "docs/project-control/checkpoints/2026-10-16-first-refactor-evidence.json",
  "docs/project-control/checkpoints/2026-10-16-refactor-cleanup.json",
  "docs/project-control/checkpoints/2026-10-16-refactor-baseline.json",
  "docs/project-control/checkpoints/2026-10-16-preservation-check.json",
]) targets.add(target);

// Include linked local document dependencies, including the retained 1.1.51
// store-node/MCP plan. Runtime backups, credentials and raw test outputs are
// never discovered or included through this document-only closure.
const inspectedDocuments = new Set();
const documentQueue = [...targets].filter(target => target.endsWith(".md"));
while (documentQueue.length) {
  const target = documentQueue.shift();
  if (inspectedDocuments.has(target)) continue;
  inspectedDocuments.add(target);
  const markdown = await fs.readFile(path.join(repo, target), "utf8");
  for (const match of markdown.matchAll(/\]\(([^)]+)\)/g)) {
    const reference = match[1].trim().replace(/^<|>$/g, "").split(/[?#]/)[0];
    if (!reference || /^(?:[a-z][a-z0-9+.-]*:|\/)/i.test(reference)) continue;
    let decoded;
    try { decoded = decodeURIComponent(reference); } catch { continue; }
    const full = path.resolve(repo, path.dirname(target), decoded);
    const local = path.relative(repo, full).replaceAll("\\", "/");
    if (!local.startsWith("docs/") || !/\.(md|json|csv|html|svg)$/.test(local) || local.includes("/../")) continue;
    const stat = await fs.lstat(full).catch(() => null);
    if (!stat?.isFile() || stat.isSymbolicLink() || targets.has(local)) continue;
    targets.add(local);
    if (local.endsWith(".md")) documentQueue.push(local);
  }
}

const zip = new JSZip();
const payload = [];
for (const target of [...targets].sort()) {
  const full = path.resolve(repo, target);
  if (!full.startsWith(repo + path.sep)) throw new Error("Package target outside repository");
  const bytes = await fs.readFile(full);
  zip.file(target, bytes);
  payload.push({ path: target, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
}
zip.file("README-package.md", `# YummyAI PRD ${metadata.version}\n\n内容更新 ${updatedOn}，规格版本创建 ${metadata.date}。从 [蓝图首页](docs/erp-blueprint/README.md) 阅读，实施进度快照见 [项目状态](PROJECT_STATUS.md)。\n\n本包包含新版 PRD、架构/流程/数据/计划/验收依赖、主要集成说明、本轮重构证据，以及明确列出的辅助脚本和本批明确列出的变更源码。HTML 为保留的 ${metadata.prototypeVersion} 独立样稿。本包不是完整可运行源码备份；其余源码、历史材料和后续状态需要在 D:/YummyAI 工作区阅读。凭据、数据库和真实业务附件不在包中。\n\n软件、真实模型、工厂与发布的验收范围以本轮交付记录为准。\n`);
const buffer = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 } });
const verified = await JSZip.loadAsync(buffer, { checkCRC32: true });
for (const entry of payload) {
  const bytes = await verified.file(entry.path).async("nodebuffer");
  if (createHash("sha256").update(bytes).digest("hex") !== entry.sha256) throw new Error("Package payload mismatch: " + entry.path);
}
await fs.writeFile(path.join(repo, output), buffer, { flag: "wx" });
const report = {
  version: metadata.version, date: metadata.date, updatedOn, artifact: output, bytes: buffer.length,
  sha256: createHash("sha256").update(buffer).digest("hex"), entries: Object.keys(verified.files).filter(key => !verified.files[key].dir).length,
  verification: { crc32: "pass", sourcePayloadHashes: "pass", payloadFiles: payload.length }, payload,
};
await fs.writeFile(path.join(repo, `docs/project-control/checkpoints/${updatedOn}-blueprint-v${metadata.version}-package.json`), JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
console.log(JSON.stringify({ ...report, payload: undefined }));
