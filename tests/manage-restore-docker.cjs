// Real Docker regression: sudo node tests/manage-restore-docker.cjs IMAGE
// The Docker daemon and test process must see the temporary directory at the
// same absolute path. Never use live state, fixed ports or existing containers.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');
const dgram = require('node:dgram');
const { spawnSync } = require('node:child_process');
const image = process.argv[2] || process.env.ZEROTIER_RESTORE_TEST_IMAGE;
if (!image) throw new Error('Usage: sudo node tests/manage-restore-docker.cjs IMAGE');
if (process.getuid && process.getuid() !== 0) throw new Error('Run as root: the disposable ZeroTier state is root-owned and mode 0700.');
const repo = path.resolve(__dirname, '..');
const base = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'planet-restore-e2e-'));
const checkout = path.join(base, 'checkout');
const data = path.join(base, 'data');
const backups = path.join(base, 'backups');
const name = 'planet-restore-' + crypto.randomBytes(6).toString('hex');
// Do not inherit deployment-related variables from the invoking shell.
const env = { PATH: process.env.PATH, HOME: process.env.HOME, COMPOSE_PROJECT_NAME: name, HEALTH_TIMEOUT_SECONDS: '8' };
const volumes = ['dist', 'one', 'config', 'ztncui-state'];
function run(command, args, { ok = true, input, timeout = 180000, extraEnv } = {}) {
  const result = spawnSync(command, args, { cwd: checkout, env: { ...env, ...extraEnv }, input, encoding: 'utf8', timeout });
  // Do not echo output, arguments or response bodies: tests handle private state.
  if (result.error || (ok && result.status !== 0)) {
    // Management errors contain public diagnostics and test-owned paths. Keep
    // container logs/API bodies hidden while making the failing phase clear.
    const diagnostic = command === 'bash' ? (result.stderr || '').split('\n').filter(line => line.startsWith('[planet] ERROR:')).join('\n') : '';
    const operation = command === 'bash' ? `manage ${args[1]}` : command;
    throw new Error(`${operation} failed: status=${result.status}, error=${result.error ? result.error.code : 'none'}${diagnostic ? '\n' + diagnostic : ''}`);
  }
  return result;
}
const manage = (args, options) => run('bash', ['manage.sh', ...args], options);
const compose = (args, options) => run('docker', ['compose', ...args], options);
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(path.join(data, file))).digest('hex');
function hashes() { return Object.fromEntries(['one/identity.secret', 'one/identity.public', 'one/planet', 'dist/planet', 'ztncui-state/passwd', 'config/session.secret'].map(file => [file, hash(file)])); }
function compareHashes(before) { for (const [file, value] of Object.entries(before)) assert.equal(hash(file), value, `${file} changed`); }
async function freePort() {
  const tcp = net.createServer();
  await new Promise((resolve, reject) => { tcp.once('error', reject); tcp.listen(0, '0.0.0.0', resolve); });
  const port = tcp.address().port;
  const udp = dgram.createSocket('udp4');
  try { await new Promise((resolve, reject) => { udp.once('error', reject); udp.bind(port, '0.0.0.0', resolve); }); }
  catch { await new Promise(resolve => tcp.close(resolve)); udp.close(); return freePort(); }
  udp.close(); await new Promise(resolve => tcp.close(resolve));
  return port;
}
// Exercise actual authenticated UI routes and Controller API inside the test
// container; the harness itself may run in a Docker socket runner container.
const stateScript = String.raw`
const assert = require('node:assert/strict');
const fs = require('node:fs');
const phase = process.argv[2];
const token = fs.readFileSync('/var/lib/zerotier-one/authtoken.secret', 'utf8').trim();
const apiBase = 'http://127.0.0.1:' + process.env.ZT_PORT;
const uiBase = 'http://127.0.0.1:' + process.env.API_PORT;
const secret = 'disposable-restore-password';
const snapshot = '/app/config/restore-test.json';
async function request(url, options = {}) { return fetch(url, { ...options, redirect: 'manual', signal: AbortSignal.timeout(10000) }); }
async function api(route, body) {
  const response = await request(apiBase + route, { method: body === undefined ? 'GET' : 'POST',
    headers: { 'X-ZT1-Auth': token, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  assert.equal(response.status, 200, 'Controller request failed'); return response.json();
}
async function login(password) {
  const response = await request(uiBase + '/login', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ username: 'admin', password }).toString() });
  assert.equal(response.status, 302);
  const cookie = response.headers.get('set-cookie').split(';')[0];
  const page = await request(uiBase + '/controller', { headers: { cookie } });
  assert.equal(page.status, 200, 'custom Web password must authenticate'); await page.text(); return cookie;
}
(async () => {
  if (phase === 'seed') {
    const status = await api('/status'); const nwid = status.address + '123456'; const memberId = '0123456789';
    const network = await api('/controller/network/' + nwid, { name: 'restore-e2e', private: true, mtu: 1280 });
    const member = await api('/controller/network/' + nwid + '/member/' + memberId, { authorized: true, activeBridge: false, ipAssignments: ['172.30.99.125'] });
    const cookie = await login('password');
    const response = await request(uiBase + '/users/admin/password', { method: 'POST', headers: { cookie, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ username: 'admin', password1: secret, password2: secret }).toString() });
    assert.equal(response.status, 200); await response.text(); await login(secret);
    fs.writeFileSync(snapshot, JSON.stringify({ nwid, memberId, network, member }), { mode: 0o600 });
  } else {
    const before = JSON.parse(fs.readFileSync(snapshot));
    if (phase === 'mutate') {
      before.network = await api('/controller/network/' + before.nwid, { name: 'state-before-failed-restore' });
      fs.writeFileSync(snapshot, JSON.stringify(before), { mode: 0o600 });
    } else {
      assert.deepEqual(await api('/controller/network'), [before.nwid]);
      assert.deepEqual(await api('/controller/network/' + before.nwid), before.network, 'network configuration must survive');
      assert.deepEqual(await api('/controller/network/' + before.nwid + '/member/' + before.memberId), before.member, 'member authorization must survive');
      await login(secret);
    }
  }
})().catch(() => { console.error('Real Controller/Web state verification failed'); process.exitCode = 1; });
`;
function state(phase) { run('docker', ['exec', '-i', name, 'node', '-', phase], { input: stateScript }); }
async function main() {
  fs.mkdirSync(checkout, { mode: 0o700 });
  for (const file of ['manage.sh', 'docker-compose.yml']) fs.copyFileSync(path.join(repo, file), path.join(checkout, file));
  for (const label of volumes) fs.mkdirSync(path.join(data, label), { recursive: true, mode: 0o700 });
  fs.mkdirSync(backups, { mode: 0o700 });
  const ztPort = await freePort(); let uiPort = await freePort(); while (uiPort === ztPort) uiPort = await freePort();
  fs.writeFileSync(path.join(checkout, '.env'), Object.entries({ ZT_IMAGE: image, CONTAINER_NAME: name, IMAGE_SOURCE: 'pull', DATA_DIR: data, ZTNCUI_STATE_DIR: path.join(data, 'ztncui-state'), BACKUP_DIR: backups, IP_ADDR4: '127.0.0.1', IP_ADDR6: '', HTTP_HOST: '127.0.0.1', ZT_PORT: ztPort, API_PORT: uiPort, DEFAULT_NETWORK_MTU: 1280, PLANET_MODE: 'generated', ROOT_ONLY: 0, CONTROLLER_ONLY: 0 }).map(([key, value]) => `${key}=${value}`).join('\n') + '\n', { mode: 0o600 });
  // Faster health checks keep expected failure coverage bounded.
  fs.writeFileSync(path.join(checkout, 'docker-compose.override.yml'), 'services:\n  myztplanet:\n    healthcheck:\n      interval: 1s\n      timeout: 3s\n      retries: 1\n      start_period: 1s\n');
  run('docker', ['image', 'inspect', image]);
  manage(['up'], { extraEnv: { HEALTH_TIMEOUT_SECONDS: '45' } });
  state('seed');
  const before = hashes();
  manage(['backup']);
  const backupNames = fs.readdirSync(backups); assert.equal(backupNames.length, 1);
  const backup = path.join(backups, backupNames[0]);
  // A controlled stop avoids deleting files underneath the running daemon.
  compose(['stop', '-t', '5', 'myztplanet']);
  fs.rmSync(path.join(data, 'one'), { recursive: true });
  fs.rmSync(path.join(data, 'config'), { recursive: true });
  manage(['restore', backup, '--yes'], { extraEnv: { HEALTH_TIMEOUT_SECONDS: '45' } });
  compareHashes(before); state('verify');
  console.log('PASS: actual backup manifest, deleted identity/config recovery, Planet, network, authorization and custom Web login');

  const stateBeforeReject = JSON.parse(run('docker', ['inspect', name]).stdout)[0];
  fs.writeFileSync(path.join(backup, 'unlisted-sentinel'), 'must reject');
  assert.notEqual(manage(['restore', backup, '--yes'], { ok: false }).status, 0);
  const stateAfterReject = JSON.parse(run('docker', ['inspect', name]).stdout)[0];
  assert.equal(stateAfterReject.Id, stateBeforeReject.Id);
  assert.equal(stateAfterReject.State.StartedAt, stateBeforeReject.State.StartedAt);
  assert.equal(stateAfterReject.State.Running, true);
  fs.unlinkSync(path.join(backup, 'unlisted-sentinel')); state('verify');
  console.log('PASS: unlisted backup file rejected without stopping or replacing the running instance');

  state('mutate');
  fs.writeFileSync(path.join(data, 'config/rollback-sentinel'), 'preserve current state');
  const oldSnapshot = fs.readFileSync(path.join(data, 'config/restore-test.json'));
  const failureFile = path.join(checkout, 'health-failure.yml');
  fs.writeFileSync(failureFile, 'services:\n  myztplanet:\n    healthcheck:\n      test: ["CMD", "false"]\n      interval: 1s\n      timeout: 1s\n      retries: 1\n      start_period: 0s\n');
  const failed = manage(['restore', backup, '--yes'], { ok: false, extraEnv: { COMPOSE_FILE: `${path.join(checkout, 'docker-compose.yml')}:${failureFile}` } });
  assert.notEqual(failed.status, 0, 'forced unhealthy restore must fail');
  assert.equal(fs.readFileSync(path.join(data, 'config/rollback-sentinel'), 'utf8'), 'preserve current state');
  assert.ok(fs.readFileSync(path.join(data, 'config/restore-test.json')).equals(oldSnapshot), 'rollback must retain latest Controller snapshot');
  compareHashes(before);
  // Remove the deliberately failing healthcheck by recreating with normal Compose.
  compose(['up', '-d', '--no-build', '--force-recreate', 'myztplanet']);
  manage(['restart'], { extraEnv: { HEALTH_TIMEOUT_SECONDS: '45' } });
  state('verify');
  console.log('PASS: real unhealthy-container rollback preserves pre-restore Controller state and custom credentials');
}
main().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => {
  // Only this uniquely named test container can be removed. Do not delete its
  // mounts if Docker cannot confirm container removal.
  const removed = run('docker', ['rm', '-f', name], { ok: false, timeout: 30000 });
  if (removed.status === 0 || run('docker', ['inspect', name], { ok: false }).status !== 0) fs.rmSync(base, { recursive: true, force: true });
  else { console.error('Cleanup could not remove test container; retained state at ' + base); process.exitCode = 1; }
});
