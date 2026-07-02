// ============================================================================
//  Generic pack runner — รัน "job-spec pack" ที่ดึงมาจาก Hub กับ HOSxP slave
//
//  *** ไม่มี logic เฉพาะโดเมนในไฟล์นี้เลย ***
//  agent ไม่รู้ว่า dataset ชื่อ 'summary' / 'opd' หมายถึงอะไร — มันแค่:
//    1) รัน driver -> ได้รายการ key (เช่น cid)
//    2) ต่อ key ละหนึ่งชุด: รัน datasets ตามลำดับ dependency แล้วเก็บ "raw rows"
//    3) ส่ง raw rows ขึ้น Hub ({ job, items:[{key, datasets}] })
//  การแปลความหมาย/แปลงรูป/บันทึกลงตาราง ทำที่ Hub (hub/src/jobs/<job>.js)
//
//  -> เพิ่มงานใหม่ = เพิ่ม pack + job module ที่ Hub เท่านั้น ไฟล์นี้ไม่ต้องแก้
// ============================================================================
const { renderSql, resolveBinds } = require('./pack');

// ---------- รวม context จาก pack + config ของ รพ. (ทำครั้งเดียวต่อ job ต่อรอบ) ----------
function buildContext(pack, cfg) {
  if (!pack || !pack.driver || !Array.isArray(pack.datasets)) {
    throw new Error(`pack '${pack && pack.job || '?'}' ไม่ถูกต้อง: ต้องมี driver และ datasets`);
  }
  // idents = ชื่อ table/column + ค่า limit (อินไลน์ลง SQL) ; override ราย รพ. ทับได้
  const idents = { ...(pack.idents || {}), ...(cfg.overrides || {}) };

  // cfg = ค่า config ของ pack (เช่น labCodes) overlay ด้วยค่าเฉพาะ รพ. (1 ชั้น)
  const merged = { ...(pack.config || {}) };
  const overlay = cfg.config || {};
  for (const k of Object.keys(overlay)) {
    const ov = overlay[k];
    merged[k] = (ov && typeof ov === 'object' && !Array.isArray(ov))
      ? { ...(merged[k] || {}), ...ov } : ov;
  }
  // backward-compat: config.json รุ่นเดิมใช้ key 'labCodes' ตรง ๆ
  if (cfg.labCodes && Object.keys(cfg.labCodes).length) {
    merged.labCodes = { ...(merged.labCodes || {}), ...cfg.labCodes };
  }

  return { pack, idents, cfg: merged };
}

// ---------- รัน SQL หนึ่งตัว (string หรือ array ของบรรทัด) ----------
async function runSql(conn, ctx, sqlSpec, binds) {
  const sql = renderSql(sqlSpec, ctx.idents);
  const [rows] = await conn.query(sql, binds || {});
  return rows;
}

// ---------- รัน dataset หนึ่งตัว (รองรับ SQL เดี่ยว และหลาย query รวม rows) ----------
//   sql = ["...","..."]        -> หนึ่ง query
//   sql = [["..."],["..."]]    -> หลาย query, นำ rows มาต่อกัน (เช่น labs)
async function runDataset(conn, ctx, ds, binds) {
  const spec = ds.sql;
  const isMulti = Array.isArray(spec) && spec.length > 0 && Array.isArray(spec[0]);
  if (!isMulti) return runSql(conn, ctx, spec, binds);
  const out = [];
  for (const one of spec) out.push(...await runSql(conn, ctx, one, binds));
  return out;
}

// dataset อ้าง dataset อื่นใน bind ตัวไหนบ้าง (เพื่อจัดลำดับ/รันขนาน)
function depsOf(ds, names) {
  const deps = new Set();
  for (const spec of Object.values(ds.bind || {})) {
    if (typeof spec === 'string' && spec[0] === '$') {
      const head = spec.slice(1).split('.')[0];
      if (names.has(head)) deps.add(head);
    }
  }
  return deps;
}

// ---------- รัน datasets ทั้งหมดของ key หนึ่ง (เป็น wave ตาม dependency เพื่อรันขนาน) ----------
async function runPerKey(conn, ctx, perKey, key, since) {
  const names = new Set(perKey.map(d => d.name));
  const prev = {};                              // ชื่อ dataset -> rows (ไว้ให้ bind อ้างถึง)
  const pending = new Map(perKey.map(d => [d.name, d]));

  while (pending.size) {
    const ready = [...pending.values()].filter(d => [...depsOf(d, names)].every(n => n in prev));
    if (!ready.length) throw new Error(`pack '${ctx.pack.job}': datasets มี dependency วน (${[...pending.keys()].join(', ')})`);
    await Promise.all(ready.map(async (ds) => {
      const binds = resolveBinds(ds.bind, { key, since, cfg: ctx.cfg, prev });
      prev[ds.name] = await runDataset(conn, ctx, ds, binds);
      pending.delete(ds.name);
    }));
    // ถ้ามี required dataset ที่ว่าง -> ข้าม key นี้ (เช่นหา hn ไม่เจอ)
    for (const ds of ready) {
      if (ds.required && (!prev[ds.name] || prev[ds.name].length === 0)) return null;
    }
  }
  return prev;
}

// ---------- รัน driver -> รายการ key ----------
async function listKeys(conn, ctx, since) {
  const d = ctx.pack.driver;
  const binds = resolveBinds(d.bind, { since, cfg: ctx.cfg, prev: {} });
  const rows = await runSql(conn, ctx, d.sql, binds);
  const keyCol = d.key || 'cid';
  return rows.map(r => r[keyCol]).filter(k => k != null);
}

// ---------- รัน job หนึ่งครบ: คืน items ที่พร้อม push ----------
//   mapLimit = ตัวคุม concurrency (ส่งมาจาก index.js), since = ISO date
async function runJob(conn, pack, cfg, since, mapLimit, maxKeys) {
  const ctx = buildContext(pack, cfg);
  const perKey = ctx.pack.datasets.filter(d => (d.scope || 'perKey') === 'perKey');

  let keys = await listKeys(conn, ctx, since);
  const driverTotal = keys.length;              // จำนวนทั้งหมดที่เข้าเกณฑ์ (ก่อนตัดด้วย limit — ไว้ประมาณการทั้งรอบ)
  if (maxKeys && keys.length > maxKeys) {
    console.log(`[agent] จำกัดจำนวน key เพื่อทดสอบ: ${keys.length} -> ${maxKeys} (--limit)`);
    keys = keys.slice(0, maxKeys);
  }
  const built = await mapLimit(keys, (key) => runPerKey(conn, ctx, perKey, key, since));

  const items = [];
  let errors = 0, skipped = 0;
  for (let i = 0; i < built.length; i++) {
    const r = built[i];
    if (r && r.__error) { errors++; continue; }
    if (r === null) { skipped++; continue; }     // required dataset ว่าง
    items.push({ key: keys[i], datasets: r });
  }
  return { items, total: keys.length, errors, skipped, driverTotal };
}

module.exports = { runJob, buildContext };
