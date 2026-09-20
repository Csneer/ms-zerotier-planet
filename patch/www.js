#!/usr/bin/env node
'use strict';

const app = require('../app');
const https = require('https');
const fs = require('fs');
const uiListen = require('../uiListen');

function fatal(error) {
  console.error('Web listener failed:', error.code || error.message);
  process.exit(1);
}

const settings = uiListen.config();
// Preserve the upstream optional TLS listener for existing installations.
let httpsPort;
try {
  // Keep HTTPS optional (zero disables it), while rejecting malformed values
  // instead of silently treating NaN as "disabled".
  httpsPort = uiListen.parsePort(process.env.HTTPS_PORT, 0, {
    name: 'HTTPS_PORT',
    allowZero: true
  });
} catch (error) {
  fatal(error);
}

app.set('http_port', settings.port);
app.set('https_port', httpsPort || null);
app.set('https_host', process.env.HTTPS_HOST || null);
const http = uiListen.listen(app, settings, {onFatal: fatal});
app.locals.uiListeners = http.listeners;
console.log(`HTTP management listeners: ${settings.hosts.join(', ')}:${settings.port}`);

if (httpsPort) {
  const server = https.createServer({cert: fs.readFileSync('etc/tls/fullchain.pem'),
    key: fs.readFileSync('etc/tls/privkey.pem')}, app);
  server.on('error', fatal);
  server.listen(httpsPort, process.env.HTTPS_HOST || undefined);
}
