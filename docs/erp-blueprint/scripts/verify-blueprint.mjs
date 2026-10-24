import { readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Script } from 'node:vm';

const root=fileURLToPath(new URL('../',import.meta.url));
const repo=path.resolve(root,'../..');
const metadata=JSON.parse(await readFile(path.join(root,'blueprint-version.json'),'utf8'));
const report={scope:'documentation-and-standalone-design-prototype-only',version:metadata.version,date:metadata.date,prototypeVersion:metadata.prototypeVersion,checks:[],errors:[]};
const check=(name,ok,detail) => { report.checks.push({name,status:ok ? 'pass' : 'fail',detail}); if (!ok) report.errors.push(name); };
const read=(name) => readFile(path.join(root,name),'utf8');
const exists=async(file) => { try { await stat(file); return true; } catch { return false; } };
const files=[];
async function walk(dir) { for (const entry of await readdir(dir,{withFileTypes:true})) { const file=path.join(dir,entry.name); if (entry.isDirectory()) await walk(file); else files.push(file); } }
await walk(root);
const register=JSON.parse(await read('blueprint-register.json'));
check('register version matches metadata',register.version===metadata.version && register.date===metadata.date,{version:register.version,date:register.date});
for (const [key,prefix,count] of [['requirements','R',48],['backlog','B',54],['tests','T',24]]) {
  const ids=register[key].map((item) => item.id);
  check(key+' count and unique sequence',ids.length===count && new Set(ids).size===count && Array.from({length:count},(_,i) => prefix+String(i+1).padStart(2,'0')).every((id) => ids.includes(id)),{count:ids.length,expected:count});
}
const reqs=new Set(register.requirements.map((item) => item.id));
const packages=new Map(register.backlog.map((item) => [item.id,item]));
const tests=new Set(register.tests.map((item) => item.id));
const acceptance=JSON.parse(await read('acceptance-register.json'));
check('detailed acceptance version and unique IDs',acceptance.version===metadata.version && acceptance.details.length===32 && new Set(acceptance.details.map(item=>item.id)).size===32,{count:acceptance.details.length});
for(const item of acceptance.details) check(item.id+' detailed acceptance links',item.workPackages.length>0 && item.tests.length>0 && item.workPackages.every(id=>packages.has(id)) && item.tests.every(id=>tests.has(id) && item.workPackages.some(workId=>packages.get(workId)?.tests.includes(id))) && item.requirements.length>0 && item.requirements.every(id=>reqs.has(id)) && item.evidenceStatus==='not_verified' && (await read(item.source)).includes('| '+item.id+' |'),{workPackages:item.workPackages,tests:item.tests,source:item.source});
for (const item of register.backlog) {
  check(item.id+' valid references',item.requirements.length>0 && item.tests.length>0 && item.requirements.every((id) => reqs.has(id)) && item.dependencies.every((id) => packages.has(id)) && item.tests.every((id) => tests.has(id)) && /^S[0-7]$/.test(item.stage),{requirements:item.requirements,tests:item.tests});
}
const visited=new Set(), visiting=new Set();
function visit(id) { if (visiting.has(id)) throw new Error('Cycle at '+id); if (visited.has(id)) return; visiting.add(id); for (const dependency of packages.get(id).dependencies) { if (Number(packages.get(dependency).stage.slice(1))>Number(packages.get(id).stage.slice(1))) throw new Error('Future stage dependency '+id+' / '+dependency); visit(dependency); } visiting.delete(id); visited.add(id); }
let dependencyError=null;
try { for (const id of packages.keys()) visit(id); } catch(error) { dependencyError=error.message; }
check('backlog dependency graph',!dependencyError,dependencyError || 'Acyclic and no dependency on later stage');
check('all requirements linked to work and tests',[...reqs].every((id) => register.backlog.some((item) => item.requirements.includes(id) && item.tests.length)),{covered:reqs.size});
check('all scenarios referenced',[...tests].every((id) => register.backlog.some((item) => item.tests.includes(id))),{covered:tests.size});
const essential=['README.md','overview.html','prototype.html','THIRD_PARTY_NOTICES.md','requirements.csv','backlog.csv','12-requirements-traceability.md','14-critical-reading-agent-decisions.md'];
for (const file of essential) check('artifact exists: '+file,await exists(path.join(root,file)),file);
const broken=[];
let localLinks=0;
for (const file of files.filter((file) => file.endsWith('.md'))) {
  const content=await readFile(file,'utf8');
  check('balanced fences: '+path.basename(file),(content.match(/^~~~.*$/gm) || []).length%2===0,'Markdown fenced blocks');
  for (const match of content.matchAll(/\[[^\]]*\]\((?:<([^>]+)>|([^\s)]+))\)/g)) {
    const target=match[1] || match[2];
    if (/^(?:https?:|mailto:|data:|codex:)/i.test(target) || target.startsWith('#')) continue;
    const clean=decodeURIComponent(target.split('#')[0]);
    localLinks++;
    if (!(await exists(path.resolve(path.dirname(file),clean)))) broken.push({source:path.relative(root,file),target});
  }
}
check('local Markdown links',broken.length===0,{checked:localLinks,broken});
const brokenHtml=[]; let htmlLinks=0;
for (const name of ['overview.html','prototype.html']) {
  const content=await read(name);
  for (const match of content.matchAll(/href="([^"]+)"/g)) {
    const target=match[1];
    if (/^(?:https?:|mailto:|data:|#)/i.test(target)) continue;
    htmlLinks++;
    if (!(await exists(path.resolve(root,decodeURIComponent(target.split('#')[0]))))) brokenHtml.push({source:name,target});
  }
}
check('rendered HTML entry links',brokenHtml.length===0,{checked:htmlLinks,broken:brokenHtml});
const trace=await read('12-requirements-traceability.md');
check('traceability covers 48 requirements',[...reqs].every((id) => new RegExp('^\\| '+id+' ','m').test(trace)) && (trace.match(/^\| R\d{2} /gm) || []).length===48,'48 rows with stable IDs');
function parseCsv(input) {
  const rows=[]; let row=[],cell='',quoted=false;
  const text=input.replace(/^\uFEFF/,'');
  for (let i=0;i<text.length;i++) { const c=text[i]; if (c==='"') { if (quoted && text[i+1]==='"') {cell+='"';i++;} else quoted=!quoted; } else if (c===',' && !quoted) {row.push(cell);cell='';} else if (c==='\n' && !quoted) {row.push(cell.replace(/\r$/,''));rows.push(row);row=[];cell='';} else cell+=c; }
  if (cell || row.length) {row.push(cell);rows.push(row);}
  if (quoted) throw new Error('Unclosed CSV quote');
  return rows;
}
for (const [file,count,ids] of [['requirements.csv',48,reqs],['backlog.csv',54,new Set(packages.keys())]]) {
  const csv=parseCsv(await read(file));
  check(file+' valid UTF-8 CSV roundtrip',csv.length===count+1 && csv.slice(1).every((row) => ids.has(row[0])) && new Set(csv.slice(1).map((row) => row[0])).size===count,{rows:csv.length-1});
}
const prototype=await read('prototype.html');
let scriptError=null;
try { for (const match of prototype.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)) new Script(match[1]); } catch(error) { scriptError=error.message; }
check('bundled prototype JavaScript parses',scriptError===null,scriptError || 'All inline application scripts parsed');
check('prototype bundled without unresolved slots',!prototype.includes('/*__PROTOTYPE_') && !prototype.includes('{{icon:'),'CSS, JavaScript and 19 Lucide icons embedded');
check('prototype has no network execution',!/(?:\bfetch\s*\(|new\s+(?:XMLHttpRequest|WebSocket)|<script[^>]+src=)/.test(prototype),'Only local fictional UI state is changed');
check('prototype contains explicit demo boundary',prototype.includes('虚构') && prototype.includes('不连接') && prototype.includes('设计样稿'),'Visible fictional-data notice');
let browser=null;
if (await exists(path.join(root,'evidence/browser-check.json'))) browser=JSON.parse(await read('evidence/browser-check.json'));
check('browser verification recorded',!!browser && browser.status==='pass' && browser.assertions?.length>=12 && browser.assertions.every((item) => item.status==='pass'),browser ? {assertions:browser.assertions?.length,widths:browser.widths} : 'Run visible-browser checks before final delivery');
check('browser evidence matches delivered HTML',!!browser && browser.prototypeSha256===createHash('sha256').update(prototype).digest('hex') && browser.overviewSha256===createHash('sha256').update(await read('overview.html')).digest('hex'),'SHA-256 binds browser evidence to both delivered HTML files');
if (browser) for (const screenshot of browser.screenshots || []) check('screenshot exists: '+screenshot,await exists(path.join(root,screenshot)),screenshot);
const baselineArg=process.argv.indexOf('--baseline');
const baselineFile=baselineArg>=0 ? path.resolve(repo,process.argv[baselineArg+1] || 'MISSING_BASELINE_ARGUMENT') : null;
if (baselineFile) {
  const baseline=JSON.parse((await readFile(baselineFile,'utf8')).replace(/^\uFEFF/,''));
  const changed=[];
  for (const entry of baseline.entries) {
    const absolute=path.join(repo,entry.path);
    let hash=null; try { hash=createHash('sha256').update(await readFile(absolute)).digest('hex').toUpperCase(); } catch { /* A missing file must differ from the saved baseline. */ }
    if (hash!==entry.sha256) changed.push(entry.path);
  }
  check('pre-existing changed files preserved',changed.length===0,{paths:baseline.entries.length,changed});
}
const forbidden=[];
for (const file of files.filter((file) => /\.(?:md|js|mjs|html|css|json|csv)$/.test(file))) {
  const content=await readFile(file,'utf8');
  if (/\b(?:sk-[A-Za-z0-9]{25,}|ghp_[A-Za-z0-9]{25,})\b/.test(content)) forbidden.push(path.relative(root,file));
}
check('no credential-shaped values in delivery',forbidden.length===0,{files:forbidden});
report.status=report.errors.length ? 'fail' : 'pass';
report.summary={requirements:48,workPackages:54,testScenarios:24,localLinks,checks:report.checks.length,failed:report.errors.length};
await writeFile(path.join(root,'verification-report.json'),JSON.stringify(report,null,2)+'\n');
const manifest=[];
for (const file of files.filter((file) => !['delivery-manifest.json','verification-report.json'].includes(path.basename(file))).sort()) manifest.push({path:path.relative(root,file).replaceAll('\\','/'),bytes:(await stat(file)).size,sha256:createHash('sha256').update(await readFile(file)).digest('hex')});
await writeFile(path.join(root,'delivery-manifest.json'),JSON.stringify({scope:report.scope,version:metadata.version,prototypeVersion:metadata.prototypeVersion,files:manifest},null,2)+'\n');
console.log(JSON.stringify({status:report.status,...report.summary,errors:report.errors}));
process.exitCode=report.errors.length ? 1 : 0;
