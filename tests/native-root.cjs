'use strict';
// Execute only the native unit's Controller-data guard against disposable paths.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const source = fs.readFileSync(path.join(__dirname, '../examples/root-only.service'), 'utf8');
const guard = source.match(/^ExecStartPre=\/bin\/sh -ec '(.*)'$/m)?.[1];
assert.ok(guard);
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'native-root-guard-'));
function check(name, setup, allowed) {
  const state = path.join(base, name);
  fs.mkdirSync(state);
  setup(state);
  const script = guard.replaceAll('/srv/zt-root-b/one', state);
  const result = spawnSync('/bin/sh', ['-ec', script], {encoding: 'utf8', timeout: 5000});
  assert.equal(result.status === 0, allowed, name);
}
try {
  check('absent', () => {}, true);
  check('empty-api-directories', state => {
    for (const part of ['network', 'trace']) fs.mkdirSync(path.join(state, 'controller.d', part), {recursive: true});
  }, true);
  check('network-data', state => {
    fs.mkdirSync(path.join(state, 'controller.d/network'), {recursive: true});
    fs.writeFileSync(path.join(state, 'controller.d/network/123.json'), '{}');
  }, false);
  check('file-instead-of-directory', state => fs.writeFileSync(path.join(state, 'controller.d'), '{}'), false);
  check('symlink-root', state => fs.symlinkSync(path.join(base, 'missing'), path.join(state, 'controller.d')), false);
  check('symlink-member', state => {
    fs.mkdirSync(path.join(state, 'controller.d'));
    fs.symlinkSync(path.join(base, 'missing'), path.join(state, 'controller.d/network'));
  }, false);
  assert.ok(source.includes('test ! -e /srv/zt-root-b/one/previous.c25519'));
  assert.ok(source.includes('test ! -e /srv/zt-root-b/one/current.c25519'));
  console.log('PASS: native Root guard permits empty API-created directories and rejects Controller data/symlinks/signing-key paths');
} finally {
  fs.rmSync(base, {recursive: true, force: true});
}
