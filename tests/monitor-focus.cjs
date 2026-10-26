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
  assert.match(html, /<details[^>]*id="endpoint-probes"[^>]*data-dialog/, 'endpoint probes opt into a bounded dialog');
  assert.ok(html.includes('monitor-service-details'));
  assert.ok(!/<details\b[^>]*\bopen(?:[=>\s])/.test(html), 'secondary sections start collapsed');
  assert.ok(html.includes('href="/controller/monitor"'), 'manual refresh remains available');
  assert.ok(!html.includes('location.reload'), 'reading is never interrupted by a timed full page reload');
  assert.ok(!html.includes('monitor-summary-grid'), 'duplicate communication summary is removed');
  assert.ok(!/\b(?:ux|guide)\./.test(html), 'new labels are translated');
  for (const id of ['version-guidance', 'bridge-guidance', 'planet-guidance', 'path-guidance']) {
    assert.match(html, new RegExp('<details[^>]*id="' + id + '"[^>]*data-dialog'), id + ' has a no-JS disclosure and enhanced dialog');
  }
  assert.ok(html.includes('https://www.zerotier.com/download/'));
  assert.ok(html.includes('https://github.com/kaaass/ZerotierFix/releases'));
  monitor.service.version = '1.16.2';
  monitor.service.planetMatches = false;
  monitor.summary.bridgeMemberCount = 1;
  monitor.networkStats = [{nwid: '0123456789000001', state: 'partial', oldVersionCount: 1, bridgeCount: 1}];
  monitor.members = [{id: '0123456789', version: '1.14.0', versionBehind: true, activeBridge: true, networks: [], planet: {reachable: false}, probe: {state: 'unknown', latency: null}}];
  const riskHtml = render({error: null, monitor, topology: {available: false}, uiListeners: [], t: req.t, formatAge: String, formatBytes: String, formatRate: String});
  for (const id of ['version-guidance', 'bridge-guidance', 'planet-guidance']) {
    assert.ok(riskHtml.includes('data-dialog-open="' + id + '"'), id + ' is directly reachable from its warning');
  }
  assert.ok(riskHtml.includes('1.16.2'), 'version guidance displays the actual comparison reference');
  monitor.members[0] = {
    id: '0123456789', name: '<img src=x onerror=alert(1)>', version: null,
    versionBehind: false, activeBridge: true,
    detail: {ipAssignments: ['192.0.2.123']},
    networks: [
      {nwid: '0123456789000001', name: 'First <network>', authorized: true, activeBridge: false},
      {nwid: '0123456789000002', name: 'Second network', authorized: false, activeBridge: true}
    ],
    planet: {reachable: false, latency: null, lastActivityMs: null},
    probe: {state: 'direct', path: '2001:db8::1/9993', latency: 0}
  };
  const memberHtml = render({error: null, monitor, topology: {available: false}, uiListeners: [], t: req.t, formatAge: String, formatBytes: String, formatRate: String});
  const quick = memberHtml.match(/<details class="member-quick-info"[^>]*id="observed-member-0123456789"[^>]*data-dialog[^>]*>([\s\S]*?)<\/details>/);
  assert.ok(quick, 'monitor member identity opens a bounded quick-info dialog');
  assert.ok(quick[1].includes('data-tooltip='), 'member identity has a discoverable hover/focus hint');
  assert.ok(quick[1].includes('&lt;img src=x onerror=alert(1)&gt;'), 'member name is escaped');
  assert.ok(quick[1].includes('First &lt;network&gt;'), 'network name is escaped');
  assert.ok(!quick[1].includes('<img'), 'member content cannot inject markup');
  assert.ok(quick[1].includes(req.t('monitor.scope_note')), 'Planet and probe observations retain their scope');
  assert.ok(quick[1].includes(req.t('common.unknown')), 'missing metadata remains unknown');
  assert.ok(!quick[1].includes('null ms') && !quick[1].includes('undefined ms'));
  assert.ok(quick[1].includes('0 ms') && quick[1].includes('2001:db8::1/9993'), 'zero-latency and IPv6 observations remain visible');
  assert.ok(!quick[1].includes('192.0.2.123'), 'latest-network detail IPs are not misrepresented as all-network IPs');
  for (const network of monitor.members[0].networks) {
    const block = quick[1].match(new RegExp('<section>(?:(?!<section>)[\\s\\S])*?' + network.nwid + '[\\s\\S]*?</section>'));
    assert.ok(block, 'network-specific membership is shown');
    assert.ok(block[0].includes(req.t('network.authorized') + '</span><strong>' + req.t(network.authorized ? 'common.enabled' : 'common.disabled')));
    assert.ok(block[0].includes(req.t('network.bridge') + '</span><strong>' + req.t(network.activeBridge ? 'common.enabled' : 'common.disabled')));
    const memberPath = '/controller/network/' + network.nwid + '/member/0123456789';
    assert.ok(block[0].includes('href="' + memberPath + '"'));
    assert.ok(block[0].includes('href="' + memberPath + '/ipAssignments"'));
  }
  const failed = render({error: 'Monitor unavailable', monitor: null, t: req.t});
  assert.ok(failed.includes('Monitor unavailable'), 'error responses render without dereferencing a null monitor');
  assert.ok(!failed.includes('id="member-paths"'));
  for (const id of ['network-health', 'member-paths']) {
    const tag = html.match(new RegExp('<section[^>]*id="' + id + '"[^>]*>'));
    assert.ok(tag && tag[0].includes('data-list'), id + ' supports focused pagination');
  }
}
console.log('PASS: bilingual monitoring prioritizes network and member tasks with manual refresh and collapsed diagnostics');
