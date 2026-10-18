// เป้าหมาย: Docker ครั้งแรกใช้งานได้โดยไม่มี secret ใน repo — หน้า setup ผูกนอก loopback
// + SETUP_TOKEN_FILE -> สุ่มรหัสครั้งแรก, แสดงใน log ครั้งเดียว, รอบถัดไปใช้รหัสเดิมโดยไม่พิมพ์ซ้ำ
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ALT_HOST, tmpDir, rmDir, freePort, canBind, agentEnv, startAgent, request } = require('./helpers/agent');

const count = (hay, needle) => hay.split(needle).length - 1;

test('first run generates a bootstrap token, logs it once, and enforces it', async (t) => {
  if (!(await canBind(ALT_HOST))) return t.skip(`cannot bind ${ALT_HOST} on this OS`);
  const dir = tmpDir(); t.after(() => rmDir(dir));
  const file = path.join(dir, '.setup-token');
  const port = await freePort(ALT_HOST);
  const env = agentEnv(dir, { SETUP_HOST: ALT_HOST, SETUP_PORT: String(port), SETUP_TOKEN_FILE: file });

  const first = await startAgent({ env, host: ALT_HOST, port });
  t.after(() => first.stop());
  assert.ok(first.ready, `setup should open with a generated token\n${first.output()}`);
  assert.ok(fs.existsSync(file), 'token persisted in the data volume');
  const token = fs.readFileSync(file, 'utf8').trim();
  assert.equal(count(first.output(), token), 1, 'token surfaced exactly once in the logs');
  assert.match(first.output(), new RegExp(`\\?token=${token}`), 'log shows a ready-to-open URL');

  assert.equal((await request(ALT_HOST, port, { path: '/api/status' })).status, 401);
  const page = await request(ALT_HOST, port, { path: `/?token=${token}` });
  assert.equal(page.status, 200);
  const cookie = String(page.headers['set-cookie'] || '');
  assert.match(cookie, /setup_token=/);
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /SameSite=Strict/i);
  const viaCookie = await request(ALT_HOST, port, { path: '/api/status', headers: { cookie: cookie.split(';')[0] } });
  assert.equal(viaCookie.status, 200);
  await first.stop();

  // รีสตาร์ท container: ใช้รหัสเดิม ไม่พิมพ์รหัสลง log ซ้ำ (บอกแค่ว่าอยู่ไฟล์ไหน)
  const second = await startAgent({ env, host: ALT_HOST, port });
  t.after(() => second.stop());
  assert.ok(second.ready, second.output());
  assert.equal(fs.readFileSync(file, 'utf8').trim(), token, 'token is stable across restarts');
  assert.equal(count(second.output(), token), 0, 'token must not be re-logged on later starts');
  assert.ok(second.output().includes(file), 'later starts point to the token file');
  const ok = await request(ALT_HOST, port, { path: '/api/status', headers: { 'x-setup-token': token } });
  assert.equal(ok.status, 200);
});

test('non-loopback host without SETUP_TOKEN or SETUP_TOKEN_FILE still refuses to open', async (t) => {
  if (!(await canBind(ALT_HOST))) return t.skip(`cannot bind ${ALT_HOST} on this OS`);
  const dir = tmpDir(); t.after(() => rmDir(dir));
  const port = await freePort(ALT_HOST);
  const agent = await startAgent({ env: agentEnv(dir, { SETUP_HOST: ALT_HOST, SETUP_PORT: String(port) }), host: ALT_HOST, port });
  t.after(() => agent.stop());
  assert.equal(agent.ready, false, agent.output());
  assert.match(agent.output(), /SETUP_TOKEN/);
});

test('an empty token file fails closed without crashing the process', async (t) => {
  if (!(await canBind(ALT_HOST))) return t.skip(`cannot bind ${ALT_HOST} on this OS`);
  const dir = tmpDir(); t.after(() => rmDir(dir));
  const file = path.join(dir, '.setup-token');
  fs.writeFileSync(file, '');
  const port = await freePort(ALT_HOST);
  const agent = await startAgent({
    env: agentEnv(dir, { SETUP_HOST: ALT_HOST, SETUP_PORT: String(port), SETUP_TOKEN_FILE: file }), host: ALT_HOST, port,
  });
  t.after(() => agent.stop());
  assert.equal(agent.ready, false, agent.output());
  const { code } = await agent.exited;
  assert.equal(code, 0, `refusal must be handled, not an uncaught crash\n${agent.output()}`);
  assert.ok(agent.output().includes(file));
});
