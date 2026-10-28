import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, mkdirSync, writeFileSync, chmodSync, statSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const hook = resolve('scripts/claude/codex-auth.sh');
const dummy = JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'DUMMY_ACCESS_NOT_REAL', refresh_token: 'DUMMY_REFRESH_NOT_REAL' } });
function check(run) {
  const root = mkdtempSync(join(tmpdir(), 'worker-auth-test-'));
  const home = join(root, 'worker');
  const execute = value => {
    const env = { ...process.env, CODEX_HOME: home };
    delete env.CODEX_AUTH_JSON;
    if (value !== undefined) env.CODEX_AUTH_JSON = value;
    const result = spawnSync('bash', [hook], { env, encoding: 'utf8' });
    assert.ok(!(result.stdout + result.stderr).includes('DUMMY_'));
    return result;
  };
  try { run({ root, home, execute }); } finally { rmSync(root, { recursive: true, force: true }); }
}
test('missing optional secret does nothing', () => check(({ home, execute }) => {
  assert.equal(execute().status, 0); assert.equal(existsSync(home), false);
}));
test('subscription bootstrap is private and contains valid JSON', () => check(({ home, execute }) => {
  assert.equal(execute(dummy).status, 0);
  assert.deepEqual(JSON.parse(readFileSync(join(home, 'auth.json'), 'utf8')), JSON.parse(dummy));
  assert.equal(statSync(home).mode & 0o777, 0o700);
  assert.equal(statSync(join(home, 'auth.json')).mode & 0o777, 0o600);
}));
test('existing refreshed login wins and permissions tighten', () => check(({ home, execute }) => {
  mkdirSync(home, { mode: 0o755 }); writeFileSync(join(home, 'auth.json'), 'newer-login');
  chmodSync(join(home, 'auth.json'), 0o644);
  assert.equal(execute(dummy).status, 0);
  assert.equal(readFileSync(join(home, 'auth.json'), 'utf8'), 'newer-login');
  assert.equal(statSync(join(home, 'auth.json')).mode & 0o777, 0o600);
}));
test('malformed JSON fails without creating a credential file', () => check(({ home, execute }) => {
  assert.notEqual(execute('{DUMMY_BROKEN').status, 0);
  assert.equal(existsSync(join(home, 'auth.json')), false);
}));
test('API-key authentication is rejected', () => check(({ home, execute }) => {
  assert.notEqual(execute(JSON.stringify({ OPENAI_API_KEY: 'DUMMY_KEY' })).status, 0);
  assert.equal(existsSync(join(home, 'auth.json')), false);
}));
test('symlink target is rejected without changing its destination', () => check(({ root, home, execute }) => {
  mkdirSync(home); const victim = join(root, 'unrelated'); writeFileSync(victim, 'keep');
  symlinkSync(victim, join(home, 'auth.json'));
  assert.notEqual(execute(dummy).status, 0); assert.equal(readFileSync(victim, 'utf8'), 'keep');
}));
test('repeated sessions preserve cache and leave no temporary credentials', () => check(({ home, execute }) => {
  assert.equal(execute(dummy).status, 0); assert.equal(execute(dummy).status, 0);
  assert.equal(readFileSync(join(home, 'auth.json'), 'utf8').includes('DUMMY_ACCESS'), true);
}));
