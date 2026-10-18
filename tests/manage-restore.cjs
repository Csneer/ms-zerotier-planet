// Temporary filesystem and Docker stubs; no daemon or live state is touched.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const source = fs.readFileSync(path.join(__dirname, '..', 'manage.sh'), 'utf8');
const functions = source.slice(source.indexOf('SERVICE='), source.indexOf('command_name=${1:-help}'));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'planet-restore-test-'));
const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value); };
const labels = ['dist', 'one', 'config', 'ztncui-state'];
function sums(dir) {
  const files = fs.readdirSync(dir, { recursive: true }).filter(name => name !== 'SHA256SUMS' && fs.lstatSync(path.join(dir, name)).isFile());
  write(path.join(dir, 'SHA256SUMS'), files.sort().map(name => `${crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, name))).digest('hex')}  ./${name}`).join('\n') + '\n');
}
function fixture(name, mode = 'generated', rootOnly = '0', controllerOnly = '0') {
  const dir = path.join(root, name);
  for (const label of labels) fs.mkdirSync(path.join(dir, label), { recursive: true });
  const files = {
    '.env': `PLANET_MODE=${mode}\nROOT_ONLY=${rootOnly}\nCONTROLLER_ONLY=${controllerOnly}\n`,
    'docker-compose.yml': 'services: {}\n',
    'manifest.env': 'consistency=offline\nrepository_revision=test\nimage=test:image\n',
    'one/identity.secret': 'secret', 'one/identity.public': 'public', 'one/planet': 'planet', 'dist/planet': 'planet',
    ...(mode === 'external' ? { 'config/planet': 'planet' } : { 'one/current.c25519': 'key', 'one/previous.c25519': 'key', 'one/moon.json': '{}' }),
    ...(rootOnly === '0' ? { 'ztncui-state/passwd': 'hash', 'config/session.secret': 'session' } : {})
  };
  for (const [name, value] of Object.entries(files)) write(path.join(dir, name), value);
  sums(dir);
  return dir;
}
function shell(command, env = {}) {
  const result = spawnSync('bash', ['-s'], { input: `set -Eeuo pipefail\nROOT_DIR="$TEST_ROOT"\n${functions}\n${command}\n`, encoding: 'utf8', env: { ...process.env, TEST_ROOT: root, WAS_RUNNING: '0', FAIL_DOWN: '0', FAIL_ROLLBACK_MV: '0', FAIL_ROLLBACK_RM: '0', ...env }, timeout: 10000 });
  assert.ifError(result.error);
  return result;
}
function validate(dir, error) {
  const result = shell('validate_restore_backup "$BACKUP"', { BACKUP: dir });
  assert.equal(result.status, error ? 1 : 0, result.stderr);
  if (error) assert.ok(result.stderr.includes(error), result.stderr);
}
try {
  for (const [mode, rootOnly, controllerOnly] of [['generated', '0', '0'], ['generated', '1', '0'], ['external', '1', '0'], ['external', '0', '0']]) {
    validate(fixture(`${mode}-${rootOnly}-${controllerOnly}`, mode, rootOnly, controllerOnly));
  }
  const quoted = fixture('quoted-roles', 'external', '1', '0');
  write(path.join(quoted, '.env'), 'PLANET_MODE="external" # effective role\nROOT_ONLY=\'1\'\nCONTROLLER_ONLY=0\n');
  sums(quoted);
  validate(quoted);
  const cases = [
    ['unlisted', d => write(path.join(d, 'extra'), 'unexpected'), 'unlisted'],
    ['absolute', d => fs.appendFileSync(path.join(d, 'SHA256SUMS'), `${'0'.repeat(64)}  /etc/passwd\n`), 'unsafe checksum path'],
    ['traversal', d => fs.appendFileSync(path.join(d, 'SHA256SUMS'), `${'0'.repeat(64)}  ../outside\n`), 'unsafe checksum path'],
    ['duplicate', d => fs.appendFileSync(path.join(d, 'SHA256SUMS'), fs.readFileSync(path.join(d, 'SHA256SUMS'), 'utf8').split('\n')[0] + '\n'), 'duplicate'],
    ['symlink', d => fs.symlinkSync('/etc/passwd', path.join(d, 'one/link')), 'symlink'],
    ['fifo', d => assert.equal(spawnSync('mkfifo', [path.join(d, 'one/fifo')]).status, 0), 'special file'],
    ['missing-secret', d => { fs.unlinkSync(path.join(d, 'one/identity.secret')); sums(d); }, 'missing required state'],
    ['missing-key', d => { fs.unlinkSync(path.join(d, 'one/current.c25519')); sums(d); }, 'missing required state'],
    ['online', d => { write(path.join(d, 'manifest.env'), 'consistency=online\nrepository_revision=test\nimage=test\n'); sums(d); }, 'offline backup'],
    ['standby', d => { write(path.join(d, 'config/controller-standby.json'), '{}'); sums(d); }, 'controller stage'],
    ['checksum', d => write(path.join(d, 'one/identity.secret'), 'tampered'), 'checksum mismatch']
  ];
  for (const [name, edit, error] of cases) { const dir = fixture(name); edit(dir); validate(dir, error); }
  const empty = path.join(root, 'empty');
  for (const label of labels) fs.mkdirSync(path.join(empty, label), { recursive: true });
  write(path.join(empty, 'sentinel'), 'not a backup'); sums(empty); validate(empty, 'missing required state');
  const externalMissing = fixture('missing-external-planet', 'external', '1');
  fs.unlinkSync(path.join(externalMissing, 'config/planet')); sums(externalMissing);
  validate(externalMissing, 'missing required state: config/planet');

  // A checksum producer can leave a syntactically valid partial manifest and
  // still fail.  The backup must be rejected and removed, while a service
  // stopped for the offline snapshot must be started again.  The wrapper
  // below executes the real sha256sum for one input, then returns non-zero;
  // this exercises the command's exit status rather than matching source text.
  const partialRoot = path.join(root, 'partial-manifest');
  const partialLive = path.join(partialRoot, 'live');
  for (const label of labels) fs.mkdirSync(path.join(partialLive, label), { recursive: true });
  for (const [name, value] of Object.entries({
    '.env': 'PLANET_MODE=generated\nROOT_ONLY=0\nCONTROLLER_ONLY=0\n',
    'docker-compose.yml': 'services: {}\n',
    'one/identity.secret': 'secret', 'one/identity.public': 'public',
    'one/planet': 'planet', 'dist/planet': 'planet',
    'one/current.c25519': 'key', 'one/previous.c25519': 'key',
    'one/moon.json': '{}', 'ztncui-state/passwd': 'hash',
    'config/session.secret': 'session'
  })) write(path.join(partialLive, name), value);
  write(path.join(partialRoot, '.env'), 'PLANET_MODE=generated\nROOT_ONLY=0\nCONTROLLER_ONLY=0\n');
  write(path.join(partialRoot, 'docker-compose.yml'), 'services: {}\n');
  const checksumWrapper = path.join(partialRoot, 'bin', 'sha256sum');
  write(checksumWrapper, '#!/bin/sh\nif [ "$1" = -c ]; then exec /usr/bin/sha256sum "$@"; fi\n/usr/bin/sha256sum "$1"\nexit 1\n');
  fs.chmodSync(checksumWrapper, 0o755);
  const partialStubs = String.raw`
require_command() { :; }
load_config() { :; }
container_name() { printf partial-test; }
container_running() { return 0; }
container_exists() { return 1; }
wait_healthy() { :; }
config_value() { case "$1" in *PLANET_MODE*) printf generated;; *ROOT_ONLY*) printf 0;; *CONTROLLER_ONLY*) printf 0;; esac; }
image_name() { printf test:image; }
mount_source() {
    case "$1" in
        /app/dist) printf '%s/dist' "$LIVE" ;;
        /var/lib/zerotier-one) printf '%s/one' "$LIVE" ;;
        /app/config) printf '%s/config' "$LIVE" ;;
        /var/lib/ztncui) printf '%s/ztncui-state' "$LIVE" ;;
    esac
}
backup_root() { printf '%s/snapshots' "$LIVE"; }
docker() { printf '%s\n' "$*" >> "$LIVE/docker.calls"; return 0; }
sha256sum() {
    if [[ "$1" == -c ]]; then command sha256sum "$@"; return; fi
    command sha256sum "$1"
    return 1
}
cd "$LIVE/.."
backup_data 0 1
`;
  const partialResult = shell(partialStubs, { LIVE: partialLive, WAS_RUNNING: '1', PATH: `${path.join(partialRoot, 'bin')}:${process.env.PATH}` });
  assert.notEqual(partialResult.status, 0, 'partial checksum generation must fail the backup');
  assert.ok(!partialResult.stdout.includes('Backup verified:'), partialResult.stdout);
  assert.match(partialResult.stderr, /failed to verify backup manifest/);
  const partialSnapshots = path.join(partialLive, 'snapshots');
  assert.ok(fs.existsSync(partialSnapshots), 'backup root should remain available');
  assert.deepEqual(fs.readdirSync(partialSnapshots), [], 'incomplete backup must be removed');
  const partialCalls = fs.readFileSync(path.join(partialLive, 'docker.calls'), 'utf8').trim().split('\n');
  assert.ok(partialCalls.includes('compose stop -t 20 myztplanet'), 'running service must be stopped for offline backup');
  assert.ok(partialCalls.includes('compose start myztplanet'), 'running service must be restored after backup failure');

  const wrongToolRoot = path.join(root, 'wrong-tool-target');
  const wrongToolLive = path.join(wrongToolRoot, 'live');
  fs.cpSync(partialLive, wrongToolLive, { recursive: true, dereference: false });
  fs.symlinkSync('/usr/sbin/not-zerotier-one', path.join(wrongToolLive, 'one/zerotier-one'));
  write(path.join(wrongToolRoot, '.env'), 'PLANET_MODE=generated\nROOT_ONLY=0\nCONTROLLER_ONLY=0\n');
  write(path.join(wrongToolRoot, 'docker-compose.yml'), 'services: {}\n');
  const wrongToolResult = shell(partialStubs, { LIVE: wrongToolLive, WAS_RUNNING: '0' });
  assert.notEqual(wrongToolResult.status, 0, 'wrong ZeroTier tool target must fail the backup');
  assert.match(wrongToolResult.stderr, /unsupported symbolic link in backup source/);
  assert.deepEqual(fs.readdirSync(path.join(wrongToolLive, 'snapshots')), [], 'wrong tool target must not leave a backup');

  const backup = fixture('restore-source', 'external', '1');
  const stubs = String.raw`
cd "$TEST_ROOT"
require_command() { :; }
load_config() { :; }
config_value() { case "$1" in *PLANET_MODE*) printf external;; *ROOT_ONLY*) printf 1;; *CONTROLLER_ONLY*) printf 0;; esac; }
container_running() { [[ "$WAS_RUNNING" == 1 ]]; }
container_exists() { return 1; }
container_name() { printf test-container; }
image_name() { printf test:image; }
mount_source() {
    case "$1" in
        /app/dist) printf '%s/dist' "$LIVE" ;;
        /app/config) printf '%s/config' "$LIVE" ;;
        /var/lib/zerotier-one) printf '%s/one' "$LIVE" ;;
        /var/lib/ztncui) printf '%s/ztncui-state' "$LIVE" ;;
    esac
}
backup_root() { printf '%s/snapshots' "$LIVE"; }
docker() {
    printf '%s\n' "$*" >> "$LIVE/docker.calls"
    if [[ "$FAIL_DOWN" == 1 && "$1" == compose && "$2" == down ]]; then
        printf down > "$LIVE/injected-fault"
        return 1
    fi
    return 0
}
wait_healthy() { [[ "$HEALTHY" == 1 ]]; }
cp() {
    if [[ "$FAIL_STAGE" == 1 && "$*" == *"restore-source/one/."* ]]; then return 1; fi
    command cp "$@"
}
mv() {
    if [[ "$FAIL_SWAP" == 1 && "$1" == -- && "$2" == *".one.restore."* ]]; then return 1; fi
    if [[ "$FAIL_ROLLBACK_MV" == 1 && "$1" == -- && "$2" == "$LIVE/dist.pre-restore-"* ]]; then
        printf rollback-mv > "$LIVE/injected-fault"
        return 1
    fi
    command mv "$@"
}
rm() {
    if [[ "$FAIL_ROLLBACK_RM" == 1 && "$*" == "-rf -- $LIVE/dist" ]]; then
        printf rollback-rm > "$LIVE/injected-fault"
        return 1
    fi
    command rm "$@"
}
cmd_doctor() { die 'restore must not require healthy current data'; }
cmd_restore "$BACKUP" --yes
`;
  write(path.join(root, '.env'), 'PLANET_MODE=external\nROOT_ONLY=1\n');
  write(path.join(root, 'docker-compose.yml'), 'services: {}\n');
  for (const [healthy, failStage, failSwap] of [['1', '0', '0'], ['0', '0', '0'], ['1', '1', '0'], ['1', '0', '1']]) {
    const success = healthy === '1' && failStage === '0' && failSwap === '0';
    const live = path.join(root, `live-${healthy}-${failStage}-${failSwap}`);
    write(path.join(live, 'config/preserved'), 'current remaining data');
    const result = shell(stubs, { LIVE: live, BACKUP: backup, HEALTHY: healthy, FAIL_STAGE: failStage, FAIL_SWAP: failSwap });
    assert.equal(result.status, success ? 0 : 1, result.stderr);
    const snapshots = fs.readdirSync(path.join(live, 'snapshots'));
    assert.equal(snapshots.length, 1);
    const snapshot = path.join(live, 'snapshots', snapshots[0]);
    assert.equal(fs.readFileSync(path.join(snapshot, 'config/preserved'), 'utf8'), 'current remaining data');
    assert.match(fs.readFileSync(path.join(snapshot, 'manifest.env'), 'utf8'), /consistency=recovery/);
    assert.match(fs.readFileSync(path.join(snapshot, 'manifest.env'), 'utf8'), /missing_dataset=one/);
    if (success) assert.equal(fs.readFileSync(path.join(live, 'one/identity.secret'), 'utf8'), 'secret');
    else {
      assert.equal(fs.readFileSync(path.join(live, 'config/preserved'), 'utf8'), 'current remaining data');
      for (const label of ['one', 'dist', 'ztncui-state']) assert.equal(fs.existsSync(path.join(live, label)), false, label);
      const calls = fs.existsSync(path.join(live, 'docker.calls')) ? fs.readFileSync(path.join(live, 'docker.calls'), 'utf8') : '';
      assert.equal(calls.split('\n').filter(line => line.startsWith('compose up')).length, (failStage === '1' || failSwap === '1') ? 0 : 1, 'stopped damaged instance must not restart during rollback');
    }
  }
  // Once a swap begins, unexpected cleanup/rollback failures must not use the
  // EXIT trap to restart a container against mixed old/new datasets.
  for (const fault of ['rollback-rm', 'rollback-mv', 'down', 'health-rollback-mv']) {
    const live = path.join(root, `running-fault-${fault}`);
    for (const label of labels) write(path.join(live, label, 'old-state'), `old ${label}`);
    const result = shell(stubs, {
      LIVE: live, BACKUP: backup, WAS_RUNNING: '1', HEALTHY: ['down', 'health-rollback-mv'].includes(fault) ? '0' : '1',
      FAIL_STAGE: '0', FAIL_SWAP: ['down', 'health-rollback-mv'].includes(fault) ? '0' : '1',
      FAIL_ROLLBACK_RM: fault === 'rollback-rm' ? '1' : '0',
      FAIL_ROLLBACK_MV: fault.includes('rollback-mv') ? '1' : '0', FAIL_DOWN: fault === 'down' ? '1' : '0'
    });
    assert.notEqual(result.status, 0, `${fault} must fail`);
    assert.ok(fs.existsSync(path.join(live, 'injected-fault')) && fs.readFileSync(path.join(live, 'injected-fault'), 'utf8') === (fault === 'health-rollback-mv' ? 'rollback-mv' : fault),
      `requested fault must be reached; calls=${fs.existsSync(path.join(live, 'docker.calls')) ? fs.readFileSync(path.join(live, 'docker.calls'), 'utf8') : ''}; stdout=${result.stdout}; stderr=${result.stderr}`);
    const calls = fs.readFileSync(path.join(live, 'docker.calls'), 'utf8').trim().split('\n');
    assert.ok(calls.some(call => call.startsWith('compose stop')), 'the original running service must be stopped');
    assert.equal(calls.filter(call => call.startsWith('compose start')).length, 0, 'never restart mixed data via EXIT cleanup');
    assert.equal(calls.filter(call => call.startsWith('compose up')).length, ['down', 'health-rollback-mv'].includes(fault) ? 1 : 0, 'no rollback startup before all datasets are restored');
    const snapshots = fs.readdirSync(path.join(live, 'snapshots'));
    assert.equal(snapshots.length, 1);
    const snapshot = path.join(live, 'snapshots', snapshots[0]);
    for (const label of labels) assert.equal(fs.readFileSync(path.join(snapshot, label, 'old-state'), 'utf8'), `old ${label}`);
    assert.ok(result.stderr.includes(snapshot), 'diagnostic must identify the recovery snapshot');
    assert.ok(result.stderr.includes(live), 'diagnostic must identify affected data paths');
    const originals = fs.readdirSync(live).filter(name => name.includes('.pre-restore-'));
    assert.ok(originals.length > 0, 'old state must remain available for manual recovery');
    assert.ok(result.stderr.includes('.pre-restore-'), 'diagnostic must identify preserved original paths');
  }
  console.log('PASS: running-instance rollback rm/mv and Docker stop failures never auto-start mixed state');
  console.log('PASS: restore validation (4 roles, 13 invalid backups), damaged-instance recovery and staging/swap/health-failure rollback');
} finally { fs.rmSync(root, { recursive: true, force: true }); }
