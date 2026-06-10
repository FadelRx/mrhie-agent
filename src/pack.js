// ============================================================================
//  Query pack — ดึง "ชุดงาน (jobs)" จาก Hub มารันกับ HOSxP (จัดการที่ Hub ที่เดียว)
//
//  *** agent เป็น generic runner — ไม่รู้จักโดเมนใด ๆ ***
//  pack หนึ่งตัว = หนึ่งงาน (job) บอกว่า: ดึงคีย์ด้วย driver แล้วต่อด้วย datasets อะไร
//  เพิ่มงานใหม่ = เพิ่ม/แก้ pack ที่ Hub เท่านั้น ไม่ต้องแก้ agent
//
//  - fetchPacks : ดึงรายการ pack ที่ active จาก Hub, สำเร็จ -> cache (last-known-good)
//                 Hub ล่ม -> ใช้ cache เดิม, ไม่มี cache -> โยน error
//  - renderSql  : แทน {{ident}} (ชื่อ table/column/limit) แบบ validate กัน injection
//  - resolveBinds : แปลงค่า bind ของ dataset ($key/$since/$cfg.x/$dataset.col) เป็นค่าจริง
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

// ---------- bind resolver ----------
// เดินตาม path ของ object เช่น getPath(cfg, ['labCodes','egfr'])
function getPath(obj, parts) {
  let cur = obj;
  for (const p of parts) {
    if (cur == null) return null;
    cur = cur[p];
  }
  return cur === undefined ? null : cur;
}

// แปลงค่า bind หนึ่งตัว — มีเฉพาะ string ที่ขึ้นต้น $ เท่านั้นที่เป็น token, ที่เหลือเป็น literal
//   $key            -> ค่าคีย์ของ entity ปัจจุบัน (จาก driver)
//   $since          -> วันที่ cutoff (ISO) ของรอบ sync นี้
//   $cfg.a.b        -> ค่าใน config ของ pack (เช่น $cfg.labCodes.egfr)
//   $<dataset>.col  -> ค่าคอลัมน์จากแถวแรกของ dataset ที่รันไปก่อนหน้า (เช่น $hn.hn)
function resolveOne(spec, src) {
  if (typeof spec !== 'string' || spec[0] !== '$') return spec;
  if (spec === '$key') return src.key;
  if (spec === '$since') return src.since;
  const parts = spec.slice(1).split('.');
  const head = parts.shift();
  if (head === 'cfg') return getPath(src.cfg, parts);
  // อ้างผลของ dataset ก่อนหน้า: $hn.hn -> rows ของ dataset 'hn' แถวแรก คอลัมน์ 'hn'
  const rows = src.prev[head];
  if (rows === undefined) throw new Error(`pack: bind อ้าง dataset '${head}' ที่ยังไม่ถูกรัน (ตรวจลำดับ/ชื่อ datasets ใน pack)`);
  const row = rows[0];
  return row ? getPath(row, parts) : null;
}

function resolveBinds(bindMap, src) {
  const out = {};
  for (const [param, spec] of Object.entries(bindMap || {})) out[param] = resolveOne(spec, src);
  return out;
}

async function fetchPacks(cfg, cachePath) {
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
    const body = JSON.parse(text);
    const packs = normalizePacks(body);
    try { fs.writeFileSync(cachePath, JSON.stringify(packs, null, 2)); }
    catch (e) { console.warn('[pack] เขียน cache ไม่ได้:', e.message); }
    return { packs, source: 'hub' };
  } catch (e) {
    if (fs.existsSync(cachePath)) {
      const packs = normalizePacks(JSON.parse(fs.readFileSync(cachePath, 'utf8')));
      return { packs, source: `cache (ดึงจาก Hub ไม่ได้: ${e.message})` };
    }
    throw new Error(`ดึง query pack จาก Hub ไม่ได้ และไม่มี cache เดิม: ${e.message}`);
  }
}

// Hub อาจตอบเป็น array ของ pack, {packs:[...]}, หรือ pack เดี่ยว (รองรับทุกแบบ)
function normalizePacks(body) {
  if (Array.isArray(body)) return body;
  if (body && Array.isArray(body.packs)) return body.packs;
  if (body && body.queries) return [body];     // pack รุ่นเก่า (เดี่ยว)
  if (body && body.datasets) return [body];     // pack v2 เดี่ยว
  throw new Error('รูปแบบ pack จาก Hub ไม่ถูกต้อง');
}

module.exports = { fetchPacks, renderSql, toSql, resolveBinds };
