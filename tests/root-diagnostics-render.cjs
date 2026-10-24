'use strict';
// Requires the UI's pug dependency (run in the disposable UI image).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const pug = require('pug');
const language = require('../patch/uiLanguage');
const source = fs.readFileSync(require.resolve('../patch/roots_panel.pug'), 'utf8');
const render = pug.compile(source + '\n+roots_panel(topology, [])\n');
for (const lang of ['zh-CN', 'en']) {
  const req = {query: {lang}, path: '/controller'};
  language(req, {locals: {}, cookie() {}}, () => {});
  const topology = {available: true, roots: [], reachableCount: 0, mode: 'external', role: 'controller_only', warnings: {probeOnlyRootIds: ['3333333333']}};
  for (const state of ['unknown', 'stale', 'absent', 'inactive', 'review', 'restricted_no_response', 'single_path', 'restricted']) {
    topology.hostDiagnostics = {state, collectedAt: 1792800000000, policy: {active: true, serviceEnabled: true, allowedPeers: ['172.16.100.99'], allowedEndpoints: ['172.16.100.99/9994']}, allowedRoots: [{id: '2222222222', responding: false}], restartRisk: true};
    const html = render({topology, t: req.t, formatAge: String});
    assert.ok(html.includes(req.t('monitor.host_state_' + state)));
    assert.ok(html.includes(req.t('monitor.host_restart_risk')));
    assert.ok(html.includes(req.t('monitor.root_probe_only')));
    assert.ok(html.includes('172.16.100.99/9994'));
    assert.ok(html.includes('./manage.sh diagnose --install-timer'));
    assert.ok(!html.includes('monitor.host_'));
  }
  topology.hostDiagnostics = {state: 'absent', policy: {active: false, serviceEnabled: false, allowedEndpoints: []}, allowedRoots: []};
  assert.ok(!render({topology, t: req.t, formatAge: String}).includes(req.t('monitor.host_allowed')));
  delete topology.hostDiagnostics;
  assert.ok(render({topology, t: req.t, formatAge: String}).includes(req.t('monitor.host_state_unknown')));
}
console.log('PASS: shared Root panel renders diagnostic states and incident warning in Chinese and English');
