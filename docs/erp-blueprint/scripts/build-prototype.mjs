import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const repo = path.resolve(root, '../..');
const require = createRequire(path.join(repo, 'apps/web/package.json'));
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const lucide = require('lucide-react');
const [template, css, js] = await Promise.all([
  readFile(path.join(root,'design/prototype.template.html'),'utf8'),
  readFile(path.join(root,'design/prototype.css'),'utf8'),
  readFile(path.join(root,'design/prototype.js'),'utf8'),
]);
const names = new Set([...template.matchAll(/\{\{icon:(\w+)\}\}/g)].map((match) => match[1]));
for (const match of js.matchAll(/icon\('([A-Za-z0-9]+)'\)/g)) names.add(match[1]);
const icons = {};
for (const name of names) {
  if (!lucide[name]) throw new Error('Missing Lucide icon: '+name);
  icons[name] = renderToStaticMarkup(React.createElement(lucide[name],{size:18,'aria-hidden':true,focusable:false}));
}
const iconHtml = template.replace(/\{\{icon:(\w+)\}\}/g,(_match,name) => icons[name]);
const output = iconHtml.replace('/*__PROTOTYPE_CSS__*/',() => css).replace('/*__PROTOTYPE_JS__*/',() => 'const ICONS = '+JSON.stringify(icons)+';\n'+js);
await writeFile(path.join(root,'prototype.html'),output);
let license = 'Lucide icons: ISC license. See https://lucide.dev/license';
const lucideRoot = path.resolve(path.dirname(require.resolve('lucide-react')),'../..');
for (const file of ['LICENSE','LICENSE.txt']) {
  try { license = await readFile(path.join(lucideRoot,file),'utf8'); break; } catch { /* Try the alternative name, then retain the official license link. */ }
}
await writeFile(path.join(root,'THIRD_PARTY_NOTICES.md'),'# Third-party notices\n\n## Lucide icons\n\nThe standalone prototype embeds SVGs rendered from the existing lucide-react dependency. It makes no network request to load icons.\n\nOfficial source: https://github.com/lucide-icons/lucide\n\n'+license+'\n\n## Design references\n\nNext Shadcn Dashboard Starter and shadcn/ui were consulted as design references. Their application, authentication, billing, and sample data were not copied.\n');
console.log(JSON.stringify({output:'docs/erp-blueprint/prototype.html',bytes:Buffer.byteLength(output),icons:names.size,selfContained:true}));
