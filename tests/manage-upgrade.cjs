// Exercise only cmd_upgrade with shell stubs. No real Docker calls, .env reads,
// temporary files, or persistent Planet state are involved.
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const source = fs.readFileSync(path.join(__dirname, '..', 'manage.sh'), 'utf8');
const upgrade = source.match(/cmd_upgrade\(\) \{[\s\S]*?\n\}\n(?=\ncmd_status)/)?.[0];
assert.ok(upgrade, 'cmd_upgrade function must be found');

const stubs = String.raw`
set -Eeuo pipefail
SERVICE=myztplanet
LAST_BACKUP=/tmp/mock-backup
UP_CALLS=0
cmd_doctor() { :; }
image_name() { printf 'test:image'; }
config_value() { printf '%s' "$UPGRADE_TEST_MODE"; }
container_name() { printf 'test-container'; }
prepare_image() { :; }
backup_data() { :; }
date() { printf 'test-timestamp'; }
log() { printf 'LOG %s\n' "$*"; }
warn() { printf 'WARN %s\n' "$*"; }
die() { printf 'ERROR %s\n' "$*"; exit 17; }
wait_healthy() { [[ "$UPGRADE_TEST_HEALTHY" == 1 ]] || ((UP_CALLS > 1)); }
docker() {
    if [[ "$1" == inspect ]]; then
        printf 'old:image'
    elif [[ "$1" == tag ]]; then
        printf 'tag %s %s\n' "$2" "$3"
    elif [[ "$1" == compose && "$2" == up ]]; then
        ((UP_CALLS += 1))
        printf 'compose-up %s\n' "$UP_CALLS"
    else
        printf 'unexpected docker call: %s\n' "$*" >&2
        return 99
    fi
}
`;

for (const [mode, healthy] of [['external', false], ['generated', false], ['external', true]]) {
  const result = spawnSync('bash', ['-s'], {
    input: `${stubs}\n${upgrade}\ncmd_upgrade\n`,
    encoding: 'utf8',
    timeout: 5000,
    env: { ...process.env, UPGRADE_TEST_MODE: mode, UPGRADE_TEST_HEALTHY: healthy ? '1' : '0' }
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, healthy ? 0 : 17, result.stderr);
  const rollback = !healthy && mode === 'generated';
  const recreates = (result.stdout.match(/^compose-up /gm) || []).length;
  assert.equal(recreates, rollback ? 2 : 1);
  assert.equal(result.stdout.includes('tag old:image test:image'), rollback);
  assert.equal(result.stdout.includes('automatic rollback is disabled'), !healthy && mode === 'external');
  assert.equal(result.stdout.includes('Upgrade complete'), healthy);
  console.log(`PASS: mocked upgrade mode=${mode}, healthy=${healthy}, container recreations=${recreates}`);
}
