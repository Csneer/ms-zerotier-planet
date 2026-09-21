// Run inside a disposable, fresh UI container with default test credentials.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const net = require('node:net');
const base = 'http://127.0.0.1:3443';

async function endpointProbePages(cookie) {
  assert.equal(process.env.PLANET_TEST_DISPOSABLE, '1', 'probe fixtures require disposable test state');
  const configPath = '/app/config/endpoint-probes.json';
  let originalConfig = null;
  let originalMode = 0o600;
  try {
    originalMode = (await fs.stat(configPath)).mode & 0o777;
    originalConfig = await fs.readFile(configPath);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const sockets = new Set();
  let connectionCount = 0;
  let receivedBytes = 0;
  const server = net.createServer(socket => {
    connectionCount++;
    sockets.add(socket);
    socket.on('data', data => { receivedBytes += data.length; });
    socket.on('error', () => {});
    socket.once('close', () => sockets.delete(socket));
  });
  const words = {
    'zh-CN': {
      title: '端点业务探针', description: '只读 TCP 建连检查',
      unconfigured: '未配置', noScan: '监控不会自动探测任意端口',
      reachable: '可达', refused: '端口拒绝', disabled: '已禁用', invalid: '配置无效',
      scope: '不代表 ZeroTier 端点直连、不代表业务协议可用，也不代表流量经过哪个 Root',
      source: '此管理实例到目标 IP:端口可达', configError: '配置错误',
      configErrorDescription: '端点探针配置不可用'
    },
    en: {
      title: 'Endpoint service probes', description: 'Read-only TCP connects',
      unconfigured: 'NOT CONFIGURED', noScan: 'the monitor never scans arbitrary ports',
      reachable: 'REACHABLE', refused: 'REFUSED', disabled: 'DISABLED', invalid: 'INVALID',
      scope: 'It does not prove a direct ZeroTier path, application-protocol health, or which Root carries traffic',
      source: 'this management instance can reach the target IP:port', configError: 'CONFIG ERROR',
      configErrorDescription: 'Endpoint probe configuration is unavailable'
    }
  };
  async function panel(lang) {
    const response = await fetch(base + '/controller/monitor?lang=' + lang, {
      headers: {cookie}, redirect: 'manual', signal: AbortSignal.timeout(20000)
    });
    assert.equal(response.status, 200, 'endpoint probe state must never make the monitor return 500');
    const html = await response.text();
    assert.ok(!html.includes('monitor.endpoint_probe'), 'endpoint probe strings must be translated');
    const section = (html.match(/<section\b[^>]*>[\s\S]*?<\/section>/g) || [])
      .find(value => value.includes('<h2>' + words[lang].title + '</h2>'));
    assert.ok(section, 'monitor must render the translated endpoint probe heading');
    assert.ok(section.includes(words[lang].description), 'TCP-only purpose must be explained');
    return section;
  }
  function row(section, name, state) {
    const result = (section.match(/<tr\b[^>]*>[\s\S]*?<\/tr>/g) || [])
      .find(value => value.includes('<strong>' + name + '</strong>'));
    assert.ok(result, 'probe row must be rendered: ' + name);
    assert.ok(result.includes('>' + state + '</span>'), 'probe row must have the correct translated state: ' + name);
    return result;
  }
  try {
    await fs.rm(configPath, {force: true});
    for (const lang of Object.keys(words)) {
      const section = await panel(lang);
      assert.ok(section.includes(words[lang].unconfigured));
      assert.ok(section.includes(words[lang].noScan), 'unconfigured monitoring must explain opt-in behavior');
    }
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const port = server.address().port;
    // The fixture is bound only to 127.0.0.1. The same port on the other
    // loopback address has no listener in these --network none containers.
    const entries = [
      {id: 'ui-reachable', name: 'UI probe reachable', address: '127.0.0.1', port, timeoutMs: 1000},
      {id: 'ui-refused', name: 'UI probe refused', address: '127.0.0.2', port, timeoutMs: 1000},
      {id: 'ui-disabled', name: 'UI probe disabled', address: '127.0.0.1', port, enabled: false},
      {id: 'ui-invalid', name: 'UI probe invalid', address: 'localhost', port}
    ];
    await fs.writeFile(configPath, JSON.stringify({probes: entries}), {mode: 0o600});
    for (const lang of Object.keys(words)) {
      const section = await panel(lang);
      assert.match(section, /1\s*\/\s*4/, 'only the reachable endpoint must count as reachable');
      const reachable = row(section, entries[0].name, words[lang].reachable);
      assert.ok(reachable.includes('127.0.0.1:' + port));
      assert.match(reachable, /<td>\d+ ms<\/td>/, 'successful TCP connect latency must be rendered');
      assert.ok(row(section, entries[1].name, words[lang].refused).includes('ECONNREFUSED'));
      assert.ok(row(section, entries[2].name, words[lang].disabled).includes('<td>—</td>'));
      assert.ok(row(section, entries[3].name, words[lang].invalid).includes('INVALID_ADDRESS'));
      assert.ok(section.includes(words[lang].source), 'probe origin must be this management instance');
      assert.ok(section.includes(words[lang].scope), 'TCP reachability must not imply direct routing or application health');
    }
    assert.equal(connectionCount, 2, 'each page must connect only the enabled, valid, reachable probe');
    assert.equal(receivedBytes, 0, 'TCP probes must not send any application payload');
    for (const invalid of ['{', JSON.stringify({probes: 'invalid'}),
      JSON.stringify({probes: [entries[0], entries[0]]})]) {
      await fs.writeFile(configPath, invalid);
      for (const lang of Object.keys(words)) {
        const section = await panel(lang);
        assert.ok(section.includes(words[lang].configError));
        assert.ok(section.includes(words[lang].configErrorDescription));
        assert.ok(section.includes('INVALID_CONFIG'), 'only a safe configuration error code is exposed');
        assert.ok(!section.includes(entries[0].name), 'bad configuration must not show stale successful rows');
      }
    }
    assert.equal(connectionCount, 2, 'invalid configurations must not initiate connections');
    console.log('PASS: bilingual endpoint probe panel covers opt-in, reachable/refused/disabled/invalid rows, latency, scope and safe configuration failures');
  } finally {
    try {
      if (originalConfig === null) await fs.rm(configPath, {force: true});
      else {
        await fs.writeFile(configPath, originalConfig, {mode: originalMode});
        await fs.chmod(configPath, originalMode);
      }
    } finally {
      for (const socket of sockets) socket.destroy();
      if (server.listening) await new Promise(resolve => server.close(resolve));
    }
  }
}

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
  assert.equal(data.topology.roots.filter(root => root.service.state === 'local').length,
    process.env.PLANET_TEST_CONTROLLER_ONLY === '1' ? 0 : 1);
  assert.equal(data.topology.role, process.env.PLANET_TEST_CONTROLLER_ONLY === '1' ? 'controller_only' : 'controller_root');
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

  await endpointProbePages(cookie);

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
