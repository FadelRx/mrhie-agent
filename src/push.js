// ============================================================================
//  ส่งข้อมูลขึ้น Hub — เข้ารหัส payload แบบ end-to-end เสมอ (ชั้นที่สองนอกเหนือจาก TLS)
//    1) ดึงกุญแจสาธารณะของ hub จาก GET /api/agent/pubkey (ครั้งแรกของโปรเซส)
//       แล้ว "pin" ลายนิ้วมือไว้ใน .hub-key.json — รอบถัดไปถ้ากุญแจเปลี่ยนโดยไม่คาดคิด
//       จะไม่ยอมส่งและฟ้อง (กันคนกลางสลับกุญแจ / MITM)
//    2) ทุก request: สุ่มกุญแจ AES-256-GCM ใหม่ -> เข้ารหัส JSON -> ห่อกุญแจ AES
//       ด้วย RSA-OAEP(SHA-256) ของ hub -> ส่ง { enc: {...} }
//    ต่อให้ช่องทางเป็น HTTP เปล่า/มี proxy คั่นกลาง ก็อ่านข้อมูลคนไข้ไม่ออก
// ============================================================================
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const KEYPIN_PATH = process.env.AGENT_KEYPIN || path.join(__dirname, '..', '.hub-key.json');

let hubKey = null;   // cache ต่อโปรเซส: { publicKey, fingerprint }

// ดึงกุญแจสาธารณะจาก hub + ตรวจกับที่ pin ไว้
async function getHubKey(hub, hospitalCode) {
  if (hubKey) return hubKey;
  const res = await fetch(hub.url.replace(/\/+$/, '') + '/api/agent/pubkey', {
    headers: { 'Authorization': `Bearer ${hospitalCode}:${hub.apiKey}` },
  });
  if (res.status === 404) throw new Error('hub รุ่นนี้ยังไม่รองรับการเข้ารหัส payload — อัปเดต hub ก่อน');
  if (!res.ok) throw new Error(`ดึงกุญแจ hub ไม่ได้ (${res.status})`);
  const { publicKey, fingerprint } = await res.json();
  if (!publicKey || !fingerprint) throw new Error('hub ส่งกุญแจกลับมาไม่ครบ');

  // ตรวจว่า fingerprint ตรงกับกุญแจจริง (ไม่เชื่อ hub เปล่า ๆ)
  const der = crypto.createPublicKey(publicKey).export({ type: 'spki', format: 'der' });
  const fp = crypto.createHash('sha256').update(der).digest('hex');
  if (fp !== fingerprint) throw new Error('fingerprint ไม่ตรงกับกุญแจที่ hub ส่งมา');

  // pin ครั้งแรก / ตรวจกับที่เคย pin (trust-on-first-use)
  let pinned = null;
  try { pinned = JSON.parse(fs.readFileSync(KEYPIN_PATH, 'utf8')); } catch {}
  if (pinned && pinned.fingerprint && pinned.fingerprint !== fp) {
    throw new Error(`กุญแจของ hub เปลี่ยนจากที่เคย pin ไว้ (${pinned.fingerprint.slice(0, 16)}… -> ${fp.slice(0, 16)}…) — `
      + `ถ้าผู้ดูแล hub ยืนยันว่าเปลี่ยนกุญแจจริง ให้ลบไฟล์ ${path.basename(KEYPIN_PATH)} แล้วรันใหม่`);
  }
  if (!pinned || pinned.fingerprint !== fp) {
    fs.writeFileSync(KEYPIN_PATH, JSON.stringify({ fingerprint: fp, pinnedAt: new Date().toISOString(), hubUrl: hub.url }, null, 2) + '\n');
    console.log(`[agent] pin กุญแจ hub แล้ว: ${fp.slice(0, 16)}…`);
  }
  hubKey = { publicKey, fingerprint: fp };
  return hubKey;
}

// ห่อ object เป็นซองเข้ารหัส { v, alg, k, iv, tag, d }
function encryptEnvelope(publicKey, obj) {
  const key = crypto.randomBytes(32);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(obj), 'utf8'), cipher.final()]);
  const ekey = crypto.publicEncrypt(
    { key: publicKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, key);
  return {
    v: 1, alg: 'RSA-OAEP-256+A256GCM',
    k: ekey.toString('base64'), iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'), d: data.toString('base64'),
  };
}

// ส่ง raw rows ขึ้น Hub — body: { enc } (ข้างใน = { job, items } เดิม)
async function pushItems(hub, hospitalCode, job, items) {
  const { publicKey } = await getHubKey(hub, hospitalCode);
  const enc = encryptEnvelope(publicKey, { job, items });
  const res = await fetch(hub.url.replace(/\/+$/, '') + '/api/ingest', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${hospitalCode}:${hub.apiKey}`,
    },
    body: JSON.stringify({ enc }),
  });
  const text = await res.text();
  let body; try { body = JSON.parse(text); } catch { body = { raw: text }; }
  if (!res.ok) {
    const err = new Error(`hub ${res.status}: ${body.error || text}`);
    err.status = res.status;   // ให้ผู้เรียกตัดสินใจ retry ได้ (429/5xx = ชั่วคราว, 4xx อื่น = ถาวร)
    throw err;
  }
  return body;
}

module.exports = { pushItems };
