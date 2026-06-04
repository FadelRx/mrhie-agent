// ============================================================================
//  HOSxP queries — พอร์ตมาจาก flow n8n ที่ผ่านการทดสอบกับ รพ. นำร่อง (HOSxP มาตรฐาน)
//  หน้าที่: อ่านข้อมูลจาก HOSxP slave แล้วแปลงเป็น payload รูปแบบกลางของ Hub
//
//  หมายเหตุ: HOSxP เป็น schema มาตรฐาน รพ. ส่วนใหญ่ใช้คอลัมน์เดียวกัน
//  หาก รพ. ใดใช้ HOSxP เวอร์ชันต่างมาก อาจต้องปรับชื่อคอลัมน์ในไฟล์นี้เท่านั้น
//  (ส่วนอื่นของ agent/Hub ไม่ต้องแก้)
// ============================================================================

function isoDate(d) {
  if (!d) return null;
  const dt = (d instanceof Date) ? d : new Date(d);
  if (isNaN(dt)) return null;
  return dt.toISOString().slice(0, 10);
}
function buddhistDateTime(d) {     // ไว้ทำข้อความวันนัด (ว/ด/ป พ.ศ. + เวลา)
  if (!d) return null;
  const dt = (d instanceof Date) ? d : new Date(d);
  if (isNaN(dt)) return null;
  const p = (n) => String(n).padStart(2, '0');
  return `${p(dt.getDate())}/${p(dt.getMonth() + 1)}/${dt.getFullYear() + 543}`;
}

// ---------- 1) รายชื่อ CID ที่มี movement ตั้งแต่วันที่ cutoff (OPD หรือ IPD) ----------
//   cutoff = Date หรือ 'YYYY-MM-DD'
//   - full sync   : cutoff = วันนี้ - sinceDays
//   - incremental : cutoff = วันที่ sync ล่าสุด - overlapDays
//   เงื่อนไข IPD รวม dchdate (เพิ่งจำหน่าย/ยากลับบ้านเพิ่งสรุป) และ dchdate IS NULL (ยัง admit อยู่)
async function listCandidateCids(conn, cutoff) {
  const since = (cutoff instanceof Date) ? cutoff.toISOString().slice(0, 10) : String(cutoff);
  const [rows] = await conn.query(
    `SELECT DISTINCT p.cid
       FROM patient p
      WHERE p.cid IS NOT NULL AND CHAR_LENGTH(p.cid) = 13
        AND ( EXISTS (SELECT 1 FROM ovst o
                       WHERE o.hn = p.hn AND o.vstdate >= ?)
           OR EXISTS (SELECT 1 FROM ipt i
                       WHERE i.hn = p.hn AND (i.regdate >= ? OR i.dchdate >= ? OR i.dchdate IS NULL)) )`,
    [since, since, since]
  );
  return rows.map(r => r.cid);
}

// ---------- helper: หา hn จาก cid ----------
async function getHn(conn, cid) {
  const [r] = await conn.query('SELECT hn FROM patient WHERE cid = ? LIMIT 1', [cid]);
  return r.length ? r[0].hn : null;
}

// ---------- 2) demographics + ค่าสรุป + โรคประจำตัว + วันนัด ----------
async function getSummary(conn, cid, hn) {
  const [pr] = await conn.query(
    `SELECT p.cid, p.hn, p.sex,
            TRIM(CONCAT_WS(' ', p.pname, p.fname, p.lname)) AS fullname,
            p.birthday,
            TIMESTAMPDIFF(YEAR, p.birthday, CURDATE()) AS age
       FROM patient p WHERE p.hn = ? LIMIT 1`, [hn]
  );
  const p = pr[0] || { cid };

  // opdscreen ล่าสุด -> น้ำหนัก/ความดัน/BMI
  const [sr] = await conn.query(
    `SELECT s.bps, s.bpd, s.bw, s.bmi
       FROM opdscreen s JOIN ovst o ON o.vn = s.vn
      WHERE o.hn = ? AND (s.bps > 0 OR s.bw > 0)
      ORDER BY o.vstdate DESC LIMIT 1`, [hn]
  );
  const s = sr[0] || {};

  // โรคประจำตัวจาก ovstdiag (ICD10 ที่พบบ่อย ล่าสุด 6 อันดับ)
  const [dr] = await conn.query(
    `SELECT DISTINCT i.name AS dx
       FROM ovstdiag d JOIN ovst o ON o.vn = d.vn
       JOIN icd101 i ON i.code = d.diagcode
      WHERE o.hn = ? AND d.diagcode <> ''
      ORDER BY o.vstdate DESC LIMIT 6`, [hn]
  );
  const chronic = dr.map(x => x.dx).filter(Boolean).join(', ') || null;

  // วันนัดครั้งถัดไป (ที่ยังไม่ถึง) + คลินิก
  const [ar] = await conn.query(
    `SELECT a.nextdate, a.nexttime, c.department AS clinic
       FROM oapp a LEFT JOIN clinic c ON c.clinic = a.clinic
      WHERE a.hn = ? AND a.nextdate >= CURDATE()
      ORDER BY a.nextdate ASC LIMIT 1`, [hn]
  );
  let next_appt = null, next_appt_at = null;
  if (ar[0]) {
    next_appt_at = isoDate(ar[0].nextdate);
    const t = (ar[0].nexttime || '').toString().slice(0, 5);
    next_appt = `${buddhistDateTime(ar[0].nextdate)}${t ? ' ' + t : ''}${ar[0].clinic ? ' ' + ar[0].clinic : ''}`;
  }

  return {
    cid,
    fullname: p.fullname || null,
    sex: p.sex || null,
    birthdate: isoDate(p.birthday),
    age: p.age != null ? Number(p.age) : null,
    weight: s.bw != null ? Number(s.bw) : null,
    bmi: s.bmi != null ? Number(s.bmi) : null,
    bp: (s.bps && s.bpd) ? `${Math.round(s.bps)}/${Math.round(s.bpd)}` : null,
    chronic, next_appt, next_appt_at,
  };
}

// ---------- 3) ผลแล็บ NCD (ล่าสุดแต่ละชนิด พร้อมวันที่) ----------
// แมตช์ด้วยชื่อ lab (พกพาง่ายกว่าผูกรหัส lab_items_code ที่ต่างกันแต่ละ รพ.)
const LAB_MAP = [
  ['HbA1c', /hba1c|a1c/i],
  ['FBS', /fbs|fasting.*glucose|glucose.*fasting/i],
  ['eGFR', /egfr|gfr/i],
  ['Chol', /cholesterol|^chol/i],
  ['TG', /triglyceride|^tg\b/i],
  ['HDL', /hdl/i],
  ['LDL', /ldl/i],
];
function classifyLab(name) {
  for (const [type, re] of LAB_MAP) if (re.test(name || '')) return type;
  return null;
}
async function getLabs(conn, cid, hn) {
  const [rows] = await conn.query(
    `SELECT li.lab_items_name AS name, lo.lab_order_result AS val,
            COALESCE(lh.report_date, lh.order_date, lh.vstdate) AS dt, lo.lab_items_unit AS unit
       FROM lab_head lh
       JOIN lab_order lo ON lo.lab_order_number = lh.lab_order_number
       JOIN lab_items li ON li.lab_items_code = lo.lab_items_code
      WHERE lh.hn = ? AND lo.lab_order_result IS NOT NULL AND lo.lab_order_result <> ''
        AND ( li.lab_items_name REGEXP 'HbA1c|A1C|FBS|Glucose|GFR|Cholesterol|Triglyceride|HDL|LDL' )
      ORDER BY dt DESC`, [hn]
  );
  const best = {};   // type -> latest
  for (const r of rows) {
    const type = classifyLab(r.name);
    if (!type || best[type]) continue;     // rows เรียง desc แล้ว เก็บอันแรก = ล่าสุด
    best[type] = {
      lab_type: type,
      lab_value: String(r.val).trim(),
      unit: (r.unit || '').trim() || null,
      lab_date: isoDate(r.dt),
    };
  }
  return Object.values(best);
}

// ---------- 4) ยา OPD (visit ล่าสุดที่มียา) ----------
async function getOpdVisits(conn, hn, limit) {
  const [rows] = await conn.query(
    `SELECT o.vn AS visit_no, o.vstdate AS visit_date,
            dt.name AS generic, dt.strength AS strength, opr.qty AS qty,
            TRIM(CONCAT_WS(' ', du.name1, du.name2, du.name3)) AS sig_normal,
            sp.special AS sig_special
       FROM (
            SELECT ov.vn, ov.vstdate
              FROM ovst ov
             WHERE ov.hn = ?
               AND EXISTS (SELECT 1 FROM opitemrece r JOIN drugitems d ON d.icode = r.icode WHERE r.vn = ov.vn)
             ORDER BY ov.vstdate DESC, ov.vn DESC
             LIMIT ?
       ) o
       JOIN opitemrece opr ON opr.vn = o.vn
       JOIN drugitems dt   ON dt.icode = opr.icode
       LEFT JOIN drugusage du ON du.drugusage = opr.drugusage
       LEFT JOIN sp_use sp    ON sp.vn = o.vn AND sp.icode = opr.icode
      ORDER BY o.vstdate DESC, dt.name`, [hn, limit]
  );
  return groupMeds(rows, 'OPD');
}

// ---------- 5) ยากลับบ้านตอน admit (IPD home med) ----------
async function getIpdHomeMed(conn, hn, limit) {
  const [rows] = await conn.query(
    `SELECT i.an AS visit_no, COALESCE(i.dchdate, i.regdate) AS visit_date,
            dt.name AS generic, dt.strength AS strength, opr.qty AS qty,
            TRIM(CONCAT_WS(' ', du.name1, du.name2, du.name3)) AS sig_normal,
            NULL AS sig_special
       FROM (
            SELECT ip.an, ip.regdate, ip.dchdate
              FROM ipt ip
             WHERE ip.hn = ?
             ORDER BY ip.regdate DESC
             LIMIT ?
       ) i
       JOIN ipt_order_no ion ON ion.an = i.an AND ion.order_type = 'HMe'
       JOIN opitemrece opr   ON opr.order_no = ion.order_no
       JOIN drugitems dt     ON dt.icode = opr.icode
       LEFT JOIN drugusage du ON du.drugusage = opr.drugusage
      ORDER BY visit_date DESC, dt.name`, [hn, limit]
  );
  return groupMeds(rows, 'IPD');
}

// ---------- รวมแถวยาเป็น visit objects ----------
function groupMeds(rows, visit_type) {
  const map = new Map();
  for (const r of rows) {
    const key = String(r.visit_no);
    if (!map.has(key)) {
      map.set(key, { visit_type, visit_no: key, visit_date: isoDate(r.visit_date), meds: [] });
    }
    const special = (r.sig_special || '').trim();
    const normal = (r.sig_normal || '').trim();
    const sig = special ? (normal ? `${normal} | พิเศษ: ${special}` : `พิเศษ: ${special}`) : normal;
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
async function buildPatientPayload(conn, cid, sync) {
  const hn = await getHn(conn, cid);
  if (!hn) return null;
  const [summary, labs, opd, ipd] = await Promise.all([
    getSummary(conn, cid, hn),
    getLabs(conn, cid, hn),
    getOpdVisits(conn, hn, sync.opdVisits || 5),
    getIpdHomeMed(conn, hn, sync.ipdAdmits || 3),
  ]);
  const visits = [...opd, ...ipd].filter(v => v.visit_no && v.visit_date);
  return { patient: summary, labs, visits };
}

module.exports = { listCandidateCids, buildPatientPayload };
