// เป้าหมาย: `node src/index.js --setup` (ไม่ผ่าน npm start/loadConfig) ต้องโหลด .env ตาม AGENT_ENV
// ก่อนอ่าน SETUP_HOST / SETUP_PORT / SETUP_TOKEN — ไม่งั้นค่าที่ตั้งไว้ใน .env ถูกเพิกเฉยเงียบ ๆ
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { ALT_HOST, tmpDir, rmDir, freePort, canBind, agentEnv, startAgent, request } = require('./helpers/agent');

test('--setup reads SETUP_HOST/SETUP_PORT/SETUP_TOKEN from the AGENT_ENV file', async (t) => {
  if (!(await canBind(ALT_HOST))) return t.skip(`cannot bind ${ALT_HOST} on this OS`);
  const dir = tmpDir();
  t.after(() => rmDir(dir));
  const port = await freePort(ALT_HOST);
  const token = 'dotenv-' + crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(path.join(dir, '.env'), `SETUP_HOST=${ALT_HOST}\nSETUP_PORT=${port}\nSETUP_TOKEN=${token}\n`);

  // env ของโปรเซสไม่มี SETUP_* เลย — ค่าทั้งหมดต้องมาจากไฟล์ .env
  const agent = await startAgent({ env: agentEnv(dir), host: ALT_HOST, port });
  t.after(() => agent.stop());
  assert.ok(agent.ready, `setup should listen on ${ALT_HOST}:${port} taken from .env\n--- output ---\n${agent.output()}`);

  const denied = await request(ALT_HOST, port, { path: '/api/status' });
  assert.equal(denied.status, 401, 'SETUP_TOKEN from .env must be enforced');

  const ok = await request(ALT_HOST, port, { path: '/api/status', headers: { 'x-setup-token': token } });
  assert.equal(ok.status, 200);
  assert.equal(ok.json && ok.json.ok, true);
});
