import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root=fileURLToPath(new URL('../',import.meta.url));
const port=Number(process.argv[2] || 4188);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid loopback preview port');
const types={'.html':'text/html; charset=utf-8','.md':'text/plain; charset=utf-8','.json':'application/json; charset=utf-8','.csv':'text/csv; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.png':'image/png'};
const server=http.createServer(async(req,res) => {
  try {
    if (!['GET','HEAD'].includes(req.method || '')) { res.writeHead(405); res.end(); return; }
    const url=new URL(req.url || '/','http://127.0.0.1');
    const name=decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'overview.html';
    const file=path.resolve(root,name);
    const relative=path.relative(root,file);
    if (relative.startsWith('..') || path.isAbsolute(relative)) { res.writeHead(403); res.end('Forbidden'); return; }
    if (!(await stat(file)).isFile()) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200,{'content-type':types[path.extname(file)] || 'application/octet-stream','cache-control':'no-store','x-content-type-options':'nosniff','content-security-policy':"default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'none'; base-uri 'none'; frame-ancestors 'none'"});
    res.end(req.method === 'HEAD' ? undefined : await readFile(file));
  } catch { if (!res.headersSent) res.writeHead(404); res.end('Not found'); }
});
server.listen(port,'127.0.0.1',() => console.log(JSON.stringify({pid:process.pid,url:'http://127.0.0.1:'+port+'/overview.html',scope:'blueprint-artifacts-only'})));
for (const signal of ['SIGINT','SIGTERM']) process.on(signal,() => server.close(() => process.exit(0)));
