'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const pug = require('pug');
const language = require('../patch/uiLanguage');

function translator(lang) {
  const req = {query: {lang}, path: '/controller/network/demo'};
  language(req, {locals: {}, cookie() {}}, () => {});
  return req.t;
}
function compileBlock(file, marker) {
  const filename = path.resolve(__dirname, '..', file);
  const source = fs.readFileSync(filename, 'utf8');
  const start = source.indexOf(marker);
  assert.ok(start >= 0, marker + ' exists in ' + file);
  const content = source.slice(start).replace(new RegExp('^' + marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), '').replace(/^  /gm, '');
  return pug.compile('include icons\n' + content, {filename});
}
const networkRender = compileBlock('patch/network_detail.pug', 'block net_content\n');
const memberRender = compileBlock('patch/member_detail.pug', 'block net_content\n');
const network = {nwid: '0123456789abcdef', name: 'Network <safe>', private: true, mtu: 2800, routes: [], ipAssignmentPools: []};
const base = {id: 'abcdef1234', name: 'Member <script>alert(1)</script>', authorized: true, activeBridge: false, ipAssignments: ['10.0.0.2'], peer: {role: 'LEAF', version: '1.16.2', latency: 23, paths: [{address: '198.51.100.10/9993', active: true, expired: false, lastReceive: Date.now() - 1000, lastSend: Date.now() - 2000}, {address: '[2001:db8::1]/9993', active: true, expired: false}]}};
for (const lang of ['zh-CN', 'en']) {
  const t = translator(lang);
  const html = networkRender({network, members: [base], zt_address: 'fedcba9876', t});
  assert.match(html, /member-info-abcdef1234/, 'member has a stable modal id');
  assert.match(html, /href="#member-info-abcdef1234"/, 'detail action opens the modal');
  assert.match(html, /198\.51\.100\.10\/9993/);
  assert.match(html, /2001:db8::1/);
  assert.ok(!html.includes('<script>alert(1)</script>'), 'member names are escaped by Pug');
  assert.match(html, /data-member-live="authorized"/);
  assert.match(html, /data-member-live="activeBridge"/);
  assert.match(html, /data-dialog/);
}
const inactive = {...base, peer: {role: 'LEAF', version: '-1.-1.-1', latency: null, paths: [
  {address: '192.0.2.1/9993', active: false, expired: false},
  {address: '[2001:db8::2]/9993', active: true, expired: true}
]}};
const inactiveHtml = networkRender({network, members: [inactive], zt_address: 'fedcba9876', t: translator('en')});
assert.match(inactiveHtml, /data-tooltip="No active path observed/);
assert.ok(!inactiveHtml.includes('0 ms'), 'null latency is never rendered as zero');
assert.ok(!inactiveHtml.includes('192.0.2.1\/9993'), 'inactive paths are excluded from observed path details');
assert.ok(!inactiveHtml.includes('2001:db8::2'), 'expired paths are excluded from observed path details');
assert.match(inactiveHtml, /Unknown/);
assert.ok(!inactiveHtml.includes('-1.-1.-1'), 'sentinel version is unknown rather than a real client version');
const detailHtml = memberRender({network, member: inactive, t: translator('en')}).replace(/<pre>[\s\S]*?<\/pre>/g, '');
assert.match(detailHtml, /href="\/controller\/network\/0123456789abcdef\/member\/abcdef1234\/ipAssignments"/);
assert.match(detailHtml, /No active path observed/);
assert.ok(!detailHtml.includes('-1.-1.-1'), 'dedicated page also hides the unknown version sentinel');
assert.ok(!detailHtml.includes('0 ms'));
assert.ok(!detailHtml.includes('192.0.2.1\/9993'));
assert.ok(!detailHtml.includes('2001:db8::2'));
assert.ok(detailHtml.includes('data-dialog'), 'raw member data remains progressively enhanced');
for (const lang of ['zh-CN', 'en']) {
  const t = translator(lang);
  const escaped = {...base, peer: {...base.peer, paths: [{address: '<img src=x onerror=alert(1)>', active: true}]}};
  for (const render of [memberRender, networkRender]) {
    const html = render({network, member: escaped, members: [escaped], zt_address: 'fedcba9876', t});
    assert.ok(html.includes('&lt;img'), 'peer path strings are escaped');
    assert.ok(!html.includes('<img src=x'), 'peer path strings cannot inject markup');
    const activeHtml = render({network, member: base, members: [base], zt_address: 'fedcba9876', t});
    assert.ok(activeHtml.includes('23 ms'), 'actual observed latency is displayed');
    assert.ok(activeHtml.includes('198.51.100.10/9993'));
    assert.ok(activeHtml.includes('[2001:db8::1]/9993'));
    assert.ok(activeHtml.includes('1.16.2'));
    assert.ok(activeHtml.includes('is-online'), 'active LEAF paths support a reachable observation');
    const nullLatency = {...base, peer: {...base.peer, latency: null}};
    const nullHtml = render({network, member: nullLatency, members: [nullLatency], zt_address: 'fedcba9876', t});
    assert.ok(!nullHtml.includes('0 ms'), 'active paths with unknown latency do not report zero');
    const noPeer = {...base, peer: undefined};
    const unknownHtml = render({network, member: noPeer, members: [noPeer], zt_address: 'fedcba9876', t});
    assert.ok(unknownHtml.includes(t('member.no_observed_path')));
    assert.ok(unknownHtml.includes('is-unknown'), 'missing observations do not imply offline');
  }
}
console.log('PASS: member detail modal escapes data, preserves routes, and reports only active non-expired paths');
