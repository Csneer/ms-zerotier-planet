'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const {EventEmitter} = require('node:events');
const probes = require('../patch/endpointProbes');

async function listen(host = '127.0.0.1') {
  const server = net.createServer(socket => socket.end());
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, resolve);
  });
  return {server, port: server.address().port};
}

async function close(server) {
  await new Promise(resolve => server.close(resolve));
}

(async () => {
  const running = await listen();
  try {
    const reachable = await probes.probeEndpoint({id: 'local', name: 'local', address: '127.0.0.1', port: running.port, timeoutMs: 500, enabled: true});
    assert.equal(reachable.state, 'reachable');
    assert.equal(reachable.reachable, true);
    assert.ok(Number.isInteger(reachable.latencyMs));
    assert.equal(reachable.errorCode, null);

    const refused = await probes.probeEndpoint({id: 'refused', name: 'refused', address: '127.0.0.2', port: running.port, timeoutMs: 500, enabled: true});
    assert.equal(refused.state, 'refused');
    assert.equal(refused.errorCode, 'ECONNREFUSED');

    const disabled = await probes.probeEndpoint({id: 'disabled', name: 'disabled', address: '127.0.0.1', port: 1, timeoutMs: 500, enabled: false});
    assert.equal(disabled.state, 'disabled');
    assert.equal(disabled.latencyMs, null);
  } finally {
    await close(running.server);
  }

  const invalid = probes.normalizeConfig({probes: [
    {id: 'dns', name: 'dns', address: 'example.com', port: 22},
    {id: 'zone', name: 'zone', address: 'fe80::1%lo', port: 22},
    {id: 'bad-port', name: 'bad port', address: '127.0.0.1', port: 70000},
    {id: 'bad-timeout', name: 'bad timeout', address: '127.0.0.1', port: 22, timeoutMs: 1}
  ]});
  assert.equal(invalid.valid, true);
  assert.deepEqual(invalid.probes.map(item => item.state), ['invalid', 'invalid', 'invalid', 'invalid']);
  assert.deepEqual(invalid.probes.map(item => item.errorCode), ['INVALID_ADDRESS', 'INVALID_ADDRESS', 'INVALID_PORT', 'INVALID_TIMEOUT']);
  assert.equal(invalid.probes[0].addressLabel, 'example.com');
  assert.equal(probes.normalizeConfig({probes: [
    {id: 'same', name: 'one', address: '127.0.0.1', port: 22},
    {id: 'same', name: 'two', address: '127.0.0.1', port: 23}
  ]}).valid, false);
  assert.equal(probes.normalizeConfig({probes: Array.from({length: probes.MAX_PROBES + 1}, () => ({
    id: 'too-many', name: 'too-many', address: '127.0.0.1', port: 22
  }))}).valid, false);

  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'zt-endpoint-probes-'));
  const file = path.join(temp, 'probes.json');
  try {
  await fs.writeFile(file, JSON.stringify({probes: [
    {id: 'local', name: 'local', address: '127.0.0.1', port: 1, timeoutMs: 500},
    {id: 'off', name: 'off', address: '127.0.0.1', port: 1, enabled: false}
  ]}));
  const collected = await probes.collect(file);
  assert.equal(collected.available, true);
  assert.equal(collected.configuredCount, 2);
  assert.equal(collected.disabledCount, 1);
  assert.equal(collected.failedCount, 1);

  const missing = await probes.collect(path.join(temp, 'missing.json'));
  assert.equal(missing.available, false);
  assert.equal(missing.configured, false);
  for (const content of ['{', JSON.stringify({probes: 'invalid'}), ' '.repeat(256 * 1024 + 1)]) {
    await fs.writeFile(file, content);
    const invalidFile = await probes.collect(file);
    assert.equal(invalidFile.available, false);
    assert.equal(invalidFile.configured, true);
    assert.equal(invalidFile.errorCode, 'INVALID_CONFIG');
    assert.deepEqual(invalidFile.results, []);
  }

  // Simulated socket deadlines prove concurrency and total-budget limits
  // without relying on an Internet blackhole or waiting ten real seconds.
  const originalConnect = net.createConnection;
  const originalNow = Date.now;
  let clock = 100000, calls = 0, active = 0, peak = 0;
  await fs.writeFile(file, JSON.stringify({probes: Array.from({length: probes.MAX_PROBES}, (_, i) => ({
    id: `bounded-${i}`, name: 'bounded', address: '127.0.0.1', port: 1, timeoutMs: 5000
  }))}));
  try {
    Date.now = () => clock;
    net.createConnection = () => {
      calls++;
      active++;
      peak = Math.max(peak, active);
      const socket = new EventEmitter();
      let destroyed = false;
      socket.destroy = () => {
        assert.equal(destroyed, false, 'sockets must be closed exactly once');
        destroyed = true;
        active--;
      };
      socket.setTimeout = (ms, callback) => {
        assert.ok(ms > 0 && ms <= probes.MAX_TIMEOUT_MS);
        queueMicrotask(() => {
          clock = 100000 + probes.MAX_COLLECTION_MS + 1;
          callback();
        });
      };
      return socket;
    };
    const timedOut = await probes.collect(file);
    assert.equal(peak, probes.MAX_CONCURRENCY);
    assert.equal(calls, probes.MAX_CONCURRENCY, 'expired collection must not start queued targets');
    assert.equal(active, 0, 'all timed-out sockets must be closed');
    assert.equal(timedOut.results.length, probes.MAX_PROBES);
    assert.ok(timedOut.results.every(item => item.state === 'timeout' && item.errorCode === 'ETIMEDOUT'));
    assert.equal(timedOut.failedCount, probes.MAX_PROBES);

    net.createConnection = () => { throw Object.assign(new Error('private details'), {code: 'PRIVATE_ERROR'}); };
    const safeFailure = await probes.probeEndpoint({address: '127.0.0.1', port: 1, timeoutMs: 100});
    assert.equal(safeFailure.state, 'unreachable');
    assert.equal(safeFailure.errorCode, 'EUNKNOWN');
    assert.ok(!JSON.stringify(safeFailure).includes('private details'));
  } finally {
    net.createConnection = originalConnect;
    Date.now = originalNow;
  }
  console.log('PASS: endpoint TCP probes are bounded, literal-IP only, read-only, and fail safely');
  } finally {
    await fs.rm(temp, {recursive: true, force: true});
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
