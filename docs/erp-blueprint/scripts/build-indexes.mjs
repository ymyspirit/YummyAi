import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = (name) => readFile(path.join(root, name), 'utf8');
const metadata = JSON.parse(await read('blueprint-version.json'));
const rows = (text, prefix) => text.split(/\r?\n/).filter((line) => new RegExp('^\\| ' + prefix + '\\d{2} \\|').test(line)).map((line) => line.split('|').slice(1, -1).map((cell) => cell.trim()));
const requirements = rows(await read('01-product-requirements.md'), 'R').map(([id, title, acceptance, stage]) => ({ id, title, acceptance, stage }));
const backlog = rows(await read('07-engineering-backlog.md'), 'B').map(([id, stage, title, refs, dependencies, tests]) => ({ id, stage, title, requirements: refs.match(/R\d{2}/g) ?? [], dependencies: dependencies.match(/B\d{2}/g) ?? [], tests: tests.match(/T\d{2}/g) ?? [] }));
const tests = rows(await read('08-quality-security-operations.md'), 'T').map(([id, subject, scenarios, evidence]) => ({ id, subject, scenarios, evidence }));
const csvCell = (value) => '"' + String(value).replaceAll('"', '""') + '"';
const csv = (values) => '\uFEFF' + values.map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
const designFor = (n) => {
  if(n===4)return '[六角色固定评测](../integration/role-benchmarks.md) / [六角色当前核验](../project-control/ROLE_BENCHMARK_PROGRESS_20261021.md) / [采购经营固定评测](../integration/business-benchmarks.md) / [当前业务接入](../project-control/BUSINESS_BENCHMARK_PROGRESS_20261021.md) / [固定数据集与完全成本](../integration/knowledge-benchmarks.md) / [可信知识评测执行](../integration/knowledge-evaluation-execution.md) / [知识治理](16-knowledge-governance-specification.md) / [Harness](15-agent-harness-specification.md)';
  if(n===20)return '[六角色固定评测](../integration/role-benchmarks.md) / [六角色当前核验](../project-control/ROLE_BENCHMARK_PROGRESS_20261021.md) / [采购经营固定评测](../integration/business-benchmarks.md) / [当前业务接入](../project-control/BUSINESS_BENCHMARK_PROGRESS_20261021.md) / [固定数据集与完全成本](../integration/knowledge-benchmarks.md) / [可信知识评测执行](../integration/knowledge-evaluation-execution.md) / [生产恢复](../integration/production-command-recovery.md) / [Harness](15-agent-harness-specification.md) / [创意迁移](17-creative-capability-migration.md) / [质量与运行](08-quality-security-operations.md)';
  if(n===23||n===25)return '[作废观察核对](../integration/factory-erp-void-reviews.md) / [核对实施进度](../project-control/FACTORY_ERP_VOID_REVIEW_PROGRESS_20261021.md) / [绑定解除与更正](../integration/factory-erp-binding-corrections.md) / [更正实施进度](../project-control/FACTORY_ERP_BINDING_PROGRESS_20261021.md) / [来源保留](../integration/factory-erp-source-retention.md) / [原文件整组导入](../integration/factory-erp-status-import.md) / [业务流程](02-business-workflows.md)';
  if(n===34)return '[完整历史与原ID](../integration/advertising-history.md) / [历史核验](../project-control/ADVERTISING_HISTORY_PROGRESS_20261021.md) / [实际列与固定测量](../integration/advertising-measurement.md) / [测量核验](../project-control/ADVERTISING_MEASUREMENT_PROGRESS_20261021.md) / [广告当前身份与账户权限](../integration/advertising-authority.md) / [权限核验](../project-control/ADVERTISING_AUTHORITY_PROGRESS_20261021.md) / [广告报表与版本](../integration/advertising-workbench.md) / [经营模型](10-operating-model.md) / [质量与运行](08-quality-security-operations.md)';
  if([32,33,44].includes(n))return '[历史执行结果](../integration/finance-recorded-results.md) / [历史结果核对](../project-control/FINANCE_RECEIPT_PROGRESS_20261021.md) / [财务原提交与跨会话恢复](../integration/finance-original-requests.md) / [当前原提交验证](../project-control/FINANCE_COMMAND_PROGRESS_20261021.md) / [费用分摊版本](../integration/finance-cost-allocation.md) / [当前归属验证](../project-control/FINANCE_COST_ALLOCATION_PROGRESS_20261021.md) / [完整台账读取](../integration/finance-ledger.md) / [分页与原ID验证](../project-control/FINANCE_LEDGER_PROGRESS_20261021.md) / [应付更正与实际退款证据](../integration/finance-payable-adjustments.md) / [当前更正验证](../project-control/FINANCE_ADJUSTMENTS_PROGRESS_20261021.md) / [来源与当前权限](../integration/finance-source-authority.md) / [当前财务整改](../project-control/FINANCE_AUTHORITY_PROGRESS_20261021.md) / [实际应付与付款核销](../integration/finance-payables.md) / [当前核销进度](../project-control/FINANCE_PAYABLES_PROGRESS_20261021.md) / [财务精度与汇率](../integration/finance.md) / [货币验证](../project-control/FINANCE_MONETARY_PROGRESS_20261021.md) / [数据契约](04-data-and-contracts.md) / [质量与运行](08-quality-security-operations.md)';
  if(n===15)return '[店铺节点总体架构](03-system-architecture.md) / [数据与工具专项](../upgrade-plans/data-tools-mcp-2026-10-18/PRD.md) / [质量与运行](08-quality-security-operations.md)';
  if(n===38)return '[全ERP Agent接入](18-erp-agent-integration-specification.md) / [当前接入覆盖](../project-control/ERP_AGENT_INTEGRATION_PROGRESS_20261022.md) / [统一 MCP 与节点边界](03-system-architecture.md) / [专项最终范围](../upgrade-plans/data-tools-mcp-2026-10-18/FINAL-INTEGRATION-SCOPE.md) / [质量与运行](08-quality-security-operations.md)';
  if(n===39)return '[持久任务与节点回执](03-system-architecture.md) / [Harness](15-agent-harness-specification.md) / [生产恢复](../integration/production-command-recovery.md) / [质量与运行](08-quality-security-operations.md)';
  if(n===29)return '[只读物流](../integration/shipos-readonly.md) / [观察与来源事务](../project-control/SHIPOS_OBSERVATION_PROGRESS_20261020.md) / [Harness](15-agent-harness-specification.md) / [数据契约](04-data-and-contracts.md)';
  if(n===28)return '[库存契约](../integration/inventory.md) / [来料与原提交](../integration/incoming-inspection.md) / [当前进展](../project-control/ARRIVAL_INSPECTION_PROGRESS_20261020.md) / [分类及收货依据](../project-control/INVENTORY_RECEIVING_PROGRESS_20261020.md) / [实际物料](../integration/production-material-execution.md)';
  if(n===27)return '[供应商纠正设计](../architecture/procurement-invoice-reconciliation.md) / [当前核对验收](../project-control/INVOICE_RECONCILIATION_PROGRESS_20261021.md) / [发票恢复设计](../architecture/procurement-invoice-commands.md) / [当前发票验收](../project-control/INVOICE_COMMAND_PROGRESS_20261020.md) / [计量/部分发票](../architecture/procurement-measurement-and-invoices.md) / [当前精度验收](../project-control/PROCUREMENT_PRECISION_PROGRESS_20261020.md) / [采购原请求](../integration/procurement-original-requests.md) / [采购核对](../project-control/PROCUREMENT_CYCLE_AUDIT_20261020.md) / [采购契约](../integration/procurement.md) / [来料与原提交](../integration/incoming-inspection.md) / [来料检验设计](../architecture/incoming-material-inspection.md)';
  if([23,25].includes(n))return '[来源保留与清理](../integration/factory-erp-source-retention.md) / [本批生命周期验收](../project-control/FACTORY_ERP_LIFECYCLE_PROGRESS_20261021.md) / [绑定更正设计](../architecture/factory-erp-binding-corrections.md) / [工厂原文件与整组绑定](../integration/factory-erp-status-import.md) / [本批导入验收](../project-control/FACTORY_ERP_IMPORT_PROGRESS_20261021.md) / [生产恢复](../integration/production-command-recovery.md) / [生产入口](../integration/production-entry.md) / [制造交付](../integration/manufacturing-delivery.md) / [业务流程](02-business-workflows.md)';
  if(n===12)return '[制造版本](../integration/manufacturing-recipes.md) / [生产绑定](../integration/production-manufacturing.md) / [实际物料](../integration/production-material-execution.md) / [本批进展](../project-control/MATERIAL_ADOPTION_PROGRESS_20261020.md) / [制造交付](../integration/manufacturing-delivery.md)';
  if(n===1)return '[普通运行采用](../integration/normal-runtime-adoption.md) / [个人本地运行](../integration/local-personal-runtime.md) / [本人身份](../integration/erp-identity.md) / [架构](03-system-architecture.md)';
  if([41,43].includes(n))return '[普通运行采用](../integration/normal-runtime-adoption.md) / [历史升级](../integration/legacy-runtime-upgrade.md) / [迁移](11-current-state-and-migration.md) / [质量与运行](08-quality-security-operations.md)';
  if(n===2)return '[工厂协作](../integration/factory-portal.md) / [架构](03-system-architecture.md) / [质量与运行](08-quality-security-operations.md)';
  if(n===5)return '[研究采集授权](../integration/research-authority.md) / [业务流程](02-business-workflows.md) / [数据契约](04-data-and-contracts.md)';
  if(n===19)return '[订单与跟进授权](../integration/order-authority.md) / [业务流程](02-business-workflows.md) / [数据契约](04-data-and-contracts.md)';
  if (n === 36) return '[责任与提醒](../integration/workflow-responsibility.md) / [工作流待办](../integration/workflow-task-inbox.md) / [订单跟进](../integration/order-line-responsibility.md) / [业务流程](02-business-workflows.md)';
  if (n === 4) return '[知识治理](16-knowledge-governance-specification.md) / [Harness](15-agent-harness-specification.md)';
  if ([20,22,39,43].includes(n)) return '[生产恢复](../integration/production-command-recovery.md) / [Harness](15-agent-harness-specification.md) / [创意迁移](17-creative-capability-migration.md) / [质量与运行](08-quality-security-operations.md)';
  if (n === 13) return '[单张图片报价确认与预算](../integration/studio-paid-image.md) / [付费图片开发验收](../project-control/STUDIO_PAID_IMAGE_PROGRESS_20261024.md) / [原生视频完整目录与预检](../integration/studio-video-directory.md) / [业务流程](02-business-workflows.md) / [创意迁移](17-creative-capability-migration.md)';
  if ([8,9,37].includes(n)) return '[业务流程](02-business-workflows.md) / [创意迁移](17-creative-capability-migration.md)';
  if ([1,2,3,18,38,39,40,41,43].includes(n)) return '[架构](03-system-architecture.md) / [质量与运行](08-quality-security-operations.md)';
  if ([4,20,34,46,48].includes(n)) return '[业务流程](02-business-workflows.md) / [经营模型](10-operating-model.md) / [材料辩证阅读](14-critical-reading-agent-decisions.md)';
  return '[业务流程](02-business-workflows.md) / [数据契约](04-data-and-contracts.md) / [界面设计](05-experience-design.md)';
};
let trace = '# 需求到设计、开发与验收的追踪矩阵\n\n版本：' + metadata.version + ' · 此表由稳定需求和工作包编号生成。全部“目标待实现/待验收”指 ERP 功能，不指本轮文档完成情况。\n\n';
trace += '| 需求 | 设计与流程 | 工作包 | 验收场景 | 首次验收阶段 | 实现证据状态 |\n| --- | --- | --- | --- | --- | --- |\n';
const traceRows = [];
for (const requirement of requirements) {
  const packages = backlog.filter((item) => item.requirements.includes(requirement.id));
  const testIds = [...new Set(packages.flatMap((item) => item.tests))].sort();
  const recovery = ['R13','R20','R21','R22','R37'].includes(requirement.id) ? '[创作恢复与取消终态](../integration/creative-recovery-state.md) / ' : '';
  trace += '| ' + requirement.id + ' ' + requirement.title + ' | ' + recovery + designFor(Number(requirement.id.slice(1))) + ' | ' + packages.map((item) => item.id).join(' ') + ' | ' + testIds.join(' ') + ' | ' + requirement.stage + ' | 目标待实现/待验收 |\n';
  traceRows.push([requirement.id, requirement.title, requirement.stage, packages.map((item) => item.id).join(' '), testIds.join(' '), requirement.acceptance, '目标待实现/待验收']);
}
trace += '\n## 验收证据登记\n\n软件开发时，为每项补充实际 commit/PR、命令与结果、浏览器及文件证据、外部权限与回执、测试资源清理。没有完成必要证据的需求不能改为已完成。\n\n';
trace += '本轮检查文件、链接、编号、依赖、覆盖及独立样稿，见 [VERIFICATION](VERIFICATION.md)。这些不能证明 ERP 的 T01—T24 已通过。\n\n';
trace += '维护源文件后运行 `node docs/erp-blueprint/scripts/build-indexes.mjs` 更新本表、JSON 与 CSV，再运行文档验证脚本。\n';
await writeFile(path.join(root, '12-requirements-traceability.md'), trace);
await writeFile(path.join(root, 'requirements.csv'), csv([['需求','标题','阶段','工作包','验收场景','可验收结果','实现状态'], ...traceRows]));
await writeFile(path.join(root, 'backlog.csv'), csv([['工作包','阶段','交付','需求','依赖','验收场景','状态'], ...backlog.map((item) => [item.id,item.stage,item.title,item.requirements.join(' '),item.dependencies.join(' '),item.tests.join(' '),'规划'])]));
await writeFile(path.join(root, 'blueprint-register.json'), JSON.stringify({ ...metadata, requirements, backlog, tests }, null, 2) + '\n');
const details = [];
for (const source of ['15-agent-harness-specification.md','16-knowledge-governance-specification.md','17-creative-capability-migration.md']) {
  for (const line of (await read(source)).split(/\r?\n/).filter(line => /^\| [HKC]\d{2} \|/.test(line))) {
    const [id, acceptance, references] = line.split('|').slice(1,-1).map(cell => cell.trim());
    const workPackages = references.match(/B\d{2}/g) ?? [];
    details.push({id,source,acceptance,workPackages,tests:references.match(/T\d{2}/g) ?? [],requirements:[...new Set(workPackages.flatMap(id => backlog.find(item => item.id === id)?.requirements ?? []))].sort(),evidenceStatus:'not_verified'});
  }
}
await writeFile(path.join(root, 'acceptance-register.json'), JSON.stringify({version:metadata.version,date:metadata.date,scope:'Detailed acceptance requirements; not test results',details},null,2)+'\n');
console.log(JSON.stringify({ version:metadata.version, requirements:requirements.length, workPackages:backlog.length, scenarios:tests.length, detailedScenarios:details.length, generated:['12-requirements-traceability.md','requirements.csv','backlog.csv','blueprint-register.json','acceptance-register.json'] }));
