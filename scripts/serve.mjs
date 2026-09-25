// Serves the production build (dist/web) with the local example data (data/) next to it:
//   npm run build && node scripts/serve.mjs [port]   ->  http://127.0.0.1:5180/
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.argv[2]) || 5180;
const types = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.aml': 'application/xml', '.dae': 'model/vnd.collada+xml', '.xml': 'application/xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
};

http.createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  const base = p.startsWith('/data/') ? root : path.join(root, 'dist', 'web');
  const file = path.normalize(path.join(base, p === '/' ? '/index.html' : p));
  if (!file.startsWith(base)) { res.writeHead(403).end(); return; }
  fs.stat(file, (err, stat) => {
    if (err || !stat.isFile()) { res.writeHead(404).end('not found'); return; }
    res.writeHead(200, { 'Content-Type': types[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Content-Length': stat.size });
    fs.createReadStream(file).pipe(res);
  });
}).listen(port, '127.0.0.1', () => console.log(`AML 3D Viewer build: http://127.0.0.1:${port}/`));
