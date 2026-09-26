import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
const files = new Map([['/', ['index.html', 'text/html; charset=utf-8']], ['/index.html', ['index.html', 'text/html; charset=utf-8']], ['/styles.css', ['styles.css', 'text/css; charset=utf-8']]]);
const server = createServer(async (req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  if (pathname === '/favicon.ico') { res.writeHead(204); res.end(); return; }
  const file = files.get(pathname);
  if (!file) { res.writeHead(404); res.end('Not found'); return; }
  try { const body = await readFile(new URL(file[0], import.meta.url)); res.writeHead(200, { 'content-type': file[1], 'x-content-type-options': 'nosniff' }); res.end(body); }
  catch { res.writeHead(500); res.end('Internal error'); }
});
server.listen(Number(process.env.PORT || 4173), '0.0.0.0', () => console.log(`Relay website listening on ${server.address().port}`));
