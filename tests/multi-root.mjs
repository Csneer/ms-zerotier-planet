// Offline regression tests. All identities/state are disposable; no host ports
// or production mounts are used. Run as root: sudo node tests/multi-root.mjs IMAGE
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const image = process.argv[2];
if (!image) throw new Error('Usage: node tests/multi-root.mjs IMAGE');
if (process.getuid && process.getuid() !== 0) {
  throw new Error('Run this offline container regression with sudo: ZeroTier secures its disposable bind-mounted state with root ownership and mode 0700.');
}
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'planet-regression-'));
const containers = new Set();
let serial = 0;
function run(command, args, ok = true) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 90000 });
  if (ok && result.status !== 0) {
    // Never echo command output: a failing identity tool could include secrets.
    throw new Error(`${command} failed: status=${result.status}, error=${result.error || ''}`);
  }
  return result;
}
function dir(name) {
  const result = path.join(base, name);
  fs.mkdirSync(result, { recursive: true, mode: 0o700 });
  return result;
}
function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
}
function world(state, args = [], ok = true) {
  return run('docker', ['run', '--rm', '--network', 'none', '--entrypoint',
    '/usr/local/libexec/mkworld', '-v', `${state}:/work`, '-w', '/work', image, ...args], ok);
}
function identity(state) {
  run('docker', ['run', '--rm', '--network', 'none', '--entrypoint', 'zerotier-idtool',
    '-v', `${state}:/work`, image, 'generate', '/work/identity.secret', '/work/identity.public']);
  return fs.readFileSync(path.join(state, 'identity.public'), 'utf8').trim();
}
function copy(source, target) { fs.copyFileSync(source, target); }
function pass(message) { console.log(`PASS: ${message}`); }
function mountState(name) {
  const state = dir(name);
  const mounts = ['one', 'config', 'dist', 'ui'].map((part, index) => {
    const dest = ['/var/lib/zerotier-one', '/app/config', '/app/dist', '/var/lib/ztncui'][index];
    return ['-v', `${dir(`${name}/${part}`)}:${dest}`];
  }).flat();
  return { state, mounts };
}
function start(test, env) {
  const name = `planet-regression-${process.pid}-${++serial}`;
  containers.add(name);
  run('docker', ['run', '-d', '--name', name, '--network', 'none', ...test.mounts,
    '-e', 'IP_ADDR4=198.51.100.10', ...Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]), image]);
  return name;
}
async function ready(name) {
  for (let i = 0; i < 60; i++) {
    if (run('docker', ['exec', name, '/usr/local/bin/healthcheck.sh'], false).status === 0) return;
    const state = run('docker', ['inspect', '-f', '{{.State.Running}}', name]).stdout.trim();
    if (state !== 'true') throw new Error('Test container exited before health check');
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error('Test container did not become ready');
}
async function rejected(name) {
  const result = run('docker', ['wait', name]);
  assert.notEqual(result.stdout.trim(), '0');
}
function stop(name) { run('docker', ['stop', '-t', '5', name]); }

try {
  const a = dir('root-a');
  const b = dir('root-b');
  const publicA = identity(a);
  const publicB = identity(b);
  const roots = { roots: [
    { identity: publicA, stableEndpoints: ['198.51.100.10/9994'] },
    { identity: publicB, stableEndpoints: ['198.51.100.11/9994'] }
  ] };
  const signer = dir('signer');
  writeJson(path.join(signer, 'moon.json'), roots);
  world(signer);
  const first = JSON.parse(world(signer, ['--inspect', 'world.bin']).stdout);
  assert.equal(first.roots.length, 2);
  copy(path.join(signer, 'world.bin'), path.join(signer, 'world.bin.previous'));
  world(signer);
  const second = JSON.parse(world(signer, ['--inspect', 'world.bin']).stdout);
  assert.ok(second.timestamp > first.timestamp);
  world(signer, ['--verify-update', 'world.bin.previous', 'world.bin']);
  assert.notEqual(world(signer, ['--verify-update', 'world.bin', 'world.bin.previous'], false).status, 0);
  assert.notEqual(world(signer, ['--verify-update', 'world.bin', 'world.bin'], false).status, 0);
  pass('two-root world; signed newer update accepted, old/equal timestamps rejected');

  const badFixtures = [
    { roots: [roots.roots[0], roots.roots[0]] },
    { roots: [] },
    { roots: { a: roots.roots[0] } },
    { roots: [{ ...roots.roots[0], identity: fs.readFileSync(path.join(a, 'identity.secret'), 'utf8').trim() }] },
    ...['0', '65536', '999999999999', '-1', 'abc', '1234garbage'].map(port => ({ roots: [
      { ...roots.roots[0], stableEndpoints: [`198.51.100.10/${port}`] }
    ] })),
    { roots: [{ ...roots.roots[0], stableEndpoints: ['bad-address/9994'] }] }
  ];
  for (let i = 0; i < badFixtures.length; i++) {
    const state = dir(`invalid-${i}`);
    writeJson(path.join(state, 'moon.json'), badFixtures[i]);
    assert.notEqual(world(state, [], false).status, 0);
  }
  pass('duplicate/private identities, empty roots, malformed shape and endpoints rejected');

  const wrong = dir('wrong-signer');
  writeJson(path.join(wrong, 'moon.json'), roots);
  world(wrong);
  copy(path.join(signer, 'world.bin'), path.join(wrong, 'world.bin.previous'));
  assert.notEqual(world(wrong, [], false).status, 0);
  const missing = dir('missing-key');
  copy(path.join(signer, 'previous.c25519'), path.join(missing, 'previous.c25519'));
  writeJson(path.join(missing, 'moon.json'), roots);
  assert.notEqual(world(missing, [], false).status, 0);
  assert.ok(!fs.existsSync(path.join(missing, 'current.c25519')));
  const truncated = fs.readFileSync(path.join(signer, 'world.bin')).subarray(0, 64);
  fs.writeFileSync(path.join(missing, 'truncated'), truncated);
  assert.notEqual(world(missing, ['--inspect', 'truncated'], false).status, 0);
  pass('wrong signer, incomplete signing keys and truncated world rejected');

  copy(path.join(signer, 'world.bin'), path.join(signer, 'planet'));
  const output = path.join(base, 'bundle');
  run('bash', ['planet-bundle.sh', image, signer, path.join(signer, 'moon.json'), output]);
  assert.deepEqual(fs.readdirSync(output).sort(), ['SHA256SUMS', 'planet', 'roots.json']);
  pass('offline bundle contains only public world, metadata and checksums');

  const follower = mountState('follower');
  for (const file of ['identity.secret', 'identity.public']) copy(path.join(b, file), path.join(follower.state, 'one', file));
  copy(path.join(signer, 'world.bin.previous'), path.join(follower.state, 'config/planet'));
  const f = start(follower, { PLANET_MODE: 'external', ROOT_ONLY: '1' });
  await ready(f);
  assert.ok(!fs.existsSync(path.join(follower.state, 'one/current.c25519')));
  assert.ok(!fs.existsSync(path.join(follower.state, 'one/previous.c25519')));
  assert.ok(!fs.existsSync(path.join(follower.state, 'ui/passwd')));
  const secretBefore = fs.readFileSync(path.join(follower.state, 'one/identity.secret'));
  stop(f);
  copy(path.join(signer, 'world.bin'), path.join(follower.state, 'config/planet'));
  run('docker', ['start', f]);
  await ready(f);
  assert.deepEqual(fs.readFileSync(path.join(follower.state, 'one/planet')), fs.readFileSync(path.join(signer, 'world.bin')));
  assert.deepEqual(fs.readFileSync(path.join(follower.state, 'one/identity.secret')), secretBefore);
  stop(f);
  copy(path.join(signer, 'world.bin.previous'), path.join(follower.state, 'config/planet'));
  run('docker', ['start', f]);
  await rejected(f);
  pass('external root starts without world keys/UI; signed update preserves identity; stale restart rejected');

  const externalUi = mountState('external-ui');
  for (const file of ['identity.secret', 'identity.public']) copy(path.join(a, file), path.join(externalUi.state, 'one', file));
  copy(path.join(signer, 'world.bin'), path.join(externalUi.state, 'config/planet'));
  const e = start(externalUi, { PLANET_MODE: 'external', ROOT_ONLY: '0', HTTP_EXTRA_HOSTS: '127.0.0.2' });
  await ready(e);
  run('docker', ['cp', 'tests/ui-http.cjs', `${e}:/tmp/ui-http.cjs`]);
  run('docker', ['exec', '-e', 'PLANET_TEST_DISPOSABLE=1', '-e', 'PLANET_TEST_ROOTS=2', e, 'node', '/tmp/ui-http.cjs']);
  stop(e);
  pass('two-root external World renders through both authenticated management listeners');

  const generated = mountState('generated');
  const g = start(generated, { PLANET_MODE: 'generated', ROOT_ONLY: '0', HTTP_EXTRA_HOSTS: '127.0.0.2' });
  await ready(g);
  run('docker', ['cp', 'tests/ui-http.cjs', `${g}:/tmp/ui-http.cjs`]);
  run('docker', ['exec', '-e', 'PLANET_TEST_DISPOSABLE=1', g, 'node', '/tmp/ui-http.cjs']);
  run('docker', ['cp', 'tests/ui-fallback.cjs', `${g}:/tmp/ui-fallback.cjs`]);
  run('docker', ['exec', '-e', 'PLANET_TEST_DISPOSABLE=1', g, 'node', '/tmp/ui-fallback.cjs']);
  pass('authenticated bilingual dashboard/monitor/JSON, shared listeners and topology-failure degradation');
  const single = JSON.parse(world(path.join(generated.state, 'one'), ['--inspect', 'planet']).stdout);
  assert.equal(single.roots.length, 1);
  stop(g);
  copy(path.join(signer, 'world.bin'), path.join(generated.state, 'one/planet'));
  run('docker', ['start', g]);
  await rejected(g);
  pass('legacy single-root/UI bootstrap works; generated mode refuses multi-root state');
} finally {
  for (const name of containers) run('docker', ['rm', '-f', '-v', name], false);
  // Only this process's mkdtemp directory; never a user-provided state path.
  fs.rmSync(base, { recursive: true, force: true });
}
