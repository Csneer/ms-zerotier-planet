// Execute only inside a disposable UI test container. Fault injection affects
// this Node process, not the running UI or its ZeroTier service.
'use strict';
const assert = require('node:assert/strict');
const http = require('node:http');
const {once} = require('node:events');

async function main() {
  assert.equal(process.env.PLANET_TEST_DISPOSABLE, '1', 'requires disposable test state');
  process.chdir('/opt/ztncui/src');
  const app = require('/opt/ztncui/src/app');
  const zt = require('/opt/ztncui/src/controllers/zt');
  const monitor = require('/opt/ztncui/src/controllers/monitoringController');
  const originalCollect = monitor.collectRoots;
  const originalStatus = zt.get_zt_status;
  const server = http.createServer(app).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = 'http://127.0.0.1:' + server.address().port;
  try {
    const login = await fetch(base + '/login', {method: 'POST', redirect: 'manual',
      headers: {'Content-Type': 'application/x-www-form-urlencoded'}, body: 'username=admin&password=password'});
    assert.equal(login.status, 302);
    const cookie = login.headers.get('set-cookie').split(';')[0];
    monitor.collectRoots = async () => { throw new Error('injected topology collection failure'); };
    for (const lang of ['zh-CN', 'en']) {
      const response = await fetch(base + '/controller?lang=' + lang, {headers: {cookie}, redirect: 'manual'});
      const html = await response.text();
      assert.equal(response.status, 200, 'topology collection failure must not make the dashboard fail');
      assert.ok(html.includes(lang === 'en' ? 'Root metadata is unavailable' : 'Root 元数据不可用'));
      assert.ok(html.includes('href="/controller/networks"'), 'network management remains accessible');
      assert.ok(!html.includes('injected topology collection failure'), 'internal errors are not exposed');
    }
    zt.get_zt_status = async () => { throw new Error('injected sensitive API failure'); };
    const unavailable = await fetch(base + '/controller/roots.json', {headers: {cookie}, redirect: 'manual'});
    assert.equal(unavailable.status, 503);
    assert.equal(unavailable.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await unavailable.json(), {error: 'Root observations temporarily unavailable'});
    console.log('PASS: topology collection failure only degrades the dashboard; unavailable JSON API returns a safe 503');
  } finally {
    monitor.collectRoots = originalCollect;
    zt.get_zt_status = originalStatus;
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
