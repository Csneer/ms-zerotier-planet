'use strict';
const assert = require('node:assert/strict');
const http = require('node:http');
const {once} = require('node:events');
const uiListen = require('../patch/uiListen');
const rootStatus = require('../patch/rootStatus');

async function main() {
  const now = 1789900000000;
  const local = '1111111111', other = '2222222222';
  const metadata = {id: 149604618, timestamp: now, roots: [
    {identity: local + ':0:aa', stableEndpoints: ['192.0.2.1/9994']},
    {identity: other + ':0:bb', stableEndpoints: ['198.51.100.1/9994']}
  ]};
  const service = {address: local, clock: now, planetWorldTimestamp: now};
  const peer = {address: other, role: 'PLANET', latency: 7, paths: [
    {active: true, preferred: true, address: '198.51.100.1/9994', lastReceive: now - 1000, lastSend: now}
  ]};
  let model = rootStatus.build(metadata, service, [peer], {available: false, peers: []}, {});
  assert.equal(model.roots[0].service.state, 'local');
  assert.equal(model.roots[1].service.state, 'reachable');
  assert.equal(model.reachableCount, 2);
  peer.paths[0].lastReceive = now - 120000;
  model = rootStatus.build(metadata, service, [peer], {available: false, peers: []}, {});
  assert.equal(model.roots[1].service.state, 'stale');
  assert.equal(model.roots[1].service.latency, null);
  assert.equal(model.reachableCount, 1);
  assert.equal(rootStatus.build(null, service, [], {peers: []}, {}).available, false);
  assert.equal(rootStatus.build({roots: [{identity: 'bad'}]}, service, [], {peers: []}, {}).available, false);
  peer.role = 'LEAF';
  assert.equal(rootStatus.observation(peer, now).state, 'unrecognized');
  assert.ok(!JSON.stringify(model).includes('identity'));
  console.log('PASS: Root model distinguishes self, fresh, stale and unrecognized peers; send-only activity cannot fake health');

  assert.deepEqual(uiListen.config({HTTP_EXTRA_HOSTS: '198.51.100.97,127.0.0.1'}).hosts,
    ['127.0.0.1', '198.51.100.97']);
  for (const env of [{HTTP_EXTRA_HOSTS: '198.51.100.0/24'}, {HTTP_HOST: '0.0.0.0', HTTP_EXTRA_HOSTS: '198.51.100.97'},
    {HTTP_HOST: 'bad.example'}, {HTTP_PORT: '123garbage'}, {HTTP_PORT: '-1'}]) {
    assert.throws(() => uiListen.config(env));
  }
  const reservation = http.createServer().listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  let total = 0;
  const listeners = uiListen.listen((req, res) => { res.end(String(++total)); }, {
    hosts: ['127.0.0.1', '127.0.0.2', '192.0.2.253'], port
  }, {retryMs: 30, onFatal: error => { throw error; }});
  try {
    await new Promise(resolve => setTimeout(resolve, 100));
    const request = host => new Promise((resolve, reject) => {
      http.get({host, port}, res => {let body = ''; res.on('data', b => body += b); res.on('end', () => resolve(body));}).on('error', reject);
    });
    assert.equal(await request('127.0.0.1'), '1');
    assert.equal(await request('127.0.0.2'), '2');
    assert.equal(listeners.listeners[2].state, 'unavailable');
    assert.equal(listeners.listeners[0].state, 'listening');
    console.log('PASS: shared UI on two addresses; absent optional LAN address retries without disrupting primary listener');
  } finally { listeners.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
