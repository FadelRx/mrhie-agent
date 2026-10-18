// เป้าหมาย: Docker ปลอดภัยตั้งแต่ครั้งแรก — พอร์ต setup เปิดเฉพาะ localhost ของเครื่อง host,
// รหัสเข้าหน้า setup มาจาก volume (ไม่ hard-code), image ไม่อบ secret ของเครื่อง build เข้าไป,
// และติดตั้ง dependency ตาม lockfile ที่ผ่าน npm audit แล้ว (npm ci)
// (อ่านไฟล์ตรง ๆ — เทสต์ไม่ต้องมี docker; `docker compose config` รันแยกใน CI)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ROOT } = require('./helpers/agent');

const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

// ดึงรายการใต้ `ports:` ของ compose (รูปแบบ list สั้น ๆ ที่ repo นี้ใช้)
function portMappings(yml) {
  const lines = yml.split(/\r?\n/);
  const out = [];
  lines.forEach((l, i) => {
    const m = /^(\s*)ports:\s*$/.exec(l);
    if (!m) return;
    for (let j = i + 1; j < lines.length; j++) {
      const s = lines[j];
      if (/^\s*#/.test(s) || !s.trim()) continue;
      const item = /^\s*-\s*["']?([^"'\s#]+)["']?/.exec(s);
      if (!item || s.search(/\S/) <= m[1].length) break;
      out.push(item[1]);
    }
  });
  return out;
}

test('compose publishes the setup port on 127.0.0.1 only', () => {
  const maps = portMappings(read('docker-compose.yml'));
  assert.ok(maps.length > 0, 'expected a ports mapping for the setup UI');
  for (const m of maps) assert.match(m, /^127\.0\.0\.1:\d+:7070$/, `port mapping '${m}' must bind localhost only`);
});

test('compose bootstraps the setup token from the data volume, never a literal token', () => {
  const yml = read('docker-compose.yml');
  assert.match(yml, /^\s*SETUP_TOKEN_FILE:\s*\/data\/\S+/m, 'SETUP_TOKEN_FILE must live in the /data volume');
  assert.doesNotMatch(yml, /^\s*-?\s*SETUP_TOKEN\s*[:=]/m, 'compose must not hard-code SETUP_TOKEN');
});

test('.dockerignore keeps local secrets and state out of the image', () => {
  const entries = read('.dockerignore').split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith('#'));
  for (const f of ['.env', 'config.json', '.hub-key.json', '.setup-token', '.sync-state.json', '.query-pack.json', '.agent.lock', 'node_modules', '.git']) {
    assert.ok(entries.some((e) => e.replace(/^\/|\/$/g, '') === f), `.dockerignore must exclude ${f}`);
  }
});

test('Dockerfile installs production deps from the lockfile (npm ci)', () => {
  const df = read('Dockerfile');
  assert.match(df, /^COPY\s+package\.json\s+package-lock\.json\s/m, 'lockfile must be copied before install');
  assert.match(df, /^RUN\s+npm ci\b.*--omit=dev/m);
  assert.doesNotMatch(df, /npm install/);
});
