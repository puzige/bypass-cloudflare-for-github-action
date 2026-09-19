import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { initial } from './fixture.js';

test('actual main and post entrypoints exchange GitHub state without real network', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bypass-test-'));
  try {
    const stateFile = join(dir, 'github-state'); const fixture = join(dir, 'fixture.json');
    writeFileSync(stateFile, ''); writeFileSync(fixture, JSON.stringify(initial()));
    const env = { ...process.env, INPUT_CF_ACCOUNT_ID: 'a'.repeat(32), INPUT_CF_ZONE_ID: 'b'.repeat(32), INPUT_CF_API_TOKEN: 'fake-test-token', INPUT_DISABLE_BOT_FIGHT_MODE: 'true', INPUT_BFM_PROPAGATION_DELAY: '0', INPUT_SKIP_BIC: 'true', INPUT_HOSTNAME: 'admin.example.com', INPUT_PATH_PREFIX: '/api/', GITHUB_STATE: stateFile, FIXTURE_STATE: fixture };
    const execute = file => spawnSync(process.execPath, ['--import', './test/preload.js', file], { env, encoding: 'utf8' });
    const main = execute('src/main.js'); assert.equal(main.status, 0, main.stderr);
    const text = readFileSync(stateFile, 'utf8'); assert.ok(!text.includes('fake-test-token'));
    env.STATE_bypass = text.trim().split('\n').at(-1).slice('bypass='.length);
    assert.equal(JSON.parse(readFileSync(fixture, 'utf8')).bfm.fight_mode, false);
    const post = execute('src/post.js'); assert.equal(post.status, 0, post.stderr);
    const actual = JSON.parse(readFileSync(fixture, 'utf8'));
    assert.equal(actual.bfm.fight_mode, true); assert.equal(actual.items.length, 1); assert.equal(actual.rules.length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('post tolerates main input failure before any state exists', () => {
  const env = { ...process.env, INPUT_CF_ACCOUNT_ID: '', INPUT_CF_ZONE_ID: '', INPUT_CF_API_TOKEN: '', STATE_bypass: '' };
  const main = spawnSync(process.execPath, ['src/main.js'], { env, encoding: 'utf8' }); assert.equal(main.status, 1);
  const post = spawnSync(process.execPath, ['src/post.js'], { env, encoding: 'utf8' }); assert.equal(post.status, 0);
});
