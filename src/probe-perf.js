// ============================================================================
//  probe-perf — จับเวลา "จริง" ของคิวรี่ราย-คนไข้ (perKey) เพื่อหาตัวที่ช้า
//  EXPLAIN บอกแค่ "ใช้ index มั้ย" แต่ไม่บอก runtime cost ของคนไข้ประวัติยาว
//  สคริปต์นี้รัน driver -> เอา cid จำนวนหนึ่ง -> จับเวลาทุก dataset ต่อคน
//
//  ใช้:  NODE_PATH=node_modules node src/probe-perf.js --limit 25
//        ... --since 2026-06-15        (กำหนด cutoff ของ driver)
//
//  *** PII-safe: พิมพ์เฉพาะ hn (เลขภายใน), เวลา(ms), จำนวนแถว — ไม่พิมพ์ชื่อ/cid/ค่า lab ***
// ============================================================================
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const { renderSql, resolveBinds } = require('./pack');
const { buildContext } = require('./runner');
const { loadConfig } = require('./config');
const PACK_PATH   = process.env.AGENT_PACK   || path.join(__dirname, '..', '..', 'hub', 'packs', 'medrecon.json');

function arg(name, def) { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : def; }
const hr = () => { const t = process.hrtime.bigint(); return () => Number(process.hrtime.bigint() - t) / 1e6; };
const QTIMEOUT = parseInt(arg('--qtimeout', '20000'), 10);   // ตัดคิวรี่ที่ช้าเกิน (ms) ไม่ให้ค้าง
// รันคิวรี่พร้อม timeout — คืน {rows, ms, timedOut}
async function timed(conn, sql, binds) {
  const tt = hr();
  try { const [rows] = await conn.query({ sql, timeout: QTIMEOUT }, binds); return { rows, ms: tt(), timedOut: false }; }
  catch (e) {
    if (/timeout/i.test(e.message) || e.code === 'PROTOCOL_SEQUENCE_TIMEOUT') return { rows: [], ms: tt(), timedOut: true };
    throw e;
  }
}

// แตก dataset เป็นหน่วยจับเวลา (multi-query -> แยกแต่ละ sub-query)
function units(pack) {
  const out = [];
  for (const ds of pack.datasets || []) {
    const spec = ds.sql;
    const multi = Array.isArray(spec) && spec.length && Array.isArray(spec[0]);
    if (multi) spec.forEach((one, i) => out.push({ label: `${ds.name}[${i}]`, spec: one, bind: ds.bind }));
    else out.push({ label: ds.name, spec, bind: ds.bind });
  }
  return out;
}

(async () => {
  const cfg = loadConfig('probe-perf');
  const pack = JSON.parse(fs.readFileSync(PACK_PATH, 'utf8'));
  const ctx = buildContext(pack, cfg);
  const limit = parseInt(arg('--limit', '25'), 10);
  const since = arg('--since') || (() => { const d = new Date(); d.setDate(d.getDate() - ((cfg.sync && cfg.sync.sinceDays) || 1)); return d.toISOString().slice(0, 10); })();

  const conn = await mysql.createConnection({
    host: cfg.hosxp.host, port: cfg.hosxp.port || 3306,
    user: cfg.hosxp.user, password: cfg.hosxp.password,
    database: cfg.hosxp.database, charset: 'utf8', namedPlaceholders: true,
  });

  try {
    // ---- driver ----
    const driverSql = renderSql(pack.driver.sql, ctx.idents);
    const driverBind = resolveBinds(pack.driver.bind, { since, cfg: ctx.cfg });
    let t = hr();
    const [cids] = await conn.query(driverSql, driverBind);
    console.log(`[probe] driver: ${cids.length} cid · ${t().toFixed(0)}ms · since=${since}`);
    const sample = cids.slice(0, limit);
    console.log(`[probe] จับเวลา ${sample.length} คนแรก × ${units(pack).length} คิวรี่/คน\n`);

    const hnDs = (pack.datasets || []).find(d => d.name === 'hn');
    const qs = units(pack).filter(u => u.label !== 'hn');

    const perPatient = [];          // { hn, total, slow:[{label,ms,rows}] }
    const aggByQuery = {};          // label -> { total, max, maxHn, count }

    for (let n = 0; n < sample.length; n++) {
      const cid = sample[n].cid;
      // resolve hn (ไม่นับเป็นภาระหลัก)
      const hnBind = resolveBinds(hnDs.bind, { key: cid, since, cfg: ctx.cfg });
      const [hnRows] = await conn.query(renderSql(hnDs.sql, ctx.idents), hnBind);
      if (!hnRows.length) continue;
      const hn = hnRows[0].hn;
      const prev = { hn: [{ hn }] };

      let ptotal = 0; const slow = [];
      for (const u of qs) {
        const sql = renderSql(u.spec, ctx.idents);
        const binds = resolveBinds(u.bind, { key: cid, since, cfg: ctx.cfg, prev });
        const { rows, ms, timedOut } = await timed(conn, sql, binds);
        ptotal += ms;
        const a = aggByQuery[u.label] || (aggByQuery[u.label] = { total: 0, max: 0, maxHn: null, count: 0, timeouts: 0 });
        a.total += ms; a.count++; if (timedOut) a.timeouts++; if (ms > a.max) { a.max = ms; a.maxHn = hn; }
        if (timedOut) slow.push({ label: u.label, ms, rows: 'TIMEOUT' });
        else if (ms >= 200) slow.push({ label: u.label, ms, rows: rows.length });
      }
      perPatient.push({ hn, total: ptotal, slow });
      const flag = ptotal >= 1000 ? '  🐢' : '';
      process.stdout.write(`  #${String(n + 1).padStart(2)} hn=${String(hn).padEnd(8)} total=${ptotal.toFixed(0).padStart(6)}ms${flag}` +
        (slow.length ? '  ช้า: ' + slow.map(s => `${s.label} ${s.ms.toFixed(0)}ms/${s.rows}r`).join(', ') : '') + '\n');
    }

    // ---- สรุป ----
    console.log('\n=== สรุปตามคิวรี่ (เฉลี่ย/สูงสุดต่อคน) ===');
    Object.entries(aggByQuery).sort((a, b) => b[1].max - a[1].max).forEach(([label, a]) => {
      console.log(`  ${label.padEnd(12)} avg=${(a.total / a.count).toFixed(0).padStart(6)}ms  max=${a.max.toFixed(0).padStart(6)}ms (hn=${a.maxHn})${a.timeouts ? `  ⏱️TIMEOUT×${a.timeouts}` : ''}`);
    });

    const worst = [...perPatient].sort((x, y) => y.total - x.total)[0];
    console.log(`\n=== คนไข้ที่หนักสุด: hn=${worst.hn} รวม ${worst.total.toFixed(0)}ms ===`);

    // ANALYZE FORMAT=JSON คิวรี่ที่ช้าสุดของคนหนักสุด เพื่อชี้ตารางที่กิน rows
    if (worst.slow.length) {
      const top = worst.slow.sort((a, b) => b.ms - a.ms)[0];
      const u = qs.find(q => q.label === top.label);
      const hnBind = resolveBinds(hnDs.bind, { key: '', since, cfg: ctx.cfg });
      const [hnRows] = await conn.query(`SELECT hn FROM ${ctx.idents.patient} WHERE hn = ? LIMIT 1`, [worst.hn]);
      const prev = { hn: [{ hn: worst.hn }] };
      const sql = renderSql(u.spec, ctx.idents);
      const binds = resolveBinds(u.bind, { key: '', since, cfg: ctx.cfg, prev });
      console.log(`\n--- ANALYZE ${top.label} (hn=${worst.hn}) ---`);
      try {
        const [a] = await conn.query('ANALYZE FORMAT=JSON ' + sql, binds);
        const j = JSON.parse(a[0]['ANALYZE'] || a[0]['analyze'] || '{}');
        const walk = (node, depth) => {
          if (!node || typeof node !== 'object') return;
          if (node.table) {
            const tn = node.table.table_name;
            const acc = node.table.access_type;
            const key = node.table.key || '(none)';
            const rr = node.table.r_rows != null ? node.table.r_rows : '?';
            const rt = node.table.r_total_time_ms != null ? node.table.r_total_time_ms : '?';
            console.log(`   ${'  '.repeat(depth)}${String(tn).padEnd(16)} ${String(acc).padEnd(8)} key=${String(key).padEnd(16)} r_rows=${rr} r_time=${rt}ms`);
          }
          for (const k of Object.keys(node)) walk(node[k], depth + (node.table ? 1 : 0));
        };
        walk(j.query_block, 0);
      } catch (e) { console.log('   (ANALYZE ไม่ได้: ' + e.message + ')'); }
    }
  } finally {
    await conn.end();
  }
})().catch(e => { console.error('[probe] fatal:', e.message); process.exit(1); });
