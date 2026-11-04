// Local preview and browser-test server. Node's standard library only; never
// expose repository internals or follow a symlink outside the selected root.
import { createServer } from 'node:http';
import { realpathSync } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

export function createSiteServer(root) {
  const base = realpathSync(root);
  return createServer(async (request, response) => {
    function reject(status) {
      response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end(request.method === 'HEAD' ? undefined : `${status}\n`);
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.setHeader('Allow', 'GET, HEAD');
      reject(405);
      return;
    }
    let pathname;
    try { pathname = decodeURIComponent(request.url.split('?')[0]); }
    catch { reject(400); return; }
    if (!pathname.startsWith('/') || /[\\\0]/.test(pathname) ||
        pathname.split('/').some((part) => part.startsWith('.'))) {
      reject(403);
      return;
    }
    try {
      const path = await realpath(resolve(base, '.' + (pathname === '/' ? '/index.html' : pathname)));
      if (!path.startsWith(base + sep) ||
          path.slice(base.length + 1).split(sep).some((part) => part.startsWith('.'))) {
        reject(403);
        return;
      }
      const file = await stat(path);
      if (!file.isFile()) { reject(404); return; }
      const body = request.method === 'HEAD' ? undefined : await readFile(path);
      response.writeHead(200, {
        'Content-Type': mime[extname(path)] || 'application/octet-stream',
        'Content-Length': file.size,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      response.end(body);
    } catch (error) {
      reject(error.code === 'ENOENT' || error.code === 'ENOTDIR' ? 404 : 500);
    }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.argv[2] || 4173);
  if (process.argv.length > 3 || !Number.isInteger(port) || port < 1 || port > 65535) {
    console.error('Usage: node tools/serve.mjs [port]');
    process.exit(1);
  }
  const server = createSiteServer(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
  const sockets = new Set();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  server.listen(port, '127.0.0.1', () => console.log(`Preview: http://127.0.0.1:${port}/`));
  function stop() {
    server.close();
    for (const socket of sockets) socket.destroy();
  }
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}
