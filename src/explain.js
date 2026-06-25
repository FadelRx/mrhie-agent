// ============================================================================
//  EXPLAIN tool — รัน EXPLAIN ให้ทุกคิวรี่ใน pack (driver + datasets) กับ HOSxP จริง
//  ของแต่ละ รพ. เพื่อดูว่า "ใช้ index หรือวิ่งสแกนทั้งตาราง"
//
//  ใช้:  node src/explain.js                       (ดึง pack จาก Hub/cache)
//        node src/explain.js --pack ../hub/packs/medrecon.json   (อ่าน pack จากไฟล์ ไม่พึ่ง Hub)
//        node src/explain.js --job medrecon        (เฉพาะงาน)
//        node src/explain.js --cid 1234567890123 --hn 999999     (กำหนดค่า bind เอง)
//        node src/explain.js --since 2026-01-01    (กำหนดวัน cutoff ของ driver)
//
//  *** EXPLAIN ไม่ได้รันคิวรี่จริง — ปลอดภัยกับ production/slave ***
//  *** ไม่ดึงข้อมูลคนไข้จริงมาเป็นตัวอย่าง (กัน PII) — ใช้ค่า placeholder เพราะ
//      แผนคิวรี่ (query plan) ไม่ขึ้นกับค่าใน bind อยู่แล้ว ***
//  อ่านผล: คอลัมน์ type = ALL หรือ key = (none) คือ "สแกนทั้งตาราง" = ช้า ควรแก้
// ============================================================================
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const { renderSql, resolveBinds, fetchPacks } = require('./pack');
const { buildContext } = require('./runner');

const PACK_PATH   = process.env.AGENT_PACK   || path.join(__dirname, '..', '.query-pack.json');
const { loadConfig } = require('./config');

function arg(name) { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : null; }

// เก็บทุก SQL ของ pack ออกมาเป็น list: { label, sqlSpec }  (datasets แบบ multi -> แยกเป็นหลายตัว)
function collectQueries(pack) {
  const out = [{ label: 'driver', sqlSpec: pack.driver.sql, bind: pack.driver.bind, scope: 'driver' }];
  for (const ds of pack.datasets || []) {
    const spec = ds.sql;
    const isMulti = Array.isArray(spec) && spec.length > 0 && Array.isArray(spec[0]);
    if (isMulti) spec.forEach((one, i) => out.push({ label: `${ds.name}[${i}]`, sqlSpec: one, bind: ds.bind, scope: ds.scope || 'perKey' }));
    else out.push({ label: ds.name, sqlSpec: spec, bind: ds.bind, scope: ds.scope || 'perKey' });
  }
  return out;
}

// อ่านผล EXPLAIN ของ MySQL/MariaDB แล้วสรุป + ตั้งธงเตือน
function summarizeExplain(rows) {
  const warns = [];
  const lines = rows.map(r => {
    const type = r.type || r.access_type || '?';
    const key  = r.key || '(none)';
    const tbl  = r.table || r.table_name || '?';
    const nrows = r.rows != null ? r.rows : (r['r_rows'] != null ? r['r_rows'] : '?');
    const extra = r.Extra || r.extra || '';
    if (type === 'ALL') warns.push(`ตาราง ${tbl}: type=ALL (สแกนทั้งตาราง — ${nrows} แถว)`);
    else if (key === '(none)' && !['system', 'const', 'NULL'].includes(type)) warns.push(`ตาราง ${tbl}: ไม่ใช้ index (key=none)`);
    if (/Using filesort/i.test(extra)) warns.push(`ตาราง ${tbl}: Using filesort (เรียงผลในหน่วยความจำ)`);
    if (/Using temporary/i.test(extra)) warns.push(`ตาราง ${tbl}: Using temporary (สร้างตารางชั่วคราว)`);
    return `   ${String(tbl).padEnd(16)} type=${String(type).padEnd(7)} key=${String(key).padEnd(18)} rows=${String(nrows).padEnd(9)} ${extra}`;
  });
  return { lines, warns };
}

// อ่าน pack จากไฟล์ local (รองรับ pack เดี่ยว, array, หรือ {packs:[...]})
function loadPackFile(file) {
  const body = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (Array.isArray(body)) return body;
  if (body && Array.isArray(body.packs)) return body.packs;
  return [body];
}

(async () => {
  const cfg = loadConfig();
  const onlyJob = arg('--job');
  const packFile = arg('--pack');
  // ค่า bind ตัวอย่าง: ใช้ placeholder เสมอ (ไม่แตะข้อมูลจริง) — แผนคิวรี่ไม่ขึ้นกับค่านี้
  const sampleCid = arg('--cid') || '0000000000000';
  const sampleHn = arg('--hn') || '0';
  const sinceArg = arg('--since');
  const since = sinceArg || (() => { const d = new Date(); d.setDate(d.getDate() - ((cfg.sync && cfg.sync.sinceDays) || 180)); return d.toISOString().slice(0, 10); })();

  const { packs, source } = packFile
    ? { packs: loadPackFile(packFile), source: `file ${packFile}` }
    : await fetchPacks(cfg, PACK_PATH);
  let jobs = packs;
  if (onlyJob) jobs = jobs.filter(p => (p.job || 'default') === onlyJob);
  console.log(`[explain] ${jobs.length} job(s) (${source}) · since=${since}\n`);

  const conn = await mysql.createConnection({
    host: cfg.hosxp.host, port: cfg.hosxp.port || 3306,
    user: cfg.hosxp.user, password: cfg.hosxp.password,
    database: cfg.hosxp.database, charset: 'utf8', namedPlaceholders: true,
  });

  let totalWarns = 0;
  try {
    for (const pack of jobs) {
      const ctx = buildContext(pack, cfg);

      const prev = { hn: [{ hn: sampleHn }] };   // ให้ bind $hn.hn ใช้ค่า placeholder
      console.log(`=== job: ${pack.job} v${pack.version ?? '?'}  (placeholder cid=${sampleCid}, hn=${sampleHn}) ===`);

      for (const q of collectQueries(pack)) {
        let sql, binds;
        try {
          sql = renderSql(q.sqlSpec, ctx.idents);
          binds = resolveBinds(q.bind, { key: sampleCid, since, cfg: ctx.cfg, prev });
          const [rows] = await conn.query('EXPLAIN ' + sql, binds);
          const { lines, warns } = summarizeExplain(rows);
          const flag = warns.length ? ` ⚠️  ${warns.length}` : ' ✓';
          console.log(`\n • ${q.label}${flag}`);
          lines.forEach(l => console.log(l));
          warns.forEach(w => console.log(`     ⚠️  ${w}`));
          totalWarns += warns.length;
        } catch (e) {
          console.log(`\n • ${q.label}  ✗ EXPLAIN ไม่ผ่าน: ${e.message}`);
        }
      }
      console.log('');
    }
  } finally {
    await conn.end();
  }
  console.log(`[explain] เสร็จ — รวมจุดเตือน ${totalWarns} จุด${totalWarns ? ' (ดู ⚠️ ด้านบน — พิจารณาสร้าง index ตาม docs/query-performance.md)' : ''}`);
})().catch(e => { console.error('[explain] fatal:', e.message); process.exit(1); });
