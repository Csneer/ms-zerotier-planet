'use strict';

const http = require('http');
const net = require('net');

// Only decimal ports are configuration values; optional HTTPS may use zero
// to disable its listener. Number() alone also accepts values like '1e3'.
function parsePort(value, fallback, {name = 'PORT', allowZero = false} = {}) {
  const raw = value === undefined || value === null || value === ''
    ? String(fallback)
    : String(value).trim();
  if (!/^\d+$/.test(raw)) throw new Error(`Invalid ${name}`);
  const port = Number(raw);
  const minimum = allowZero ? 0 : 1;
  if (!Number.isSafeInteger(port) || port < minimum || port > 65535) {
    throw new Error(`Invalid ${name}`);
  }
  return port;
}

function config(env = process.env) {
  const primary = env.HTTP_HOST || (env.HTTP_ALL_INTERFACES ? '0.0.0.0' : '127.0.0.1');
  const extra = (env.HTTP_EXTRA_HOSTS || '').split(',').map(s => s.trim()).filter(Boolean);
  const hosts = [...new Set([primary, ...extra].map(h => h === 'localhost' ? '127.0.0.1' : h))];
  if (hosts.some(h => !net.isIP(h))) throw new Error('HTTP listeners require explicit IP addresses');
  const wildcard = h => h === '0.0.0.0' || (net.isIP(h) === 6 &&
    ['[::]', '[::ffff:0:0]'].includes(new URL(`http://[${h.split('%')[0]}]/`).hostname));
  if (extra.length && hosts.some(wildcard)) {
    throw new Error('Wildcard HTTP listeners cannot be combined with extra addresses');
  }
  const port = parsePort(env.HTTP_PORT, 3000, {name: 'HTTP_PORT'});
  return {hosts, port};
}

// One Express app/session store, several explicit listeners. A late-arriving
// optional LAN address must not take down the primary UI or the Root daemon.
function listen(app, settings, {onFatal = error => { throw error; }, retryMs = 5000} = {}) {
  let closed = false;
  const timers = new Set();
  const servers = new Set();
  const listeners = settings.hosts.map((host, index) => ({host, port: settings.port,
    primary: index === 0, state: 'starting'}));
  function open(item) {
    if (closed) return;
    const server = http.createServer(app);
    servers.add(server);
    server.once('close', () => servers.delete(server));
    server.on('error', error => {
      server.close();
      // A listener can report an asynchronous bind error while a caller is
      // already shutting the UI down.  Never turn an intentional close into
      // a fatal process error or schedule another retry in that case.
      if (closed) return;
      item.state = 'unavailable';
      item.error = error.code || 'LISTEN_ERROR';
      if (!item.primary && error.code === 'EADDRNOTAVAIL') {
        const timer = setTimeout(() => { timers.delete(timer); open(item); }, retryMs);
        timers.add(timer);
      } else {
        onFatal(error);
      }
    });
    server.listen(item.port, item.host, () => {
      if (closed) { server.close(); return; }
      item.state = 'listening';
      delete item.error;
    });
  }
  listeners.forEach(open);
  return {listeners, close() {
    if (closed) return;
    closed = true;
    timers.forEach(clearTimeout);
    timers.clear();
    listeners.forEach(item => { item.state = 'closed'; });
    servers.forEach(server => server.close());
  }};
}

module.exports = {config, listen, parsePort};
