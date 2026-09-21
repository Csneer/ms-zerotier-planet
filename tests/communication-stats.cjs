'use strict';

const assert = require('node:assert/strict');
const {buildNetworkStats, buildCommunicationSummary} = require('../patch/communicationStats');

const networks = [
  {nwid: 'aaaaaaaaaa', name: 'alpha', mtu: 1280},
  {nwid: 'bbbbbbbbbb', name: 'beta', mtu: 1300}
];
const members = [
  {id: '1111111111', versionBehind: false,
    networks: [{nwid: 'aaaaaaaaaa', authorized: true, activeBridge: false}],
    planet: {observed: true, reachable: true}, probe: {state: 'direct'}},
  {id: '2222222222', versionBehind: true,
    networks: [{nwid: 'aaaaaaaaaa', authorized: true, activeBridge: true},
      {nwid: 'bbbbbbbbbb', authorized: false, activeBridge: false}],
    planet: {observed: true, reachable: false}, probe: {state: 'relay'}},
  {id: '3333333333', versionBehind: false,
    networks: [{nwid: 'bbbbbbbbbb', authorized: true, activeBridge: false}],
    planet: {observed: true, reachable: true}, probe: {state: 'unknown'}}
];

const stats = buildNetworkStats(networks, members, true);
assert.deepEqual(stats.map(item => item.nwid), ['aaaaaaaaaa', 'bbbbbbbbbb']);
assert.deepEqual(stats[0], {
  nwid: 'aaaaaaaaaa', name: 'alpha', mtu: 1280, memberCount: 2,
  authorizedCount: 2, planetReachableCount: 1, probeDirectCount: 1,
  planetObservedCount: 2, planetUnknownCount: 0,
  probeRelayCount: 1, probeUnknownCount: 0, bridgeCount: 1, oldVersionCount: 1,
  planetCoveragePercent: 50, directPercent: 50, relayPercent: 50, state: 'degraded'
});
assert.equal(stats[1].state, 'degraded');
assert.equal(stats[1].probeUnknownCount, 1);

const summary = buildCommunicationSummary(stats, true);
assert.equal(summary.memberCount, 4, 'members are counted per controller network');
assert.equal(summary.planetReachableCount, 2);
assert.equal(summary.planetObservedCount, 4);
assert.equal(summary.planetUnknownCount, 0);
assert.equal(summary.probeDirectCount, 1);
assert.equal(summary.probeRelayCount, 2);
assert.equal(summary.probeUnknownCount, 1);
assert.equal(summary.planetCoveragePercent, 50);
assert.equal(summary.directPercent, 33.3);
assert.equal(summary.relayPercent, 66.7);

const unavailable = buildNetworkStats(networks, members, false);
assert.equal(unavailable[0].probeUnknownCount, 2);
assert.equal(unavailable[0].directPercent, null);
assert.equal(buildCommunicationSummary(unavailable, false).probeAvailable, false);
const unknown = buildNetworkStats(networks, [{id: '4444444444', networks: [{nwid: 'aaaaaaaaaa', authorized: true}], planet: {observed: false}, probe: {state: 'unknown'}}], true);
assert.equal(unknown[0].planetObservedCount, 0);
assert.equal(unknown[0].planetUnknownCount, 1);
assert.equal(unknown[0].planetCoveragePercent, null);
assert.equal(unknown[0].state, 'unknown');
for (const planet of [undefined, null, {}, {observed: false, reachable: false}]) {
  const unobserved = buildNetworkStats(networks, [{networks: [{nwid: 'aaaaaaaaaa'}], planet}], false)[0];
  assert.equal(unobserved.state, 'unknown');
  assert.equal(unobserved.planetCoveragePercent, null);
}
assert.equal(buildNetworkStats(networks, [], true)[0].state, 'empty');
const oneMember = planet => ({networks: [{nwid: 'aaaaaaaaaa'}], planet});
assert.equal(buildNetworkStats(networks, [oneMember({observed: true, reachable: true})], true)[0].state, 'healthy');
assert.equal(buildNetworkStats(networks, [oneMember({observed: true, reachable: false})], true)[0].state, 'offline');
const partial = buildNetworkStats(networks, [oneMember({observed: true, reachable: true}), oneMember({observed: false})], true)[0];
assert.equal(partial.state, 'partial');
assert.equal(partial.planetCoveragePercent, 100, 'unknown peers must not be counted as unreachable');
assert.equal(partial.planetUnknownCount, 1);
console.log('PASS: network communication summaries count members per network and preserve probe scope');
