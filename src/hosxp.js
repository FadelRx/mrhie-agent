// ============================================================================
//  HOSxP runner — รัน "query pack" ที่ดึงมาจาก Hub กับ HOSxP slave
//  แล้วแปลงผลเป็น payload รูปแบบกลางของ Hub
//
//  *** ไม่มี SQL ฝังในไฟล์นี้แล้ว *** — SQL ทั้งหมดอยู่ใน pack ที่ Hub จัดการ
//  (ดู hub/packs/default.json). ไฟล์นี้เหลือแค่:
//    1) buildContext()  : รวม idents (ชื่อ table/column/limit) + binds (รหัส lab)
//                         จาก pack.config ทับด้วย overrides/labCodes ของ รพ. นั้น
//    2) ตัว runner generic ตาม "column contract" ของแต่ละ query
//    3) logic แปลงผล (groupMeds / coercion) ที่เสถียร ไม่ผูกกับ SQL
//
//  Column contract (แต่ละ query ต้องคืนคอลัมน์ตามนี้):
//    hn(:cid)          -> { hn }
//    candidates(:since)-> { cid }[]
//    summary(:hn)      -> { cid, fullname, sex, birthdate, age, weight, bmi, bp, chronic }
//    appt(:hn)         -> { nextdate, nexttime, clinic }
//    labs[](:hn,+lab)  -> { lab_type, lab_value, unit, lab_date }[]
//    opd/ipd(:hn)      -> { visit_no, visit_date, visit_kind, clinic_code, clinic_name,
//                           generic, strength, qty, sig_normal, sig_special }[]
// ============================================================================
const { renderSql } = require('./pack');

function isoDate(d) {
  if (!d) return null;
  const dt = (d instanceof Date) ? d : new Date(d);
  if (isNaN(dt)) return null;
  return dt.toISOString().slice(0, 10);
}
function buddhistDate(d) {     // ว/ด/ป พ.ศ. ไว้ทำข้อความวันนัด
  if (!d) return null;
  const dt = (d instanceof Date) ? d : new Date(d);
  if (isNaN(dt)) return null;
  const p = (n) => String(n).padStart(2, '0');
  return `${p(dt.getDate())}/${p(dt.getMonth() + 1)}/${dt.getFullYear() + 543}`;
}
function intOr(...vals) {
  for (const v of vals) { const x = parseInt(v, 10); if (Number.isFinite(x) && x > 0) return x; }
  return 1;
}

// ---------- รวม context จาก pack + config ของ รพ. (ทำครั้งเดียวต่อรอบ sync) ----------
function buildContext(pack, cfg) {
  if (!pack || !pack.queries) throw new Error('pack ไม่ถูกต้อง: ไม่มี queries');
  const c = pack.config || {};
  const sync = cfg.sync || {};

  // idents = ชื่อ table/column + ค่า limit (อินไลน์ลง SQL) ; override ราย รพ. ทับได้
  const idents = { ...(pack.idents || {}) };
  idents.opdVisits     = String(intOr(sync.opdVisits, c.opdVisits, 5));
  idents.ipdAdmits     = String(intOr(sync.ipdAdmits, c.ipdAdmits, 3));
  idents.labScanVisits = String(intOr(c.labScanVisits, 25));
  Object.assign(idents, cfg.overrides || {});   // ชื่อ table/column เฉพาะ รพ.

  // binds = ค่าที่ bind ผ่าน placeholder (รหัส lab) ; override ราย รพ. ทับได้
  const labCodes = { ...(c.labCodes || {}), ...(cfg.labCodes || {}) };

  return { pack, idents, labCodes };
}

// ---------- helper: รัน query หนึ่งตัวจาก pack ----------
async function runQ(conn, ctx, sqlSpec, binds) {
  const sql = renderSql(sqlSpec, ctx.idents);
  const [rows] = await conn.query(sql, binds || {});
  return rows;
}

// ---------- รายชื่อ CID ที่มี movement ตั้งแต่ cutoff ----------
async function listCandidateCids(conn, ctx, cutoff) {
  const since = (cutoff instanceof Date) ? cutoff.toISOString().slice(0, 10) : String(cutoff);
  const rows = await runQ(conn, ctx, ctx.pack.queries.candidates, { since });
  return rows.map(r => r.cid);
}

// ---------- map ผล summary + appt -> object สรุป ----------
function mapSummary(cid, s, appt) {
  s = s || {};
  let next_appt = null, next_appt_at = null;
  if (appt && appt.nextdate) {
    next_appt_at = isoDate(appt.nextdate);
    const t = (appt.nexttime || '').toString().slice(0, 5);
    next_appt = `${buddhistDate(appt.nextdate)}${t ? ' ' + t : ''}${appt.clinic ? ' · ' + appt.clinic : ''}`;
  }
  return {
    cid: s.cid || cid,
    fullname: s.fullname || null,
    sex: s.sex || null,
    birthdate: isoDate(s.birthdate),
    age: s.age != null ? Number(s.age) : null,
    weight: s.weight != null ? Number(s.weight) : null,
    bmi: s.bmi != null ? Number(s.bmi) : null,
    bp: s.bp || null,
    chronic: (s.chronic || '').trim() || null,
    next_appt, next_appt_at,
  };
}

// ---------- map ผล labs (หลาย query รวมกัน) -> array ----------
function mapLabs(resultSets) {
  const out = [];
  for (const rows of resultSets) {
    for (const r of (rows || [])) {
      const v = (r.lab_value == null) ? '' : String(r.lab_value).trim();
      if (v === '' || !r.lab_type) continue;
      out.push({
        lab_type: String(r.lab_type).trim(),
        lab_value: v,
        unit: (r.unit != null ? String(r.unit).trim() : '') || null,
        lab_date: isoDate(r.lab_date),
      });
    }
  }
  return out;
}

// ---------- รวมแถวยาเป็น visit objects ----------
function groupMeds(rows, visit_type) {
  const map = new Map();
  for (const r of rows) {
    const key = String(r.visit_no);
    if (!map.has(key)) {
      map.set(key, {
        visit_type, visit_no: key, visit_date: isoDate(r.visit_date),
        visit_kind: (r.visit_kind || visit_type),                 // OPD | ER | IPD
        clinic_code: (r.clinic_code != null ? String(r.clinic_code).trim() : null) || null,
        clinic_name: (r.clinic_name || '').trim() || null,
        meds: [],
      });
    }
    const special = (r.sig_special || '').trim();
    const normal = (r.sig_normal || '').trim();
    const sig = special ? (normal ? `${normal}  •  ${special}` : special) : normal;
    map.get(key).meds.push({
      generic: (r.generic || '').trim(),
      strength: (r.strength || '').trim() || null,
      sig: sig || null,
      qty: r.qty != null ? Number(r.qty) : null,
      usage_type: special ? 'special' : 'normal',
    });
  }
  return [...map.values()];
}

// ---------- ประกอบ payload ของคนไข้ 1 คน ----------
async function buildPatientPayload(conn, cid, ctx) {
  const q = ctx.pack.queries;
  const hnRows = await runQ(conn, ctx, q.hn, { cid });
  const hn = hnRows[0] && hnRows[0].hn;
  if (!hn) return null;

  const labBinds = { hn, ...ctx.labCodes };
  const labSpecs = Array.isArray(q.labs) ? q.labs : (q.labs ? [q.labs] : []);

  const [summaryRows, apptRows, opdRows, ipdRows, ...labSets] = await Promise.all([
    runQ(conn, ctx, q.summary, { hn }),
    q.appt ? runQ(conn, ctx, q.appt, { hn }) : Promise.resolve([]),
    runQ(conn, ctx, q.opd, { hn }),
    runQ(conn, ctx, q.ipd, { hn }),
    ...labSpecs.map(spec => runQ(conn, ctx, spec, labBinds)),
  ]);

  const summary = mapSummary(cid, summaryRows[0], apptRows[0]);
  const labs = mapLabs(labSets);
  const visits = [...groupMeds(opdRows, 'OPD'), ...groupMeds(ipdRows, 'IPD')]
    .filter(v => v.visit_no && v.visit_date);

  return { patient: summary, labs, visits };
}

module.exports = { buildContext, listCandidateCids, buildPatientPayload };
