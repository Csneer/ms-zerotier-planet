// Run only inside tests/multi-root.mjs disposable, network-isolated containers.
// Seed real Controller/Web state, then verify it after reusing the same mounts.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const {createRequire} = require('node:module');
const appRequire = createRequire('/opt/ztncui/src/package.json');
const snapshotPath = '/app/config/in-place-test.json';
const uiBase = 'http://127.0.0.1:3443';
const changedPassword = 'disposable-upgrade-password';

async function request(url, options = {}) {
  return fetch(url, {...options, redirect: 'manual', signal: AbortSignal.timeout(10000),
    headers: {'Connection': 'close', ...options.headers}});
}

async function login(password) {
  const response = await request(uiBase + '/login', {method: 'POST',
    headers: {'Content-Type': 'application/x-www-form-urlencoded'},
    body: new URLSearchParams({username: 'admin', password}).toString()});
  assert.equal(response.status, 302, 'login must redirect');
  const cookie = response.headers.get('set-cookie').split(';')[0];
  const authenticated = await request(uiBase + '/controller', {headers: {cookie}});
  assert.equal(authenticated.status, 200, 'saved credentials must authenticate');
  await authenticated.text();
  return cookie;
}

async function main() {
  assert.equal(process.env.PLANET_TEST_DISPOSABLE, '1', 'requires disposable test state');
  const phase = process.argv[2];
  assert.ok(phase === 'seed' || phase === 'verify');
  const port = (await fs.readFile('/app/config/zerotier-one.port', 'utf8')).trim();
  const token = (await fs.readFile('/var/lib/zerotier-one/authtoken.secret', 'utf8')).trim();
  async function api(route, body) {
    const response = await request('http://127.0.0.1:' + port + route, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {'X-ZT1-Auth': token, 'Content-Type': 'application/json'},
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    assert.equal(response.status, 200, 'disposable Controller API request must succeed');
    return response.json();
  }
  const status = await api('/status');
  const storage = appRequire('node-persist');
  await storage.init({dir: '/var/lib/ztncui/storage'});

  if (phase === 'seed') {
    const memberId = process.env.PLANET_TEST_MEMBER;
    assert.match(memberId, /^[0-9a-f]{10}$/);
    const nwid = status.address + '123456';
    const networkPath = '/controller/network/' + nwid;
    const network = await api(networkPath, {name: 'in-place-upgrade-network', private: true,
      mtu: 1280, routes: [{target: '172.30.90.0/24', via: null}],
      v4AssignMode: {zt: true},
      ipAssignmentPools: [{ipRangeStart: '172.30.90.100', ipRangeEnd: '172.30.90.110'}]});
    const member = await api(networkPath + '/member/' + memberId,
      {authorized: true, activeBridge: false, ipAssignments: ['172.30.90.125']});
    const alias = 'persisted-upgrade-member';
    await storage.setItem(memberId, alias);
    const cookie = await login('password');
    const changed = await request(uiBase + '/users/admin/password', {method: 'POST',
      headers: {cookie, 'Content-Type': 'application/x-www-form-urlencoded'},
      body: new URLSearchParams({username: 'admin', password1: changedPassword,
        password2: changedPassword}).toString()});
    assert.equal(changed.status, 200, 'custom password must be saved');
    await changed.text();
    await login(changedPassword);
    assert.equal(network.nwid, nwid);
    assert.equal(member.authorized, true);
    assert.deepEqual(member.ipAssignments, ['172.30.90.125']);
    await fs.writeFile(snapshotPath, JSON.stringify({controllerId: status.address,
      worldId: status.planetWorldId, timestamp: status.planetWorldTimestamp,
      nwid, memberId, alias, network, member}), {mode: 0o600});
    console.log('PASS: seeded Controller network, authorized fixed-IP member, alias and non-default Web password');
  } else {
    const before = JSON.parse(await fs.readFile(snapshotPath, 'utf8'));
    assert.equal(status.address, before.controllerId, 'Controller identity must not change');
    assert.equal(status.planetWorldId, before.worldId, 'World ID must not change');
    assert.ok(status.planetWorldTimestamp > before.timestamp, 'new signed World must advance timestamp');
    assert.deepEqual(await api('/controller/network'), [before.nwid]);
    const networkPath = '/controller/network/' + before.nwid;
    assert.deepEqual(await api(networkPath), before.network, 'complete network config must survive');
    assert.deepEqual(await api(networkPath + '/member/' + before.memberId), before.member,
      'complete member authorization/IP configuration must survive');
    assert.equal(await storage.getItem(before.memberId), before.alias);
    const cookie = await login(changedPassword);
    for (const host of [uiBase, 'http://127.0.0.2:3443']) {
      const network = await request(host + networkPath + '?lang=en', {headers: {cookie}});
      assert.equal(network.status, 200, 'network page must survive on both listeners');
      const html = await network.text();
      for (const value of [before.network.name, before.memberId, before.alias, '172.30.90.125']) {
        assert.ok(html.includes(value), 'network page must retain ' + value);
      }
      const roots = await request(host + '/controller/roots.json', {headers: {cookie}});
      assert.equal(roots.status, 200);
      const {topology} = await roots.json();
      assert.equal(topology.mode, 'external');
      assert.equal(topology.controllerId, before.controllerId);
      assert.equal(topology.worldId, before.worldId);
      assert.equal(topology.runtimeWorldId, before.worldId);
      assert.equal(topology.runtimeTimestamp, status.planetWorldTimestamp);
      assert.equal(topology.roots.length, 2);
    }
    const monitor = await request(uiBase + '/controller/monitor?lang=en', {headers: {cookie}});
    assert.equal(monitor.status, 200);
    const html = await monitor.text();
    assert.ok(html.includes(before.network.name));
    assert.ok(html.includes(before.alias));
    console.log('PASS: external upgrade retains network/member API state, custom Web login, aliases and both management listeners');
  }
}

main().catch(error => {
  // Avoid printing response objects that might contain credentials or identities.
  console.error('In-place state regression failed:', error.message);
  process.exitCode = 1;
});
