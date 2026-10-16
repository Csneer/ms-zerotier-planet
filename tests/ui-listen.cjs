'use strict';

const assert = require('node:assert/strict');
const {EventEmitter, once} = require('node:events');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const vm = require('node:vm');
const uiListen = require('../patch/uiListen');

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) {
  const deadline = Date.now() + 2000;
  while (!check()) {
    assert.ok(Date.now() < deadline, 'listener did not reach expected state');
    await pause(10);
  }
}

function testConfig() {
  assert.deepEqual(uiListen.config({}), {hosts: ['127.0.0.1'], port: 3000});
  assert.deepEqual(uiListen.config({HTTP_HOST: 'localhost', HTTP_PORT: '3443',
    HTTP_EXTRA_HOSTS: '127.0.0.1, 172.16.100.97,172.16.100.97'}), {
    hosts: ['127.0.0.1', '172.16.100.97'], port: 3443
  });
  for (const host of ['example.com', '172.16.0.0/16', '172.16.*', '127.0.0.1:3443']) {
    assert.throws(() => uiListen.config({HTTP_HOST: host}));
    assert.throws(() => uiListen.config({HTTP_EXTRA_HOSTS: host}));
  }
  for (const host of ['0.0.0.0', '::', '0:0:0:0:0:0:0:0', '::0.0.0.0',
    '::ffff:0.0.0.0', '0:0:0:0:0:ffff:0:0']) {
    assert.throws(() => uiListen.config({HTTP_HOST: host, HTTP_EXTRA_HOSTS: '127.0.0.1'}));
    assert.throws(() => uiListen.config({HTTP_EXTRA_HOSTS: host}));
    assert.throws(() => uiListen.config({HTTP_HOST: host, HTTP_EXTRA_HOSTS: host}));
  }
  for (const port of ['0', '-1', '65536', 'invalid', '123abc', '1e3', '0x1234', '3.5', ' ']) {
    assert.throws(() => uiListen.config({HTTP_PORT: port}), /Invalid HTTP_PORT/);
  }
  assert.equal(uiListen.parsePort(undefined, 0, {allowZero: true}), 0);
  assert.equal(uiListen.parsePort('0', 0, {allowZero: true}), 0);
  assert.equal(uiListen.parsePort('65535', 0), 65535);
  console.log('PASS: explicit IPs and decimal ports; wildcard aliases cannot bypass extra-listener restrictions');
}

function testRetryAndClose() {
  const servers = [], timers = new Map(), errors = [];
  let timerId = 0;
  class Server extends EventEmitter {
    listen(port, host, callback) { Object.assign(this, {port, host, callback}); }
    close() { this.closed = true; this.emit('close'); }
  }
  // Simulate a late-arriving LAN address without modifying production APIs or
  // assigning test addresses to the host's network interfaces.
  const fakeModule = {exports: {}};
  const context = {
    module: fakeModule, URL,
    require: name => name === 'http' ? {createServer: app => {
      const server = new Server();
      server.app = app;
      servers.push(server);
      return server;
    }} : require(name),
    setTimeout: callback => {
      const id = ++timerId;
      timers.set(id, () => { timers.delete(id); callback(); });
      return id;
    },
    clearTimeout: id => timers.delete(id)
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../patch/uiListen.js'), 'utf8'), context);
  const app = () => {};
  const listener = fakeModule.exports.listen(app, {
    hosts: ['127.0.0.1', '192.0.2.253'], port: 3443
  }, {onFatal: error => errors.push(error), retryMs: 1});
  servers[0].callback();
  servers[1].emit('error', {code: 'EADDRNOTAVAIL'});
  assert.equal(listener.listeners[0].state, 'listening');
  assert.equal(listener.listeners[1].state, 'unavailable');
  assert.equal(timers.size, 1);
  const callback = [...timers.values()][0];
  callback();
  assert.equal(servers.length, 3);
  servers[2].callback();
  assert.equal(listener.listeners[1].state, 'listening');
  assert.ok(!Object.hasOwn(listener.listeners[1], 'error'));
  assert.ok(servers.every(server => server.app === app));
  servers[2].emit('error', {code: 'EADDRNOTAVAIL'});
  listener.close();
  listener.close();
  assert.equal(timers.size, 0);
  assert.ok(servers.every(server => server.closed));
  assert.ok(listener.listeners.every(item => item.state === 'closed'));
  servers[0].emit('error', {code: 'EADDRINUSE'});
  assert.equal(errors.length, 0, 'late close errors must not invoke onFatal');

  const failing = fakeModule.exports.listen(app, {hosts: ['127.0.0.1'], port: 3443}, {
    onFatal: error => errors.push(error)
  });
  servers.at(-1).emit('error', {code: 'EADDRNOTAVAIL'});
  assert.equal(errors[0].code, 'EADDRNOTAVAIL', 'a missing primary address is fatal');
  assert.equal(timers.size, 0);
  failing.close();

  const conflict = fakeModule.exports.listen(app, {hosts: ['127.0.0.1', '127.0.0.2'], port: 3443}, {
    onFatal: error => errors.push(error)
  });
  servers.at(-1).emit('error', {code: 'EADDRINUSE'});
  assert.equal(errors[1].code, 'EADDRINUSE', 'port conflicts must not be silently retried');
  assert.equal(timers.size, 0);
  conflict.close();
  console.log('PASS: optional IP retry recovers; close cancels retries; primary errors and port conflicts are fatal');
}

async function testRealListeners() {
  const reservation = http.createServer().listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  let requests = 0;
  const errors = [];
  const listener = uiListen.listen((req, res) => res.end(String(++requests)), {
    hosts: ['127.0.0.1', '127.0.0.2'], port
  }, {onFatal: error => errors.push(error)});
  try {
    await until(() => errors.length || listener.listeners.every(item => item.state === 'listening'));
    assert.deepEqual(errors, []);
    const get = host => new Promise((resolve, reject) => {
      http.get({host, port, agent: false}, res => {
        let body = '';
        res.on('data', chunk => { body += chunk; });
        res.on('end', () => resolve(body));
      }).on('error', reject);
    });
    assert.equal(await get('127.0.0.1'), '1');
    assert.equal(await get('127.0.0.2'), '2');
  } finally { listener.close(); }
  console.log('PASS: two real loopback listeners share one HTTP app');
}

function runEntrypoint(env) {
  const sets = new Map(), reads = [], calls = [];
  const app = Object.assign(() => {}, {locals: {}, set: (key, value) => sets.set(key, value)});
  const server = new EventEmitter();
  server.listen = (...args) => calls.push(['https.listen', ...args]);
  const mockUi = {...uiListen, config: () => uiListen.config(env), listen: (...args) => {
    calls.push(['http.listen', ...args]);
    return {listeners: []};
  }};
  const dependencies = {
    '../app': app,
    '../uiListen': mockUi,
    fs: {readFileSync: file => { reads.push(file); return Buffer.from(file); }},
    https: {createServer: (...args) => { calls.push(['https.createServer', ...args]); return server; }}
  };
  let failure;
  try {
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../patch/www.js'), 'utf8'), {
      require: name => dependencies[name],
      process: {env, exit: code => { throw new Error(`exit ${code}`); }},
      console: {log() {}, error() {}}
    });
  } catch (error) { failure = error; }
  return {app, sets, reads, calls, failure};
}

function testHttpsCompatibility() {
  for (const env of [{}, {HTTPS_PORT: '0'}]) {
    const result = runEntrypoint(env);
    assert.equal(result.failure, undefined);
    assert.equal(result.sets.get('https_port'), null);
    assert.equal(result.calls.length, 1);
    assert.deepEqual(result.reads, []);
  }
  const result = runEntrypoint({HTTPS_PORT: '3444', HTTPS_HOST: '127.0.0.1'});
  assert.equal(result.failure, undefined);
  assert.equal(result.sets.get('https_port'), 3444);
  assert.equal(result.calls[0][1], result.app);
  assert.equal(result.calls[1][2], result.app);
  assert.deepEqual(result.calls[2], ['https.listen', 3444, '127.0.0.1']);
  assert.deepEqual(result.reads, ['etc/tls/fullchain.pem', 'etc/tls/privkey.pem']);
  for (const port of ['garbage', 'NaN', '-1', '65536', '1e3', '0x1000']) {
    const invalid = runEntrypoint({HTTPS_PORT: port});
    assert.match(invalid.failure.message, /exit 1/);
    assert.equal(invalid.calls.length, 0, 'invalid TLS config must fail before HTTP binds');
  }
  console.log('PASS: optional HTTPS keeps certificate paths/shared app; invalid TLS port fails before binding');
}

async function main() {
  testConfig();
  testRetryAndClose();
  await testRealListeners();
  testHttpsCompatibility();
}
main().catch(error => { console.error(error); process.exitCode = 1; });
