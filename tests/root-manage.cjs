// Local Root onboarding regression. All state is disposable and no service is
// started; only the already-present test image is used.
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');

const image = process.argv[2];
if (!image) throw new Error('Usage: node tests/root-manage.cjs IMAGE');
if (process.getuid && process.getuid() !== 0) throw new Error('Run with sudo; Docker creates root-owned disposable signing state.');
const root = path.resolve(__dirname, '..');
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'root-manage-regression-'));

function run(command, args, ok = true) {
  const result = spawnSync(command, args, {encoding: 'utf8', timeout: 90000});
  if (ok && result.status !== 0) {
    // Never print tool output, which could contain secret material on failures.
    throw new Error(`${command} failed: status=${result.status}, error=${result.error || ''}`);
  }
  return result;
}
function shell(args, ok = true) {
  return run('bash', [path.join(root, 'root-manage.sh'), ...args], ok);
}
function dir(name) {
  const value = path.join(base, name);
  fs.mkdirSync(value, {recursive: true, mode: 0o700});
  return value;
}
function sha(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}
function copy(source, target) { fs.copyFileSync(source, target); }
function identity(state) {
  run('docker', ['run', '--rm', '--pull', 'never', '--network', 'none',
    '--entrypoint', 'zerotier-idtool', '-v', `${state}:/work`, image,
    'generate', '/work/identity.secret', '/work/identity.public']);
  return fs.readFileSync(path.join(state, 'identity.public'), 'utf8').trim();
}
function world(state) {
  run('docker', ['run', '--rm', '--pull', 'never', '--network', 'none',
    '--entrypoint', '/usr/local/libexec/mkworld', '-v', `${state}:/work`,
    '-w', '/work', image]);
}
function files(relative) { return fs.readdirSync(relative).sort(); }
function fails(args, pattern) {
  const result = shell(args, false);
  assert.notEqual(result.status, 0, 'expected CLI rejection');
  if (pattern) assert.ok(pattern.test(result.stderr + result.stdout), 'unexpected rejection reason');
  return result;
}

try {
  const prepared = dir('prepared');
  const prepareArgs = ['prepare', '--image', image, '--data-dir', prepared, '--endpoint', '198.51.100.11/9994'];
  shell(prepareArgs);
  assert.deepEqual(files(prepared), ['one', 'root-request.json']);
  assert.deepEqual(files(path.join(prepared, 'one')), ['identity.public', 'identity.secret']);
  const requestPath = path.join(prepared, 'root-request.json');
  const requestBefore = fs.readFileSync(requestPath);
  const identityBefore = fs.readFileSync(path.join(prepared, 'one/identity.secret'));
  const publicIdentity = JSON.parse(requestBefore).identity;
  assert.match(publicIdentity, /^[0-9a-f]{10}:0:[0-9a-f]{128}$/);
  assert.deepEqual(Object.keys(JSON.parse(requestBefore)).sort(), ['identity', 'schemaVersion', 'stableEndpoints']);
  shell(prepareArgs);
  assert.ok(fs.readFileSync(requestPath).equals(requestBefore), 'request changed on repeat');
  assert.ok(fs.readFileSync(path.join(prepared, 'one/identity.secret')).equals(identityBefore), 'identity changed on repeat');
  fails([...prepareArgs.slice(0, -1), '198.51.100.12/9994'], /differs|overwrite/);
  assert.ok(fs.readFileSync(requestPath).equals(requestBefore));
  console.log('PASS: prepare creates an isolated identity/public request and is idempotent without overwriting');

  for (const [name, endpoint] of [
    ['wildcard', '0.0.0.0/9994'], ['multicast', '224.0.0.1/9994'],
    ['loopback', '127.0.0.1/9994'], ['ipv6-multicast', 'ff02::1/9994'],
    ['mapped-wildcard', '::ffff:0.0.0.0/9994'], ['bad-port', '198.51.100.12/0'],
    ['bad-syntax', '198.51.100.12/9994/extra'], ['zone', 'fe80::1%eth0/9994']
  ]) {
    fails(['prepare', '--image', image, '--data-dir', dir(`bad-${name}`), '--endpoint', endpoint], /Invalid endpoint/);
  }
  for (const forbidden of ['controller.d', 'networks.d', 'planet', 'previous.c25519', 'authtoken.secret']) {
    const state = dir(`forbidden-${forbidden}`);
    const one = path.join(state, 'one'); fs.mkdirSync(one);
    fs.writeFileSync(path.join(one, forbidden), 'protected');
    fails(['prepare', '--image', image, '--data-dir', state, '--endpoint', '198.51.100.12/9994'], /existing ZeroTier state/);
    assert.equal(fs.readFileSync(path.join(one, forbidden), 'utf8'), 'protected');
  }
  const symlink = path.join(base, 'symlink'); fs.symlinkSync(prepared, symlink);
  fails(['prepare', '--image', image, '--data-dir', symlink, '--endpoint', '198.51.100.12/9994'], /Symlink/);
  fails(['prepare', '--image', image, '--data-dir', '/var/lib/zerotier-one', '--endpoint', '198.51.100.12/9994'], /Unsafe/);
  console.log('PASS: disallowed endpoints, client/Controller/signer state and unsafe/symlink paths rejected');

  const signer = dir('signer');
  const rootA = identity(signer);
  const roots = {roots: [{identity: rootA, stableEndpoints: ['198.51.100.10/9994']}]};
  fs.writeFileSync(path.join(signer, 'moon.json'), JSON.stringify(roots), {mode: 0o600});
  world(signer);
  copy(path.join(signer, 'world.bin'), path.join(signer, 'planet'));
  const signerBefore = ['planet', 'previous.c25519', 'current.c25519'].map(name => [name, sha(path.join(signer, name))]);
  const baseSha = sha(path.join(signer, 'planet'));
  const output = path.join(base, 'candidate');
  const addArgs = ['add', '--image', image, '--signer', signer, '--request', requestPath];
  const dry = path.join(base, 'dry');
  shell([...addArgs, '--output', dry, '--base-sha256', baseSha, '--dry-run']);
  assert.ok(!fs.existsSync(dry));
  shell([...addArgs, '--output', output, '--base-sha256', baseSha]);
  assert.deepEqual(files(output), ['SHA256SUMS', 'planet', 'roots.json']);
  const candidate = JSON.parse(fs.readFileSync(path.join(output, 'roots.json'), 'utf8'));
  assert.equal(candidate.roots.length, 2);
  assert.deepEqual(candidate.roots.map(root => root.identity).sort(), [rootA, publicIdentity].sort());
  assert.deepEqual(candidate.roots.find(root => root.identity === rootA), roots.roots[0]);
  for (const name of files(output)) {
    const content = fs.readFileSync(path.join(output, name));
    assert.ok(!content.includes(identityBefore), 'Root private identity leaked');
    assert.ok(!content.includes(fs.readFileSync(path.join(signer, 'current.c25519'))), 'World key leaked');
  }
  for (const [name, value] of signerBefore) assert.equal(sha(path.join(signer, name)), value, `signer changed: ${name}`);
  console.log('PASS: add preserves existing Roots, signs a public-only candidate, dry-run writes no bundle, signer unchanged');

  const duplicatePath = path.join(base, 'duplicate-request.json');
  fs.writeFileSync(duplicatePath, JSON.stringify({schemaVersion: 1, ...roots.roots[0]}));
  fails(['add', '--image', image, '--signer', signer, '--request', duplicatePath,
    '--output', path.join(base, 'duplicate')], /already present/);
  fails([...addArgs, '--output', path.join(base, 'conflict'), '--base-sha256', '0'.repeat(64)], /Base SHA-256 conflict/);
  fails([...addArgs, '--output', output], /Output must be a new directory/);
  const malformed = path.join(base, 'malformed-request.json');
  fs.writeFileSync(malformed, JSON.stringify({...JSON.parse(requestBefore), private: 'must-not-be-accepted'}));
  fails(['add', '--image', image, '--signer', signer, '--request', malformed,
    '--output', path.join(base, 'malformed')], /schema|extra/);
  const privateRequest = path.join(base, 'private-request.json');
  fs.writeFileSync(privateRequest, JSON.stringify({...JSON.parse(requestBefore), identity: identityBefore.toString().trim()}));
  const result = fails(['add', '--image', image, '--signer', signer, '--request', privateRequest,
    '--output', path.join(base, 'private')], /schema|extra/);
  assert.ok(!(result.stdout + result.stderr).includes(identityBefore.toString().trim()), 'error leaked identity');
  console.log('PASS: duplicates, stale base CAS, existing output and private/extra request fields safely rejected');
  assert.equal(files(base).filter(name => name.startsWith('.root-manage.')).length, 0, 'temporary staging leaked');
} finally {
  fs.rmSync(base, {recursive: true, force: true});
}
