'use strict';

const assert = require('node:assert/strict');
const {build, observation} = require('../patch/rootStatus');

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
assert.equal(observed({role: 'LEAF'}).state, 'unrecognized');
assert.equal(observed({role: 'LEAF'}).latency, null);
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
assert.equal(model.worldId, model.runtimeWorldId);
assert.notEqual(build(metadata, {...service, planetWorldId: 149604619}, [], null, {}).runtimeWorldId, metadata.id,
  'the UI must be able to detect a different runtime World ID even at the same timestamp');
assert.equal(build(metadata, null, null, null, null).controllerId, null);
assert.equal(build(metadata, service, [], null, {ROOT_ONLY: '1'}).controllerId, null);
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
