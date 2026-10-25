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
  const environment = {...env};
  if (!Object.prototype.hasOwnProperty.call(environment, 'IP_ADDR4')) environment.IP_ADDR4 = '198.51.100.10';
  // Dockerfile supplies empty address defaults. Omission at docker run does
  // not unset them; null explicitly exercises legacy unset entrypoint calls.
  const unset = Object.entries(environment).filter(([, v]) => v === null).map(([k]) => k);
  run('docker', ['run', '-d', '--name', name, '--network', 'none', ...test.mounts,
    ...(unset.length ? ['--entrypoint', '/usr/bin/env'] : []),
    ...Object.entries(environment).filter(([, v]) => v !== null).flatMap(([k, v]) => ['-e', `${k}=${v}`]), image,
    ...(unset.length ? [...unset.flatMap(k => ['-u', k]), '/usr/bin/tini', '--', '/usr/local/bin/entrypoint.sh'] : [])]);
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
async function rejected(name, reason) {
  const result = run('docker', ['wait', name]);
  assert.notEqual(result.stdout.trim(), '0');
  if (reason) {
    const logs = run('docker', ['logs', name]);
    assert.ok((logs.stdout + logs.stderr).includes(reason), 'startup must reject for: ' + reason);
  }
}
function stop(name) { run('docker', ['stop', '-t', '5', name]); }
function preservedFiles(state, paths) {
  const files = new Map();
  function read(relative) {
    const fullPath = path.join(state, relative);
    if (fs.statSync(fullPath).isDirectory()) {
      for (const child of fs.readdirSync(fullPath)) read(path.join(relative, child));
    } else files.set(relative, fs.readFileSync(fullPath));
  }
  for (const relative of paths) read(relative);
  return files;
}

function assertPreserved(state, before) {
  for (const [relative, value] of before) {
    // Do not let a failed assertion print secret contents.
    assert.ok(fs.readFileSync(path.join(state, relative)).equals(value),
      `in-place upgrade changed persisted ${relative}`);
  }
}

try {
  const a = dir('root-a');
  const b = dir('root-b');
  const publicA = identity(a);
  const publicB = identity(b);
  const roots = { roots: [
    { identity: publicA, stableEndpoints: ['198.51.100.10/9994', '2001:db8::10/9994'] },
    { identity: publicB, stableEndpoints: ['198.51.100.11/9994', '2001:db8::11/9994'] }
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

  // Address-family migration keeps the existing World signing chain and root
  // identities while allowing a Root to become IPv6-only.
  copy(path.join(signer, 'world.bin'), path.join(signer, 'world.bin.dual'));
  writeJson(path.join(signer, 'moon.json'), { roots: [
    { identity: publicA, stableEndpoints: ['2001:db8::10/9994'] },
    { identity: publicB, stableEndpoints: ['2001:db8::11/9994'] }
  ] });
  world(signer);
  const v6Only = JSON.parse(world(signer, ['--inspect', 'world.bin']).stdout);
  assert.ok(v6Only.timestamp > second.timestamp);
  assert.deepEqual(v6Only.roots.map(root => root.stableEndpoints),
    [['2001:db8::10/9994'], ['2001:db8::11/9994']]);
  assert.deepEqual(v6Only.roots.map(root => root.identity).sort(), [publicA, publicB].sort());
  world(signer, ['--verify-update', 'world.bin.dual', 'world.bin']);
  pass('signed dual-stack to IPv6-only migration removes IPv4 endpoints and preserves identities');

  const badFixtures = [
    { roots: [roots.roots[0], roots.roots[0]] },
    { roots: [] },
    { roots: { a: roots.roots[0] } },
    { roots: [{ ...roots.roots[0], identity: fs.readFileSync(path.join(a, 'identity.secret'), 'utf8').trim() }] },
    ...['0', '65536', '999999999999', '-1', 'abc', '1234garbage'].map(port => ({ roots: [
      { ...roots.roots[0], stableEndpoints: [`198.51.100.10/${port}`] }
    ] })),
    ...['::', '::1', '0:0:0:0:0:0:0:1', 'fe80::1', 'febf::1', 'ff02::1', '::ffff:0.0.0.0', '::ffff:127.0.0.1', '::ffff:224.0.0.1', '::ffff:198.51.100.10',
      'bad-address', '2001:db8::gg', '2001:::1', 'not:ipv6',
      '[2001:db8::1]', 'fe80::1%eth0', '2001:db8::1 garbage',
      '2001:db8::1\0garbage', '999.1.2.3', '198.51.100.10junk'].map(host => ({
      roots: [{ ...roots.roots[0], stableEndpoints: [`${host}/9994`] }]
    }))
  ];
  for (let i = 0; i < badFixtures.length; i++) {
    const state = dir(`invalid-${i}`);
    writeJson(path.join(state, 'moon.json'), badFixtures[i]);
    assert.notEqual(world(state, [], false).status, 0);
    assert.ok(!fs.existsSync(path.join(state, 'world.bin')), 'invalid input must not publish a World');
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

  // A Controller-only standby keeps its identity and Controller data but must
  // not be advertised as a Planet Root (nor retain local .moon files).
  for (const [label, environment, reason] of [
    ['controller-only-generated', {PLANET_MODE: 'generated', CONTROLLER_ONLY: '1'}, 'requires PLANET_MODE=external'],
    ['controller-only-root-only', {PLANET_MODE: 'external', CONTROLLER_ONLY: '1', ROOT_ONLY: '1'}, 'mutually exclusive'],
    ['controller-only-empty', {PLANET_MODE: 'external', CONTROLLER_ONLY: '1'}, 'existing ZeroTier identity']
  ]) {
    const emptyState = mountState(label);
    if (label === 'controller-only-empty') {
      writeJson(path.join(emptyState.state, 'config/controller-standby.json'), {
        schema: 1, state: 'active', role: 'controller-only', controllerId: '1111111111',
        instanceId: '11111111-1111-4111-8111-111111111111'
      });
    }
    const invalidRole = start(emptyState, environment);
    await rejected(invalidRole, reason);
    assert.ok(!fs.existsSync(path.join(emptyState.state, 'one/identity.secret')), 'rejected roles must never generate a new identity');
  }
  pass('controller-only requires external mode, an existing identity and no simultaneous root-only role');
  const controllerIdentityState = dir('controller-only-identity');
  const controllerPublic = identity(controllerIdentityState);
  assert.ok(!roots.roots.some(root => root.identity === controllerPublic),
    'controller-only test identity must not already be a Root');
  const controllerOnly = mountState('controller-only');
  for (const file of ['identity.secret', 'identity.public']) {
    copy(path.join(controllerIdentityState, file), path.join(controllerOnly.state, 'one', file));
  }
  copy(path.join(output, 'planet'), path.join(controllerOnly.state, 'config/planet'));
  const guardPath = path.join(controllerOnly.state, 'config/controller-standby.json');
  const activeGuard = {
    schema: 1, state: 'active', role: 'controller-only', controllerId: controllerPublic.split(':')[0],
    instanceId: '11111111-1111-4111-8111-111111111111'
  };
  const unguardedController = start(controllerOnly, {
    PLANET_MODE: 'external', ROOT_ONLY: '0', CONTROLLER_ONLY: '1', IP_ADDR4: ''
  });
  await rejected(unguardedController, 'requires an active controller standby guard');
  writeJson(guardPath, activeGuard);
  const c = start(controllerOnly, {
    PLANET_MODE: 'external', ROOT_ONLY: '0', CONTROLLER_ONLY: '1', IP_ADDR4: '', HTTP_EXTRA_HOSTS: '127.0.0.2'
  });
  await ready(c);
  run('docker', ['cp', 'tests/ui-http.cjs', `${c}:/tmp/ui-http.cjs`]);
  run('docker', ['exec', '-e', 'PLANET_TEST_DISPOSABLE=1', '-e', 'PLANET_TEST_ROOTS=2',
    '-e', 'PLANET_TEST_CONTROLLER_ONLY=1', c, 'node', '/tmp/ui-http.cjs']);
  const controllerRoots = JSON.parse(world(path.join(controllerOnly.state, 'one'), ['--inspect', 'planet']).stdout);
  assert.ok(!controllerRoots.roots.some(root => root.identity === controllerPublic));
  stop(c);
  pass('controller-only external role starts without a public IP and does not advertise its identity as a Root');

  const rootIncluded = path.join(base, 'controller-included-roots.json');
  writeJson(rootIncluded, {roots: [
    {identity: controllerPublic, stableEndpoints: ['198.51.100.12/9994']},
    roots.roots[0]
  ]});
  const rootIncludedBundle = path.join(base, 'controller-included-bundle');
  run('bash', ['planet-bundle.sh', image, signer, rootIncluded, rootIncludedBundle]);
  copy(path.join(rootIncludedBundle, 'planet'), path.join(controllerOnly.state, 'config/planet'));
  run('docker', ['start', c]);
  await rejected(c);
  pass('controller-only refuses an external Planet that still contains its identity as a Root');

  copy(path.join(output, 'planet'), path.join(controllerOnly.state, 'config/planet'));
  for (const guardState of ['staged', 'fenced']) {
    writeJson(guardPath, {...activeGuard, state: guardState});
    for (const role of [{CONTROLLER_ONLY: '1'}, {ROOT_ONLY: '1'}, {}]) {
      const blocked = start(controllerOnly, {PLANET_MODE: 'external', ...role});
      await rejected(blocked, 'controller standby guard is ' + guardState);
    }
  }
  pass('staged and fenced controller standby guards block every runtime role');
  for (const [guard, reason] of [
    [{...activeGuard, schema: 2}, 'invalid controller standby guard'],
    [{...activeGuard, state: 'unknown'}, 'invalid controller standby guard'],
    [{...activeGuard, instanceId: 'invalid'}, 'invalid controller standby guard'],
    [{...activeGuard, controllerId: publicB.split(':')[0]}, 'does not match this identity']
  ]) {
    writeJson(guardPath, guard);
    run('docker', ['start', c]);
    await rejected(c, reason);
  }
  writeJson(guardPath, activeGuard);
  for (const role of [{ROOT_ONLY: '1'}, {}]) {
    const blocked = start(controllerOnly, {PLANET_MODE: 'external', ...role});
    await rejected(blocked, 'active controller standby guard requires CONTROLLER_ONLY=1');
  }
  run('docker', ['start', c]);
  await ready(c);
  writeJson(guardPath, {...activeGuard, state: 'fenced'});
  assert.notEqual(run('docker', ['exec', c, '/usr/local/bin/healthcheck.sh'], false).status, 0,
    'a fenced guard must fail health even before the process is stopped');
  writeJson(guardPath, activeGuard);
  fs.writeFileSync(path.join(controllerOnly.state, 'dist/planet'), 'corrupt');
  assert.notEqual(run('docker', ['exec', c, '/usr/local/bin/healthcheck.sh'], false).status, 0,
    'health must reject inconsistent distributed Planet');
  copy(path.join(output, 'planet'), path.join(controllerOnly.state, 'dist/planet'));
  await ready(c);
  stop(c);
  fs.mkdirSync(path.join(controllerOnly.state, 'one/moons.d'), {recursive: true});
  fs.writeFileSync(path.join(controllerOnly.state, 'one/moons.d/stale.moon'), 'fixture');
  run('docker', ['start', c]);
  await rejected(c, 'refuses stale local Moon files');
  pass('active controller standby guard permits only the matching controller-only identity');

  // Exercise the actual startup path, including persisted values and signed
  // endpoint changes. null explicitly unsets a variable before entrypoint.
  const families = mountState('address-families');
  // A deterministic discovery response makes accidental IPv4 discovery fail
  // even with --network none, rather than passing because curl cannot connect.
  const curlShim = path.join(families.state, 'curl');
  fs.writeFileSync(curlShim, `#!/bin/sh
case "$*" in
  *https://ipv4.icanhazip.com/*)
    touch /app/config/unexpected-ipv4-discovery
    echo 198.51.100.250
    exit 0 ;;
esac
exec /usr/bin/curl "$@"
`, {mode: 0o755});
  families.mounts.push('-v', `${curlShim}:/usr/local/bin/curl:ro`);
  const familyState = path.join(families.state, 'one');
  let priorFamilyWorld;
  let familyIdentity;
  for (const [label, addresses, expected] of [
    ['fresh IPv6-only with IPv4 explicitly unset', {IP_ADDR4: null, IP_ADDR6: '2001:db8::20'}, ['2001:db8::20/9994']],
    ['explicitly unset variables retain saved IPv6-only', {IP_ADDR4: null, IP_ADDR6: null}, ['2001:db8::20/9994']],
    ['dual-stack', {IP_ADDR4: '198.51.100.20', IP_ADDR6: '2001:db8::20'}, ['198.51.100.20/9994', '2001:db8::20/9994']],
    ['explicit empty IPv4 removes saved endpoint', {IP_ADDR4: '', IP_ADDR6: '2001:db8::20'}, ['2001:db8::20/9994']],
    ['explicit empty IPv6 removes saved endpoint', {IP_ADDR4: '198.51.100.20', IP_ADDR6: ''}, ['198.51.100.20/9994']]
  ]) {
    const instance = start(families, {PLANET_MODE: 'generated', ROOT_ONLY: '1', ...addresses});
    await ready(instance);
    const current = JSON.parse(world(familyState, ['--inspect', 'planet']).stdout);
    assert.deepEqual(current.roots[0].stableEndpoints, expected, label);
    assert.ok(!fs.existsSync(path.join(families.state, 'config/unexpected-ipv4-discovery')), label + ': must not discover IPv4');
    if (familyIdentity) assert.equal(current.roots[0].identity, familyIdentity, label);
    familyIdentity = current.roots[0].identity;
    if (priorFamilyWorld && current.timestamp !== priorFamilyWorld.timestamp) {
      assert.equal(current.id, priorFamilyWorld.id);
      world(familyState, ['--verify-update', 'family.previous', 'planet']);
    }
    stop(instance);
    copy(path.join(familyState, 'planet'), path.join(familyState, 'family.previous'));
    priorFamilyWorld = current;
    pass(label + ': runtime endpoints and signing chain verified');
  }
  for (const address of ['::', '::1', '0:0:0:0:0:0:0:1', 'fe80::1', 'febf::1', 'ff02::1', '::ffff:0.0.0.0', '::ffff:127.0.0.1', '::ffff:224.0.0.1', '::ffff:198.51.100.10']) {
    const invalid = start(families, {PLANET_MODE: 'generated', ROOT_ONLY: '1', IP_ADDR4: '', IP_ADDR6: address});
    await rejected(invalid, 'IP_ADDR6 is invalid');
  }
  pass('startup rejects IPv6 unspecified, loopback, link-local and multicast endpoints');
  const noEndpoints = start(families, {PLANET_MODE: 'generated', ROOT_ONLY: '1', IP_ADDR4: '', IP_ADDR6: ''});
  await rejected(noEndpoints, 'No public IPv4 or IPv6 address');
  assert.ok(fs.readFileSync(path.join(familyState, 'planet')).equals(fs.readFileSync(path.join(familyState, 'family.previous'))));
  pass('empty address families reject startup without modifying the signed Planet');

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
  const memberPublic = identity(dir('upgrade-member'));
  run('docker', ['cp', 'tests/in-place-state.cjs', `${g}:/tmp/in-place-state.cjs`]);
  run('docker', ['exec', '-e', 'PLANET_TEST_DISPOSABLE=1',
    '-e', `PLANET_TEST_MEMBER=${memberPublic.split(':')[0]}`, g,
    'node', '/tmp/in-place-state.cjs', 'seed']);
  const upgradeRoots = path.join(base, 'upgrade-roots.json');
  writeJson(upgradeRoots, {roots: [single.roots[0], roots.roots[1]]});
  const upgradeBundle = path.join(base, 'upgrade-bundle');
  // Use the existing World signing chain, not a newly generated Planet identity.
  run('bash', ['planet-bundle.sh', image, path.join(generated.state, 'one'),
    upgradeRoots, upgradeBundle]);
  const upgradedWorld = JSON.parse(fs.readFileSync(path.join(upgradeBundle, 'roots.json'), 'utf8'));
  assert.equal(upgradedWorld.id, single.id);
  assert.ok(upgradedWorld.timestamp > single.timestamp);
  assert.equal(upgradedWorld.roots.length, 2);
  assert.deepEqual(upgradedWorld.roots.map(root => root.identity).sort(),
    [single.roots[0].identity, publicB].sort());
  // Never run two services with the same identity/Controller directory.
  stop(g);
  const preserved = preservedFiles(generated.state, [
    'one/identity.secret', 'one/identity.public', 'one/authtoken.secret',
    'one/current.c25519', 'one/previous.c25519',
    'one/controller.d', 'ui/passwd', 'ui/storage', 'config/session.secret'
  ]);
  copy(path.join(upgradeBundle, 'planet'), path.join(generated.state, 'config/planet'));
  const upgraded = start(generated, {PLANET_MODE: 'external', ROOT_ONLY: '0', HTTP_EXTRA_HOSTS: '127.0.0.2'});
  await ready(upgraded);
  assertPreserved(generated.state, preserved);
  run('docker', ['cp', 'tests/in-place-state.cjs', `${upgraded}:/tmp/in-place-state.cjs`]);
  run('docker', ['exec', '-e', 'PLANET_TEST_DISPOSABLE=1', upgraded,
    'node', '/tmp/in-place-state.cjs', 'verify']);
  assertPreserved(generated.state, preserved);
  const activeWorld = JSON.parse(world(path.join(generated.state, 'one'), ['--inspect', 'planet']).stdout);
  assert.deepEqual(activeWorld, upgradedWorld);
  assert.ok(fs.readFileSync(path.join(generated.state, 'dist/planet')).equals(
    fs.readFileSync(path.join(upgradeBundle, 'planet'))));
  stop(upgraded);
  pass('same-data generated-to-external upgrade preserves identity, Controller/member data, Web state and signing chain');

  copy(path.join(signer, 'world.bin'), path.join(generated.state, 'one/planet'));
  run('docker', ['start', g]);
  await rejected(g);
  pass('legacy single-root/UI bootstrap works; generated mode refuses multi-root state');
} finally {
  for (const name of containers) run('docker', ['rm', '-f', '-v', name], false);
  // Only this process's mkdtemp directory; never a user-provided state path.
  fs.rmSync(base, { recursive: true, force: true });
}
