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
// บังคับให้ค่า LIMIT เป็นจำนวนเต็มบวกที่ปลอดภัย (อินไลน์ลง SQL ได้ ไม่ต้องผ่าน placeholder)
function lim(n, def) { const x = parseInt(n, 10); return (Number.isFinite(x) && x > 0) ? x : def; }
// SQL ย่อย: usage_special จาก sp_use (รวม name1..3 โดยตัดช่อง/จุดที่ว่างเปล่าทิ้ง)
const SP_SPECIAL_SQL = `TRIM(CONCAT_WS(' ',
        CASE WHEN sp.name1 REGEXP '^[ .]*$' THEN NULL ELSE sp.name1 END,
        CASE WHEN sp.name2 REGEXP '^[ .]*$' THEN NULL ELSE sp.name2 END,
        CASE WHEN sp.name3 REGEXP '^[ .]*$' THEN NULL ELSE sp.name3 END))`;
const SP_JOIN_SQL = `LEFT JOIN sp_use sp ON sp.sp_use = opr.sp_use AND opr.sp_use NOT IN ('','0000000')`;

// ---------- 2) demographics + ค่าสรุป + โรคประจำตัว + วันนัด ----------
async function getSummary(conn, cid, hn) {
  const [pr] = await conn.query(
    `SELECT p.cid, p.hn, p.sex,
            TRIM(CONCAT_WS(' ', p.pname, p.fname, p.lname)) AS fullname,
            p.birthday,
            FLOOR(DATEDIFF(CURDATE(), p.birthday) / 365.25) AS age
       FROM patient p WHERE p.hn = ? LIMIT 1`, [hn]
  );
  const p = pr[0] || { cid };

  // opdscreen — ดึงค่าล่าสุด "ที่ไม่เป็นศูนย์" ของแต่ละตัวแยกกัน (bw/bmi/ความดัน อาจมาคนละ visit)
  const oneVal = async (col, where) => {
    const [r] = await conn.query(
      `SELECT ${col} AS v FROM opdscreen os
        WHERE os.hn = ? AND ${where}
        ORDER BY os.vstdate DESC LIMIT 1`, [hn]
    );
    return r[0] ? r[0].v : null;
  };
  const bw  = await oneVal('ROUND(os.bw,1)',  'os.bw > 0');
  const bmi = await oneVal('ROUND(os.bmi,1)', 'os.bmi > 0');
  const bp  = await oneVal(`CONCAT(ROUND(os.bps),'/',ROUND(os.bpd))`, 'os.bps > 0');

  // โรคประจำตัวจาก ovstdiag (ICD10 ที่พบบ่อยสุด 6 อันดับ)
  const [dr] = await conn.query(
    `SELECT TRIM(ic.name) AS dx, COUNT(*) AS c
       FROM ovstdiag od
       LEFT JOIN icd101 ic ON ic.code = od.icd10
      WHERE od.hn = ? AND ic.name IS NOT NULL
      GROUP BY od.icd10
      ORDER BY c DESC LIMIT 6`, [hn]
  );
  const chronic = dr.map(x => x.dx).filter(Boolean).join(', ') || null;

  // วันนัดครั้งถัดไป — อนาคตที่ใกล้สุดก่อน ถ้าไม่มีอนาคตค่อยเอาอดีตที่ใกล้สุด + คลินิก
  const [ar] = await conn.query(
    `SELECT a.nextdate, a.nexttime, c.name AS clinic
       FROM oapp a LEFT JOIN clinic c ON c.clinic = a.clinic
      WHERE a.hn = ? AND a.nextdate IS NOT NULL
      ORDER BY (a.nextdate >= CURDATE()) DESC, ABS(DATEDIFF(a.nextdate, CURDATE())) ASC
      LIMIT 1`, [hn]
  );
  let next_appt = null, next_appt_at = null;
  if (ar[0]) {
    next_appt_at = isoDate(ar[0].nextdate);
    const t = (ar[0].nexttime || '').toString().slice(0, 5);
    next_appt = `${buddhistDateTime(ar[0].nextdate)}${t ? ' ' + t : ''}${ar[0].clinic ? ' · ' + ar[0].clinic : ''}`;
  }

  return {
    cid,
    fullname: p.fullname || null,
    sex: p.sex || null,
    birthdate: isoDate(p.birthday),
    age: p.age != null ? Number(p.age) : null,
    weight: bw != null ? Number(bw) : null,
    bmi: bmi != null ? Number(bmi) : null,
    bp: bp || null,
    chronic, next_appt, next_appt_at,
  };
}

// ---------- 3) ผลแล็บ NCD (ล่าสุดแต่ละชนิด พร้อมวันที่) ----------
//   FBS/HbA1c อ่านตรงจาก opdscreen (จุดคัดกรอง), eGFR/ไขมัน อ่านจาก lab ตามรหัส lab_items_code
//   รหัส lab_items_code เป็นค่ามาตรฐานของ รพ. นำร่อง — ปรับได้ที่นี่ถ้า รพ. ใช้รหัสต่าง
const LAB_CODES = { egfr: '622', chol: '102', tg: '103', hdl: '91', ldl: '535' };
const LAB_SCAN_VISITS = 25;   // มองหา lab ใน opdscreen ล่าสุดกี่ visit
async function getLabs(conn, cid, hn) {
  const out = [];
  const push = (type, val, unit, dt) => {
    const v = (val == null) ? '' : String(val).trim();
    if (v === '') return;
    out.push({ lab_type: type, lab_value: v, unit: unit || null, lab_date: isoDate(dt) });
  };

  // FBS / HbA1c จาก opdscreen (ค่าล่าสุดที่ > 0)
  const [fbs] = await conn.query(
    `SELECT os.fbs AS v, os.vstdate AS dt FROM opdscreen os
      WHERE os.hn = ? AND os.fbs > 0 ORDER BY os.vstdate DESC LIMIT 1`, [hn]);
  if (fbs[0]) push('FBS', fbs[0].v, 'mg/dL', fbs[0].dt);

  const [hba] = await conn.query(
    `SELECT os.hba1c AS v, os.vstdate AS dt FROM opdscreen os
      WHERE os.hn = ? AND os.hba1c > 0 ORDER BY os.vstdate DESC LIMIT 1`, [hn]);
  if (hba[0]) push('HbA1c', hba[0].v, '%', hba[0].dt);

  // eGFR จาก lab (ตามรหัส) ในช่วง opdscreen ล่าสุด N visit
  const [egfr] = await conn.query(
    `SELECT lo.lab_order_result AS v, v.vstdate AS dt
       FROM (SELECT os.vn, os.vstdate FROM opdscreen os
              WHERE os.hn = ? ORDER BY os.vstdate DESC LIMIT ${LAB_SCAN_VISITS}) v
       JOIN lab_head lh  ON lh.vn = v.vn
       JOIN lab_order lo ON lo.lab_order_number = lh.lab_order_number AND lo.lab_items_code = ?
      WHERE COALESCE(lo.lab_order_result,'') <> ''
      ORDER BY v.vstdate DESC LIMIT 1`, [hn, LAB_CODES.egfr]);
  if (egfr[0]) push('eGFR', egfr[0].v, 'mL/min', egfr[0].dt);

  // ไขมัน (chol/tg/hdl/ldl) — รวมใน visit เดียวกัน เอา visit ล่าสุดที่มี chol
  const [lipid] = await conn.query(
    `SELECT t.dt, t.chol, t.tg, t.hdl, t.ldl FROM (
        SELECT v.vstdate AS dt,
               MAX(CASE WHEN lo.lab_items_code = ? THEN lo.lab_order_result END) AS chol,
               MAX(CASE WHEN lo.lab_items_code = ? THEN lo.lab_order_result END) AS tg,
               MAX(CASE WHEN lo.lab_items_code = ? THEN lo.lab_order_result END) AS hdl,
               MAX(CASE WHEN lo.lab_items_code = ? THEN lo.lab_order_result END) AS ldl
          FROM (SELECT os.vn, os.vstdate FROM opdscreen os
                 WHERE os.hn = ? ORDER BY os.vstdate DESC LIMIT ${LAB_SCAN_VISITS}) v
          JOIN lab_head lh  ON lh.vn = v.vn
          JOIN lab_order lo ON lo.lab_order_number = lh.lab_order_number
                           AND lo.lab_items_code IN (?,?,?,?)
         GROUP BY v.vn, v.vstdate HAVING chol IS NOT NULL
         ORDER BY v.vstdate DESC LIMIT 1
     ) t`,
    [LAB_CODES.chol, LAB_CODES.tg, LAB_CODES.hdl, LAB_CODES.ldl, hn,
     LAB_CODES.chol, LAB_CODES.tg, LAB_CODES.hdl, LAB_CODES.ldl]);
  if (lipid[0]) {
    const L = lipid[0];
    push('Chol', L.chol, 'mg/dL', L.dt);
    push('TG',   L.tg,   'mg/dL', L.dt);
    push('HDL',  L.hdl,  'mg/dL', L.dt);
    push('LDL',  L.ldl,  'mg/dL', L.dt);
  }
  return out;
}

// ---------- 4) ยา OPD (visit ล่าสุดที่มียา) + ประเภท (OPD/ER) + คลินิก ----------
async function getOpdVisits(conn, hn, limit) {
  const n = lim(limit, 5);
  const [rows] = await conn.query(
    `SELECT o.vn AS visit_no, o.vstdate AS visit_date,
            CASE WHEN EXISTS (SELECT 1 FROM er_regist er WHERE er.vn = o.vn) THEN 'ER' ELSE 'OPD' END AS visit_kind,
            ov.main_dep AS clinic_code, kd.department AS clinic_name,
            TRIM(REPLACE(dt.name,'$','')) AS generic, dt.strength AS strength, opr.qty AS qty,
            TRIM(CONCAT_WS(' ', du.name1, du.name2, du.name3)) AS sig_normal,
            ${SP_SPECIAL_SQL} AS sig_special
       FROM (
            SELECT v.vn, v.vstdate
              FROM ovst v
              JOIN opitemrece r ON r.vn = v.vn
              JOIN drugitems d  ON d.icode = r.icode
             WHERE v.hn = ?
             GROUP BY v.vn, v.vstdate
             ORDER BY v.vstdate DESC LIMIT ${n}
       ) o
       JOIN opitemrece opr ON opr.vn = o.vn
       JOIN drugitems dt   ON dt.icode = opr.icode
       JOIN ovst ov        ON ov.vn = o.vn
       LEFT JOIN kskdepartment kd ON kd.depcode = ov.main_dep
       LEFT JOIN drugusage du ON du.drugusage = opr.drugusage
       ${SP_JOIN_SQL}
      ORDER BY o.vstdate DESC, generic`, [hn]
  );
  return groupMeds(rows, 'OPD');
}

// ---------- 5) ยากลับบ้านตอน admit (IPD home med) ----------
async function getIpdHomeMed(conn, hn, limit) {
  const n = lim(limit, 3);
  const [rows] = await conn.query(
    `SELECT i.an AS visit_no, i.regdate AS visit_date,
            TRIM(REPLACE(dt.name,'$','')) AS generic, dt.strength AS strength, opr.qty AS qty,
            TRIM(CONCAT_WS(' ', du.name1, du.name2, du.name3)) AS sig_normal,
            ${SP_SPECIAL_SQL} AS sig_special
       FROM ipt i
       JOIN opitemrece opr ON opr.an = i.an
       JOIN drugitems dt   ON dt.icode = opr.icode
       LEFT JOIN drugusage du ON du.drugusage = opr.drugusage
       ${SP_JOIN_SQL}
       LEFT JOIN ipt_order_no iod ON iod.order_no = opr.order_no
       JOIN (
            SELECT i2.an, MAX(i2.regdate) AS rd
              FROM ipt i2
              JOIN opitemrece o2     ON o2.an = i2.an
              JOIN ipt_order_no iod2 ON iod2.order_no = o2.order_no AND iod2.order_type = 'HMe'
             WHERE i2.hn = ?
             GROUP BY i2.an
             ORDER BY rd DESC LIMIT ${n}
       ) latest ON latest.an = i.an
      WHERE (iod.order_type = 'HMe' OR iod.order_type IS NULL)
      ORDER BY i.regdate DESC, generic`, [hn]
  );
  return groupMeds(rows, 'IPD');
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
