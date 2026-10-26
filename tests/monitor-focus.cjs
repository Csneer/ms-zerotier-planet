'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const pug = require('pug');
const language = require('../patch/uiLanguage');
const filename = path.resolve(__dirname, '../patch/monitor.pug');
const source = fs.readFileSync(filename, 'utf8');
// Render the content block independently of the upstream application shell.
const content = source.replace(/^extends controller_layout\n/, '').replace(/^block content\n/m, '').replace(/^  /gm, '');
const render = pug.compile('include icons\n' + content, {filename});
for (const lang of ['zh-CN', 'en']) {
  const req = {query: {lang}, path: '/controller/monitor'};
  language(req, {locals: {}, cookie() {}}, () => {});
  const monitor = {
    generatedAt: '2026-10-26T00:00:00Z',
    service: {planetMatches: true, rootConfigAvailable: true, unexpectedPlanetCount: 0, uptimeSeconds: 60},
    summary: {}, probe: {available: false}, metrics: {available: false},
    communication: {memberCount: 0, networkCount: 0, planetCoveragePercent: null},
    members: [], networkStats: [], endpointProbes: {configured: false}
  };
  const html = render({error: null, monitor, topology: {available: false}, uiListeners: [], t: req.t, formatAge: String, formatBytes: String, formatRate: String});
  assert.ok(html.indexOf('id="network-health"') < html.indexOf('id="member-paths"'));
  assert.ok(html.indexOf('id="root-topology"') < html.indexOf('id="member-paths"'), 'Root alerts precede potentially long member lists');
  assert.ok(html.includes('<details class="surface-card table-card monitor-network-card monitor-disclosure" id="endpoint-probes">'));
  assert.ok(html.includes('monitor-service-details'));
  assert.ok(!/<details\b[^>]*\bopen(?:[=>\s])/.test(html), 'secondary sections start collapsed');
  assert.ok(html.includes('href="/controller/monitor"'), 'manual refresh remains available');
  assert.ok(!html.includes('location.reload'), 'reading is never interrupted by a timed full page reload');
  assert.ok(!html.includes('monitor-summary-grid'), 'duplicate communication summary is removed');
  assert.ok(!/\bux\./.test(html), 'new labels are translated');
  const failed = render({error: 'Monitor unavailable', monitor: null, t: req.t});
  assert.ok(failed.includes('Monitor unavailable'), 'error responses render without dereferencing a null monitor');
  assert.ok(!failed.includes('id="member-paths"'));
  for (const id of ['network-health', 'member-paths']) {
    const tag = html.match(new RegExp('<section[^>]*id="' + id + '"[^>]*>'));
    assert.ok(tag && tag[0].includes('data-list'), id + ' supports focused pagination');
  }
}
console.log('PASS: bilingual monitoring prioritizes network and member tasks with manual refresh and collapsed diagnostics');
