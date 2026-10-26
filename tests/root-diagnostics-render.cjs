'use strict';
// Requires the UI's pug dependency (run in the disposable UI image).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const pug = require('pug');
const language = require('../patch/uiLanguage');
const rootStatus = require('../patch/rootStatus');
const source = fs.readFileSync(require.resolve('../patch/roots_panel.pug'), 'utf8');
const render = pug.compile(source + '\n+roots_panel(topology, [], compact)\n');
const visible = html => html.replace(/<details\b[^>]*>[\s\S]*?<\/details>/g, '');
for (const lang of ['zh-CN', 'en']) {
  const req = {query: {lang}, path: '/controller'};
  language(req, {locals: {}, cookie() {}}, () => {});
  const topology = {available: true, roots: [{id: '1111111111', local: true, endpoints: ['192.0.2.1/9994', '2001:db8::1/9994'], ready: true, evidence: 'local',
    service: {state: 'local', lastReceiveMs: 0, latency: null, latencyAnomaly: false, path: null,
      families: {ipv4: {state: 'local', lastReceiveMs: 0, path: null}, ipv6: {state: 'unseen', lastReceiveMs: 0, path: null}}},
    probe: {state: 'unavailable', lastReceiveMs: null, latency: null, latencyAnomaly: false, path: null,
      families: {ipv4: {state: 'unavailable', lastReceiveMs: null, path: null}, ipv6: {state: 'unavailable', lastReceiveMs: null, path: null}}}}],
    reachableCount: 1, mode: 'external', role: 'controller_only', warnings: {probeOnlyRootIds: ['3333333333']}};
  for (const state of ['unknown', 'stale', 'absent', 'inactive', 'review', 'restricted_no_response', 'single_path', 'restricted']) {
    topology.hostDiagnostics = {state, collectedAt: 1792800000000, policy: {active: true, serviceEnabled: true, allowedPeers: ['198.51.100.99'], allowedEndpoints: ['198.51.100.99/9994']}, allowedRoots: [{id: '2222222222', responding: false}], restartRisk: true};
    const html = render({topology, t: req.t, formatAge: String});
    assert.ok(html.includes(req.t('monitor.host_state_' + state)));
    assert.ok(visible(html).includes(req.t('monitor.host_restart_risk')), 'restart risks stay outside disclosures');
    assert.ok(visible(html).includes(req.t('monitor.host_state_' + state)));
    const compactHtml = render({topology, compact: true, t: req.t, formatAge: String});
    assert.ok(compactHtml.includes(req.t('monitor.host_restart_risk')));
    assert.ok(compactHtml.includes(req.t('monitor.root_probe_only')));
    assert.ok(!compactHtml.includes('monitor-root-item'));
    assert.ok(compactHtml.includes('/controller/monitor#root-topology'));
    assert.ok(visible(html).includes(req.t('monitor.root_probe_only')));
    assert.ok(html.includes('198.51.100.99/9994'));
    assert.ok(html.includes('./manage.sh diagnose --install-timer'));
    assert.ok(!html.includes('monitor.host_'));
    assert.ok(html.includes(req.t('monitor.root_family_ipv4')));
    assert.ok(html.includes(req.t('monitor.root_family_ipv6')));
  }
  topology.hostDiagnostics = {state: 'absent', policy: {active: false, serviceEnabled: false, allowedEndpoints: []}, allowedRoots: []};
  assert.ok(!render({topology, t: req.t, formatAge: String}).includes(req.t('monitor.host_allowed')));
  const clock = 1792800000000;
  const ipv6 = '2001:db8:abcd:1234:5678:90ab:cdef:1234/9994';
  const metadata = {id: 149604618, timestamp: clock, roots: [{identity: '2222222222:0:aa', stableEndpoints: [ipv6]}]};
  const service = {address: '1111111111', clock, planetWorldId: metadata.id, planetWorldTimestamp: clock};
  const peer = {address: '2222222222', role: 'PLANET', latency: 5, paths: [{address: ipv6, active: true, lastReceive: clock - 1000}]};
  const familyTopology = rootStatus.build(metadata, service, [peer], null, {});
  const familyHtml = render({topology: familyTopology, t: req.t, formatAge: String});
  assert.ok(familyHtml.includes(req.t('monitor.root_state_not_configured')));
  assert.ok(familyHtml.includes(req.t('monitor.root_probe_unavailable_help')));
  assert.equal(familyHtml.split(ipv6).length - 1, 2, 'endpoint is shown once as configuration and once as observed path');
  assert.ok(!familyHtml.includes('monitor.root_'), 'all Root labels have translations');
  const localTopology = rootStatus.build(metadata, {...service, address: '2222222222'}, [], null, {});
  const localHtml = render({topology: localTopology, t: req.t, formatAge: String});
  assert.ok(localHtml.includes(req.t('monitor.root_state_local_unverified')));
  assert.ok(localHtml.includes(req.t('monitor.root_local_scope')));
  delete topology.hostDiagnostics;
  assert.ok(visible(render({topology, t: req.t, formatAge: String})).includes(req.t('ux.host_unknown')));
  topology.worldId = 1;
  topology.runtimeWorldId = 2;
  assert.ok(visible(render({topology, t: req.t, formatAge: String})).includes(req.t('monitor.world_version_mismatch')));
  topology.hostDiagnostics = {state: 'absent'};
  assert.ok(visible(render({topology, t: req.t, formatAge: String})).includes(req.t('ux.host_absent')));
}
console.log('PASS: shared Root panel renders diagnostic states and incident warning in Chinese and English');
