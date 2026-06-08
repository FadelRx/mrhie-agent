// ============================================================================
//  Query pack — ดึงชุด SQL จาก Hub มารันกับ HOSxP (จัดการที่ Hub ที่เดียว)
//  - fetchPack : ดึงจาก Hub, สำเร็จ -> cache ลงไฟล์ (last-known-good)
//                ถ้า Hub ล่ม -> ใช้ cache เดิม (sync ต่อได้), ไม่มี cache -> โยน error
//  - toSql     : รวมบรรทัด SQL (เก็บใน pack เป็น array เพื่ออ่านง่าย) เป็น string
//  - renderSql : แทน {{ident}} (ชื่อ table/column/limit) แบบ validate กัน injection
//                ส่วน :param (hn/cid/since/รหัส lab) ใช้ named placeholder ของ mysql2
// ============================================================================
const fs = require('fs');

// ค่าที่อินไลน์ลง SQL ได้ ต้องเป็น identifier/ตัวเลขล้วน — กันการแทรก SQL ผ่าน override
const IDENT_RE = /^[A-Za-z0-9_]+$/;

function toSql(v) {
  if (Array.isArray(v)) return v.join('\n');
  return String(v == null ? '' : v);
}

function renderSql(sqlOrLines, idents) {
  return toSql(sqlOrLines).replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (_, name) => {
    const val = idents[name];
    if (val == null) throw new Error(`pack: ไม่พบค่า ident '${name}' (เพิ่มใน idents ของ pack หรือ overrides ของ config)`);
    const s = String(val);
    if (!IDENT_RE.test(s)) throw new Error(`pack: ค่า ident '${name}' ไม่ถูกต้อง: "${s}" (ต้องเป็น A-Z a-z 0-9 _ เท่านั้น)`);
    return s;
  });
}

async function fetchPack(cfg, cachePath) {
  const url = cfg.hub.url.replace(/\/+$/, '') + '/api/agent/pack';
  try {
    const res = await fetch(url, {
      headers: { 'Authorization': `Bearer ${cfg.hospitalCode}:${cfg.hub.apiKey}` },
    });
    const text = await res.text();
    if (!res.ok) {
      let msg = text; try { msg = JSON.parse(text).error || text; } catch {}
      throw new Error(`hub ${res.status}: ${msg}`);
    }
    const pack = JSON.parse(text);
    try { fs.writeFileSync(cachePath, JSON.stringify(pack, null, 2)); }
    catch (e) { console.warn('[pack] เขียน cache ไม่ได้:', e.message); }
    return { pack, source: 'hub' };
  } catch (e) {
    if (fs.existsSync(cachePath)) {
      const pack = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
      return { pack, source: `cache (ดึงจาก Hub ไม่ได้: ${e.message})` };
    }
    throw new Error(`ดึง query pack จาก Hub ไม่ได้ และไม่มี cache เดิม: ${e.message}`);
  }
}

module.exports = { fetchPack, renderSql, toSql };
