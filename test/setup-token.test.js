// เป้าหมาย: รหัสเข้าหน้า setup สำหรับ Docker ครั้งแรก — ไม่ hard-code, สุ่มครั้งเดียว,
// เก็บถาวรใน volume (SETUP_TOKEN_FILE) แบบสิทธิ์ 0600, ใช้ซ้ำรอบถัดไป, ไฟล์เสีย = ไม่เปิด (fail closed)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tmpDir, rmDir } = require('./helpers/agent');
const { resolveSetupToken } = require('../src/setup-token');

test('SETUP_TOKEN from env wins and no token file is created', (t) => {
  const dir = tmpDir(); t.after(() => rmDir(dir));
  const file = path.join(dir, '.setup-token');
  const r = resolveSetupToken({ SETUP_TOKEN: '  from-env  ', SETUP_TOKEN_FILE: file });
  assert.equal(r.token, 'from-env');
  assert.equal(r.generated, false);
  assert.equal(fs.existsSync(file), false);
});

test('no SETUP_TOKEN and no SETUP_TOKEN_FILE -> no token (caller decides to refuse)', () => {
  const r = resolveSetupToken({});
  assert.equal(r.token, '');
  assert.equal(r.generated, false);
});

test('generates a strong random token into SETUP_TOKEN_FILE with 0600 permissions', (t) => {
  const dir = tmpDir(); t.after(() => rmDir(dir));
  const file = path.join(dir, '.setup-token');
  const r = resolveSetupToken({ SETUP_TOKEN_FILE: file });
  assert.equal(r.generated, true);
  assert.equal(r.file, file);
  assert.match(r.token, /^[A-Za-z0-9_-]{43,}$/, '>= 256 bits, URL/cookie safe');
  assert.equal(fs.readFileSync(file, 'utf8').trim(), r.token);
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('reuses the persisted token on later starts (generated once)', (t) => {
  const dir = tmpDir(); t.after(() => rmDir(dir));
  const file = path.join(dir, '.setup-token');
  const first = resolveSetupToken({ SETUP_TOKEN_FILE: file });
  const second = resolveSetupToken({ SETUP_TOKEN_FILE: file });
  assert.equal(second.generated, false);
  assert.equal(second.token, first.token);
});

test('accepts an operator-provided token file (e.g. a Docker secret)', (t) => {
  const dir = tmpDir(); t.after(() => rmDir(dir));
  const file = path.join(dir, 'secret');
  fs.writeFileSync(file, 'operator-chosen-secret\n');
  const r = resolveSetupToken({ SETUP_TOKEN_FILE: file });
  assert.equal(r.token, 'operator-chosen-secret');
  assert.equal(r.generated, false);
});

test('is not hard-coded: two fresh volumes get different tokens', (t) => {
  const a = tmpDir(), b = tmpDir(); t.after(() => { rmDir(a); rmDir(b); });
  const ta = resolveSetupToken({ SETUP_TOKEN_FILE: path.join(a, '.setup-token') }).token;
  const tb = resolveSetupToken({ SETUP_TOKEN_FILE: path.join(b, '.setup-token') }).token;
  assert.notEqual(ta, tb);
});

test('fails closed on an empty token file instead of accepting an empty token', (t) => {
  const dir = tmpDir(); t.after(() => rmDir(dir));
  const file = path.join(dir, '.setup-token');
  fs.writeFileSync(file, '  \n');
  assert.throws(() => resolveSetupToken({ SETUP_TOKEN_FILE: file }), /ว่าง|empty/i);
});
