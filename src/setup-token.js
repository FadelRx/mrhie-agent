// ============================================================================
//  รหัสเข้าหน้า setup (SETUP_TOKEN) — ใช้เมื่อหน้า setup ผูกนอก loopback (เช่นใน Docker)
//
//  ลำดับที่หา:
//    1) SETUP_TOKEN (env / .env)                — ผู้ดูแลตั้งเอง
//    2) SETUP_TOKEN_FILE (เช่น /data/.setup-token) — อ่านจากไฟล์; ถ้ายังไม่มีไฟล์ = "ครั้งแรก"
//       -> สุ่มรหัสใหม่ 256 บิต เขียนลงไฟล์ด้วยสิทธิ์ 0600 (เก็บถาวรใน volume ใช้ซ้ำทุกครั้งที่เปิด)
//    3) ไม่มีทั้งคู่ = คืน token ว่าง ให้ startSetup ตัดสินใจไม่เปิดพอร์ต
//
//  ไม่มีรหัส hard-code ในโค้ด/compose: แต่ละ volume ได้รหัสของตัวเอง
//  ไฟล์มีอยู่แต่ว่าง = throw (fail closed) — ไม่ยอมเปิดหน้าที่รหัสว่าง
// ============================================================================
const fs = require('fs');
const crypto = require('crypto');

function readTokenFile(file) {
  const token = fs.readFileSync(file, 'utf8').trim();
  if (!token) throw new Error(`ไฟล์รหัส ${file} ว่าง (empty) — ลบไฟล์นี้แล้วเปิดใหม่เพื่อสุ่มรหัสใหม่`);
  return token;
}

function resolveSetupToken(env = process.env) {
  const fromEnv = String(env.SETUP_TOKEN || '').trim();
  if (fromEnv) return { token: fromEnv, source: 'env', generated: false };

  const file = String(env.SETUP_TOKEN_FILE || '').trim();
  if (!file) return { token: '', source: 'none', generated: false };

  try {
    return { token: readTokenFile(file), source: 'file', file, generated: false };
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }

  // ครั้งแรก: สร้างไฟล์แบบ exclusive (wx) — มีคนสร้างตัดหน้าไปแล้ว = อ่านของเขาแทน
  const token = crypto.randomBytes(32).toString('base64url');
  try {
    fs.writeFileSync(file, token + '\n', { mode: 0o600, flag: 'wx' });
  } catch (e) {
    if (e.code === 'EEXIST') return { token: readTokenFile(file), source: 'file', file, generated: false };
    throw e;
  }
  return { token, source: 'file', file, generated: true };
}

module.exports = { resolveSetupToken };
