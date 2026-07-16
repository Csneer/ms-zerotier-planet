'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const port = Number.parseInt(process.env.FILE_SERVER_PORT || '3000', 10);
const distPath = '/app/dist';
const secretKeyPath = '/app/config/file_server.key';

function loadOrCreateKey() {
  if (process.env.FILE_KEY) return process.env.FILE_KEY;
  try {
    const current = fs.readFileSync(secretKeyPath, 'utf8').trim();
    if (current) return current;
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }

  const key = crypto.randomBytes(24).toString('hex');
  fs.writeFileSync(secretKeyPath, `${key}\n`, { mode: 0o600, flag: 'wx' });
  return key;
}

const secretKey = loadOrCreateKey();
try {
  fs.chmodSync(secretKeyPath, 0o600);
} catch (err) {
  // FILE_KEY can deliberately supply an ephemeral key without a persisted
  // key file. Any other missing/error condition remains fatal.
  if (!process.env.FILE_KEY || err.code !== 'ENOENT') throw err;
}

function authorized(candidate) {
  if (typeof candidate !== 'string') return false;
  const left = Buffer.from(candidate);
  const right = Buffer.from(secretKey);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

const server = http.createServer((req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store');

  let requestUrl;
  try {
    // A fixed base avoids treating an attacker-controlled Host header as URL
    // syntax. Absolute-form request targets are still parsed safely below.
    requestUrl = new URL(req.url, 'http://localhost');
  } catch (_) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Bad Request\n');
  }
  if (requestUrl.pathname === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('ok\n');
  }

  if (!authorized(requestUrl.searchParams.get('key'))) {
    res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Unauthorized\n');
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8', Allow: 'GET, HEAD' });
    return res.end('Method Not Allowed\n');
  }

  let name;
  try {
    name = path.basename(decodeURIComponent(requestUrl.pathname));
  } catch (_) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Bad Request\n');
  }
  if (!name || (name !== 'planet' && !/^[0-9a-f]{16}\.moon$/.test(name))) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Not Found\n');
  }

  const filePath = path.join(distPath, name);
  fs.open(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW, (openError, fd) => {
    if (openError) {
      const missing = openError.code === 'ENOENT' || openError.code === 'ELOOP';
      res.writeHead(missing ? 404 : 500, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end(missing ? 'Not Found\n' : 'Server Error\n');
    }
    fs.fstat(fd, (statError, stat) => {
      if (statError || !stat.isFile()) {
        fs.close(fd, () => {});
        res.writeHead(statError ? 500 : 404, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end(statError ? 'Server Error\n' : 'Not Found\n');
      }
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': stat.size,
        'Content-Disposition': `attachment; filename="${name}"`,
      });
      if (req.method === 'HEAD') {
        fs.close(fd, () => res.end());
        return;
      }
      fs.createReadStream(null, { fd, autoClose: true }).on('error', () => res.destroy()).pipe(res);
    });
  });
});

server.requestTimeout = 10_000;
server.headersTimeout = 12_000;
server.keepAliveTimeout = 5_000;
server.listen(port, '0.0.0.0', () => console.log(`[files] listening on ${port}`));
