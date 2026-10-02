import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(repo, 'scripts/pi-safe-upgrade.sh');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-upgrade-launcher-'));
const agent = path.join(root, 'agent');
const inbox = path.join(root, 'inbox');
const cwd = path.join(root, 'workspace with spaces');
const session = path.join(root, "session's file.jsonl");
const sid = 'session-upgrade-test';
const manifest = path.join(agent, 'agent-upgrades', `${sid}.json`);
fs.mkdirSync(path.dirname(manifest), { recursive: true });
fs.mkdirSync(cwd);
fs.writeFileSync(session, JSON.stringify({ type: 'session', version: 3, id: sid, cwd }) + '\n');
const prepared = { version: 1, ready: true, parentSessionId: sid, parentSessionPath: session, parentPid: 2147483647, cwd, preparedAt: new Date().toISOString(), taskIds: ['task-test-1234'] };
const env = { ...process.env, PI_CODING_AGENT_DIR: agent, PI_AGENT_NOTIFY_DIR: inbox, PI_SAFE_UPGRADE_ROOT: path.join(root, 'versions') };
function run(args = []) {
  return spawnSync('bash', [script, '--version', '0.99.0', '--session', session, '--dry-run', ...args], { env, encoding: 'utf8' });
}
function save(overrides = {}) { fs.writeFileSync(manifest, JSON.stringify({ ...prepared, ...overrides })); }
try {
  let result = run();
  assert.notEqual(result.status, 0); assert.match(result.stderr, /no valid prepare manifest/);
  save({ ready: false }); result = run();
  assert.notEqual(result.status, 0); assert.match(result.stderr, /handoff is not ready/);
  save({ parentPid: null }); result = run();
  assert.notEqual(result.status, 0); assert.match(result.stderr, /valid original main PID/);
  save({ parentPid: process.pid }); result = run();
  assert.notEqual(result.status, 0); assert.match(result.stderr, /still alive/);
  save({ parentSessionPath: path.join(root, 'wrong.jsonl') }); result = run();
  assert.notEqual(result.status, 0); assert.match(result.stderr, /another session file/);
  save(); result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Prepared session:/);
  assert.match(result.stdout, /--ignore-scripts/);
  assert.match(result.stdout, /--session/);
  assert.equal(fs.existsSync(env.PI_SAFE_UPGRADE_ROOT), false, 'dry-run must not create/install a version');
  result = run(['--version', 'latest']);
  assert.notEqual(result.status, 0); assert.match(result.stderr, /exact Pi version/);
  const runtime = path.join(agent, 'runtime', `${process.pid}.jsonl`);
  fs.mkdirSync(path.dirname(runtime), { recursive: true });
  fs.writeFileSync(runtime, JSON.stringify({ pid: process.pid, sessionPath: session }) + '\n');
  result = run(); assert.notEqual(result.status, 0); assert.match(result.stderr, /already opened/);
  fs.unlinkSync(runtime);
  const receiver = path.join(inbox, '.main-sessions', `${sid}.json`);
  fs.mkdirSync(path.dirname(receiver), { recursive: true });
  fs.writeFileSync(receiver, JSON.stringify({ pid: process.pid, sessionId: sid }));
  result = run(); assert.notEqual(result.status, 0); assert.match(result.stderr, /live notification receiver/);
  fs.unlinkSync(receiver);
  const lateId = 'task-late-abcd';
  const lateIdentity = path.join(inbox, lateId, '.receiver-identity.json');
  fs.mkdirSync(path.dirname(lateIdentity), { recursive: true });
  fs.writeFileSync(lateIdentity, JSON.stringify({ taskId: lateId, pid: process.pid }));
  const workerRegistry = path.join(inbox, '.active-workers.json');
  fs.writeFileSync(workerRegistry, JSON.stringify({ workers: { [lateId]: { ownerPid: prepared.parentPid } } }));
  result = run(); assert.notEqual(result.status, 0); assert.match(result.stderr, /dispatched after preparation/);
  fs.unlinkSync(workerRegistry);
  save({ cwd: root }); result = run(); assert.notEqual(result.status, 0); assert.match(result.stderr, /working directory mismatch/);
  console.log('OK: upgrade launcher requires prepared exact session, rejects live mains, and dry-run is read-only');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
