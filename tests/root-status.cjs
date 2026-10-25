'use strict';

const assert = require('node:assert/strict');
const rootStatus = require('../patch/rootStatus');
const {build, observation, failoverSummary, rootEvidence} = rootStatus;

const now = 1789900000000;
const local = '1111111111';
const other = '2222222222';
const metadata = {id: 149604618, timestamp: now, roots: [
  {identity: `${local}:0:aa`, stableEndpoints: ['192.0.2.1/9994']},
  {identity: `${other}:0:bb`, stableEndpoints: ['2001:db8::1/9994']}
]};
const service = {address: local, clock: now, planetWorldId: metadata.id, planetWorldTimestamp: now};
const activePath = {active: true, preferred: true, address: '198.51.100.1/9994', lastReceive: now - 1000};
const peer = {address: other, role: 'PLANET', latency: 7, paths: [activePath]};
const observed = overrides => observation({...peer, ...overrides}, now);

assert.equal(observed({}).state, 'reachable');
assert.equal(observed({}).latency, 7);
assert.equal(observed({}).families.ipv4.state, 'reachable');
assert.equal(observed({}).families.ipv6.state, 'unseen');
const v6Peer = {...peer, paths: [{active: true, preferred: true, address: '2001:db8::20/9994', lastReceive: now - 10} ]};
assert.equal(observation(v6Peer, now).state, 'reachable');
assert.equal(observation(v6Peer, now).families.ipv4.state, 'unseen');
assert.equal(observation(v6Peer, now).families.ipv6.state, 'reachable');
const dualPeer = {...peer, paths: [
  {active: true, preferred: true, address: '198.51.100.1/9994', lastReceive: now - 1000},
  {active: true, preferred: false, address: '2001:db8::20/9994', lastReceive: now - 120000}
]};
assert.equal(observation(dualPeer, now).state, 'reachable');
assert.equal(observation(dualPeer, now).families.ipv4.state, 'reachable');
assert.equal(observation(dualPeer, now).families.ipv6.state, 'stale');
for (const lastReceive of [undefined, null, '', false, true, Infinity, 'Infinity', {}, [], now + 60000]) {
  const result = observed({paths: [{...activePath, lastReceive, lastSend: now}]});
  assert.equal(result.state, 'unseen');
  assert.equal(result.lastReceiveMs, null);
  assert.equal(result.latency, null);
}
assert.equal(observed({paths: [{...activePath, lastReceive: now + 1}]}).state, 'reachable',
  'separately sampled status and peers can differ by a few milliseconds');
for (const values of [{lastReceive: now - 90001}, {active: false}, {expired: true}]) {
  assert.equal(observed({paths: [{...activePath, ...values}]}).state, 'stale');
}
for (const latency of [undefined, null, '', true, false, {}, [], Infinity, -1]) {
  assert.equal(observed({latency}).latency, null);
}
assert.equal(observed({latency: 0}).latency, 0);
assert.equal(observed({latency: '7'}).latency, 7);
assert.equal(observed({latency: -344}).latency, null);
assert.equal(observed({latency: -344}).latencyAnomaly, true);
assert.equal(observed({latency: -306}).latencyAnomaly, true);
assert.equal(observed({latency: -1}).latencyAnomaly, false);
assert.equal(observed({latency: '-1'}).latencyAnomaly, false);
assert.equal(observed({latency: 7}).latencyAnomaly, false);
assert.equal(observed({role: 'LEAF'}).state, 'unrecognized');
assert.equal(observed({role: undefined}).state, 'unrecognized', 'a peer without a role is not proven to be a Planet Root');
assert.equal(observation(undefined, now).state, 'unseen', 'an absent peer is no response, not an unrecognized peer');
assert.equal(observation(undefined, now).families.ipv4.state, 'unseen');
assert.equal(observed({role: 'LEAF'}).latency, null);
assert.equal(rootEvidence({local: true, service: {state: 'local'}, probe: {state: 'unseen'}}), 'local');
assert.equal(rootEvidence({local: false, service: {state: 'reachable'}, probe: {state: 'unseen'}}), 'server');
assert.equal(rootEvidence({local: false, service: {state: 'unseen'}, probe: {state: 'reachable'}}), 'probe');
assert.equal(rootEvidence({local: false, service: {state: 'reachable'}, probe: {state: 'reachable'}}), 'both');
assert.equal(rootEvidence({local: false, service: {state: 'stale'}, probe: {state: 'unseen'}}), 'none');
assert.equal(observed({paths: [null, undefined, false, {}, activePath]}).state, 'reachable');
assert.equal(observed({paths: [{...activePath, address: {secret: 'test-secret'}}]}).path, null);
const alternate = {...activePath, address: '198.51.100.2/9994', preferred: false};
assert.equal(observed({paths: [{...activePath, lastReceive: now - 120000}, alternate]}).path, alternate.address);
console.log('PASS: only valid recent receive evidence is reachable; malformed latency and stale preferred paths are handled');

for (const probe of [null, {}, {available: true}, {available: true, status: null},
  {available: true, status: {}, peers: [peer]}, {available: true, status: {clock: Infinity}, peers: [peer]},
  {available: true, status: {clock: now}, peers: null}, {available: 'false', status: {clock: now}, peers: [peer]}]) {
  const model = build(metadata, service, [null, undefined, {}, false, peer], probe, {});
  assert.equal(model.roots[0].service.state, 'local');
  assert.equal(model.roots[1].service.state, 'reachable');
  assert.equal(model.roots[1].probe.state, 'unavailable');
  assert.equal(model.probeReachableCount, 0);
}
const model = build(metadata, service, [peer], {
  available: true, status: {clock: now + 100000}, peers: [null, undefined, {}, peer]
}, {});
assert.equal(model.roots[1].service.state, 'reachable');
assert.equal(model.roots[1].probe.state, 'stale', 'each observer must use its own clock');
assert.equal(model.reachableCount, 2);
assert.equal(model.probeReachableCount, 0);
assert.equal(model.failover.state, 'ready');
assert.equal(model.failover.remoteReadyCount, 1);
assert.equal(model.failover.ready, true);
const unknownWorld = build(metadata, {address: local, clock: now}, [peer], null, {});
assert.equal(unknownWorld.failover.state, 'world_unknown');
assert.equal(unknownWorld.failover.ready, false);
const anomaly = rootStatus.build(metadata, service, [{...peer, latency: -344}], null, {});
assert.deepEqual(anomaly.warnings.negativeLatencyRoots, [other]);
assert.equal(build(metadata, service, [{...peer, latency: -1}], null, {}).warnings.negativeLatencyCount, 0);
assert.equal(model.worldId, model.runtimeWorldId);
assert.notEqual(build(metadata, {...service, planetWorldId: 149604619}, [], null, {}).runtimeWorldId, metadata.id,
  'the UI must be able to detect a different runtime World ID even at the same timestamp');
const mismatch = build(metadata, {...service, planetWorldId: 149604619}, [peer], null, {});
assert.equal(mismatch.failover.state, 'world_mismatch');
assert.equal(mismatch.failover.ready, false);
assert.equal(build(metadata, null, null, null, null).controllerId, null);
assert.equal(build(metadata, service, [], null, {ROOT_ONLY: '1'}).controllerId, null);
assert.equal(build(metadata, service, [], null, {CONTROLLER_ONLY: '1', PLANET_MODE: 'external'}).role, 'controller_only');
assert.equal(build(metadata, service, [], null, {ROOT_ONLY: '1'}).role, 'root_only');
assert.equal(build(metadata, service, [], null, {}).role, 'controller_root');
const ready = build(metadata, service, [peer], {available: true, status: {clock: now}, peers: [peer]}, {});
assert.equal(ready.failover.state, 'ready');
assert.equal(ready.failover.ready, true);
assert.deepEqual(ready.failover.remoteReadyRootIds, [other]);
assert.deepEqual(ready.failover.unreadyRootIds, []);
assert.equal(failoverSummary([], true).state, 'unknown');
assert.equal(failoverSummary([{id: local, local: true, ready: true}], true).state, 'single_root');
assert.equal(failoverSummary([{id: local, local: true, ready: true}, {id: other, local: false, ready: false}], true).state, 'no_remote');
console.log('PASS: partial peer/probe responses degrade safely; local and probe observations stay independent');

for (const root of [null, {}, {...metadata.roots[0], identity: [`${local}:0:aa`]},
  {...metadata.roots[0], identity: `${local}:0:aa:private`},
  {...metadata.roots[0], stableEndpoints: []}, {...metadata.roots[0], stableEndpoints: ['private']},
  {...metadata.roots[0], stableEndpoints: ['192.0.2.1/65536']},
  {...metadata.roots[0], stableEndpoints: [{secret: 'test-secret'}]}]) {
  assert.equal(build({...metadata, roots: [root]}, service, [], null, {}).available, false);
}
assert.equal(build({...metadata, roots: [metadata.roots[0], metadata.roots[0]]}, service, [], null, {}).available, false);
const privateMetadata = {...metadata, signingKey: 'test-secret', id: {secret: 'test-secret'}, timestamp: ['test-secret'],
  roots: metadata.roots.map(root => ({...root, private: 'test-secret'}))};
const safe = build(privateMetadata, {...service, planetWorldId: {secret: 'test-secret'},
  planetWorldTimestamp: {secret: 'test-secret'}}, [peer], null, {
  PLANET_MODE: 'test-secret'
});
assert.equal(safe.worldId, null);
assert.equal(safe.timestamp, null);
assert.equal(safe.runtimeWorldId, null);
assert.equal(safe.runtimeTimestamp, null);
assert.equal(safe.mode, 'generated');
assert.ok(!JSON.stringify(safe).includes('test-secret'));
assert.ok(!JSON.stringify(safe).includes('identity'));
safe.roots[0].endpoints.push('192.0.2.2/9994');
assert.equal(metadata.roots[0].stableEndpoints.length, 1, 'the model must not expose mutable metadata arrays');
console.log('PASS: Root metadata projects only public scalar fields and rejects private/duplicate identities or invalid endpoints');

// Declared address families and observed paths are separate facts.
const familyModel = build(metadata, service, [v6Peer], null, {});
assert.equal(familyModel.roots[0].service.families.ipv4.state, 'local_unverified');
assert.equal(familyModel.roots[0].service.families.ipv6.state, 'not_configured');
assert.equal(familyModel.roots[1].service.families.ipv4.state, 'not_configured');
assert.equal(familyModel.roots[1].service.families.ipv6.state, 'reachable');
assert.equal(familyModel.roots[1].probe.families.ipv4.state, 'not_configured');
assert.equal(familyModel.roots[1].probe.families.ipv6.state, 'unavailable');
const unadvertised = build(metadata, service, [peer], null, {}).roots[1];
assert.equal(unadvertised.service.families.ipv4.configured, false);
assert.equal(unadvertised.service.families.ipv4.state, 'reachable', 'do not discard a real path on an unadvertised family');
const dualMetadata = {...metadata, roots: [{identity: `${other}:0:bb`, stableEndpoints: ['198.51.100.1/9994', '2001:db8::20/9994']}]};
for (const paths of [dualPeer.paths, dualPeer.paths.map(path => ({...path, lastReceive: path.address.includes(':') ? now - 1000 : now - 120000}))]) {
  const root = build(dualMetadata, service, [{...peer, paths}], null, {}).roots[0];
  assert.equal(root.ready, true, 'either family keeps a dual-stack Root usable');
  assert.equal(root.service.state, 'reachable');
  assert.deepEqual(Object.values(root.service.families).map(family => family.state).sort(), ['reachable', 'stale']);
}
console.log('PASS: configuration, local identity and external address-family evidence remain distinct');

assert.equal(build(metadata, service, [{...v6Peer, role: 'LEAF'}], null, {}).roots[1].service.families.ipv4.state, 'not_configured');
