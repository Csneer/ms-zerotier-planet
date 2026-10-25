'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const host = require('../patch/hostDiagnostics');
const {build} = require('../patch/rootStatus');
const now = 1792800000000;
const ids = ['1111111111', '2222222222', '3333333333'];
const metadata = {id: 1234, timestamp: now, roots: ids.map((id, i) => ({identity: `${id}:0:aa`, stableEndpoints: [`198.51.100.${[97, 99, 100][i]}/9994`]}))};
const service = {address: ids[0], clock: now, planetWorldId: 1234, planetWorldTimestamp: now};
const peer = i => ({address: ids[i], role: 'PLANET', paths: [{address: metadata.roots[i].stableEndpoints[0], active: true, lastReceive: now - 1000}]});
const topology = build(metadata, service, [], {available: true, status: {clock: now}, peers: [peer(2)]});
const snapshot = {schema: 1, collectedAt: now, scope: 'known-root-drain', collectors: {ipv4: 'ok', ipv6: 'ok', service: 'ok'}, policy: {present: true, active: true, inputRestricted: true, outputRestricted: true, allowedPeers: ['198.51.100.99'], allowedEndpoints: ['198.51.100.99/9994'], auditedPort: 9994, reviewRequired: false, serviceActive: true, serviceEnabled: true}};
const withPolicy = overrides => {
  const policy = {...snapshot.policy, ...overrides};
  if (overrides.allowedPeers && !overrides.allowedEndpoints) {
    policy.allowedEndpoints = overrides.allowedPeers.map(ip => `${ip}/${policy.auditedPort}`);
  }
  return {...snapshot, policy};
};
assert.equal(topology.roots[2].evidence, 'probe');
assert.equal(topology.roots[2].ready, false);
assert.equal(topology.failover.ready, false);
assert.deepEqual(topology.warnings.probeOnlyRootIds, [ids[2]]);
const blocked = host.build(snapshot, topology, now);
assert.equal(blocked.state, 'restricted_no_response');
assert.deepEqual(blocked.allowedRoots, [{id: ids[1], local: false, responding: false}]);
const recovered = build(metadata, service, [peer(1)], null);
assert.equal(host.build(snapshot, recovered, now).state, 'single_path');
assert.equal(host.build(withPolicy({allowedPeers: ['198.51.100.99', '198.51.100.100']}), build(metadata, service, [peer(1), peer(2)], null), now).state, 'restricted');
assert.equal(host.build(withPolicy({allowedPeers: ['192.0.2.1']}), topology, now).state, 'review');
assert.equal(host.build(snapshot, {available: false, roots: []}, now).state, 'review');
assert.equal(host.build(withPolicy({reviewRequired: true}), topology, now).state, 'unknown');
assert.equal(host.build({...snapshot, collectors: {...snapshot.collectors, ipv6: 'unavailable'}}, topology, now).state, 'unknown');
for (const restriction of [{inputRestricted: false}, {outputRestricted: false}]) {
  assert.equal(host.build(withPolicy(restriction), recovered, now).state, 'review');
}
assert.equal(host.build(withPolicy({allowedEndpoints: ['198.51.100.100/9994']}), recovered, now).state, 'unknown');
assert.equal(host.build(withPolicy({allowedEndpoints: ['198.51.100.99/9993']}), recovered, now).state, 'unknown');
const wrongPort = JSON.parse(JSON.stringify(recovered));
wrongPort.roots[1].service.path = '198.51.100.99/9993';
assert.equal(host.build(snapshot, wrongPort, now).state, 'review');
assert.equal(host.build(snapshot, wrongPort, now).allowedRoots[0].responding, false);
wrongPort.roots[1].endpoints = ['198.51.100.99/9993'];
assert.equal(host.build(snapshot, wrongPort, now).state, 'review');
const ipv6 = JSON.parse(JSON.stringify(recovered));
ipv6.roots[1].endpoints = ['2001:0db8:0:0:0:0:0:1/9994'];
ipv6.roots[1].service.path = '2001:db8::1/9994';
const ipv6Snapshot = withPolicy({allowedPeers: ['2001:0db8::1'], allowedEndpoints: ['2001:db8::1/9994']});
assert.equal(host.build(ipv6Snapshot, ipv6, now).state, 'single_path');
assert.equal(host.build(ipv6Snapshot, ipv6, now).allowedRoots[0].responding, true);
const removed = withPolicy({present: false, active: false, inputRestricted: false, outputRestricted: false, allowedPeers: [], serviceActive: false, serviceEnabled: false});
assert.equal(host.build(removed, topology, now).state, 'absent');
assert.equal(host.build({...removed, policy: {...removed.policy, serviceEnabled: true}}, topology, now).restartRisk, true);
assert.equal(host.build({...snapshot, collectedAt: now - 180001}, topology, now).state, 'stale');
for (const invalid of [null, {}, {...snapshot, schema: 2}, {...snapshot, collectedAt: now + 1}, {...snapshot, collectedAt: String(now)}, {...snapshot, scope: 'all-firewalls'}, withPolicy({active: 1}), withPolicy({allowedPeers: ['secret']}), withPolicy({allowedPeers: null}), {...snapshot, collectors: {}}]) {
  assert.equal(host.build(invalid, topology, now).state, 'unknown');
}
(async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'host-diagnostics-'));
  const file = path.join(dir, 'snapshot.json');
  try {
    assert.equal((await host.collect(topology, file, now)).state, 'unknown');
    for (const content of ['{bad json', ' '.repeat(65537), JSON.stringify({...snapshot, collectedAt: now - 180001})]) {
      await fs.writeFile(file, content);
      assert.ok(['unknown', 'stale'].includes((await host.collect(topology, file, now)).state));
    }
    await fs.writeFile(file, JSON.stringify(snapshot));
    assert.equal((await host.collect(topology, file, now)).state, 'restricted_no_response');
    assert.equal((await host.collect(topology, dir, now)).state, 'unknown');
    const fifo = path.join(dir, 'fifo');
    require('node:child_process').execFileSync('mkfifo', [fifo]);
    assert.equal((await host.collect(topology, fifo, now)).state, 'unknown');
    const link = path.join(dir, 'link');
    await fs.symlink(file, link);
    assert.equal((await host.collect(topology, link, now)).state, 'unknown');
    // Even replacement with a FIFO after lstat must not block the worker.
    const originalLstat = fs.lstat;
    try {
      fs.lstat = async () => ({isFile: () => true});
      assert.equal((await host.collect(topology, fifo, now)).state, 'unknown');
    } finally { fs.lstat = originalLstat; }
    const originalOpen = fs.open;
    try {
      fs.open = async () => { throw Object.assign(new Error('denied'), {code: 'EACCES'}); };
      assert.equal((await host.collect(topology, file, now)).state, 'unknown');
    } finally { fs.open = originalOpen; }
  } finally { await fs.rm(dir, {recursive: true, force: true}); }
  console.log('PASS: Controller restriction incident, recovery, unknown/stale snapshots, and bounded read');
})().catch(error => { console.error(error); process.exitCode = 1; });
