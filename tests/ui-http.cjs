// Run inside a disposable, fresh UI container with default test credentials.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const base = 'http://127.0.0.1:3443';
async function main() {
  assert.equal(process.env.PLANET_TEST_DISPOSABLE, '1', 'only run against disposable test state');
  for (const url of ['/controller', '/controller/monitor', '/controller/roots.json']) {
    const res = await fetch(base + url, {redirect: 'manual'});
    assert.equal(res.status, 302, 'must require login: ' + url);
  }
  const login = await fetch(base + '/login', {method: 'POST', redirect: 'manual',
    headers: {'Content-Type': 'application/x-www-form-urlencoded'}, body: 'username=admin&password=password'});
  assert.equal(login.status, 302);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  for (const lang of ['zh-CN', 'en']) {
    for (const page of ['/controller', '/controller/monitor']) {
      const response = await fetch(base + page + '?lang=' + lang, {headers: {cookie}, redirect: 'manual'});
      const html = await response.text();
      assert.equal(response.status, 200, page);
      assert.ok(html.includes(lang === 'en' ? 'Planet Root topology' : 'Planet Root 拓扑'));
      assert.ok(!html.includes('monitor.root_'), 'untranslated Root key');
      assert.ok(!html.includes('authtoken.secret'));
    }
  }
  const response = await fetch(base + '/controller/roots.json', {headers: {cookie}, redirect: 'manual'});
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const data = await response.json();
  assert.equal(data.topology.roots.length, Number(process.env.PLANET_TEST_ROOTS || 1));
  assert.equal(data.topology.roots.filter(root => root.service.state === 'local').length, 1);
  assert.equal(data.topology.worldId, data.topology.runtimeWorldId);
  assert.equal(data.topology.timestamp, data.topology.runtimeTimestamp);
  assert.ok(data.listeners.some(listener => listener.state === 'listening'));
  assert.ok(!JSON.stringify(data).includes('identity.secret'));
  console.log('PASS: dashboard/monitor render in Chinese and English; protected topology JSON shares the same model');

  const extra = await fetch('http://127.0.0.2:3443/controller/roots.json', {
    headers: {cookie}, redirect: 'manual'
  });
  assert.equal(extra.status, 200, 'both listeners use the same session store');
  assert.equal((await extra.json()).topology.controllerId, data.topology.controllerId);
  assert.ok(data.listeners.some(listener => listener.host === '127.0.0.2' && listener.state === 'listening'));
  console.log('PASS: the same authenticated session is accepted by both explicit listeners');

  const metadataPath = '/app/config/planet-roots.json';
  const originalMetadata = await fs.readFile(metadataPath);
  try {
    for (const invalid of ['{', JSON.stringify({roots: [{identity: 'invalid'}]})]) {
      await fs.writeFile(metadataPath, invalid);
      for (const page of ['/controller', '/controller/monitor']) {
        const degraded = await fetch(base + page + '?lang=en', {headers: {cookie}, redirect: 'manual'});
        assert.equal(degraded.status, 200, 'metadata errors must not break the page');
        assert.ok((await degraded.text()).includes('Root metadata is unavailable'));
      }
      const degraded = await fetch(base + '/controller/roots.json', {headers: {cookie}, redirect: 'manual'});
      assert.equal(degraded.status, 200);
      assert.equal((await degraded.json()).topology.available, false);
    }
  } finally { await fs.writeFile(metadataPath, originalMetadata); }
  console.log('PASS: corrupt/malformed Root metadata degrades the panel without breaking the dashboard or monitor');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
